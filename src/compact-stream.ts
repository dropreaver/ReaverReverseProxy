import { compactJson } from "./compact-response.ts";
import { hasProviderUsage, isProviderFailure } from "./provider-outcome.ts";
import { compactUsage } from "./token-usage.ts";

type Fields = Record<string, unknown>;
type Frame = { name: string; data: string };

function record(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

function fields(value: Fields, names: string[]): Fields {
  return Object.fromEntries(names.filter(name => value[name] === null ||
    ["string", "number", "boolean"].includes(typeof value[name])).map(name => [name, value[name]]));
}

function mergeCounters(counters: Fields, usage: unknown, names: string[]) {
  const source = record(usage);
  for (const key of names) {
    const current = source[key];
    if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0) counters[key] = current;
  }
}

// Handle CR, LF and CRLF, including UTF-8 code points and line endings split across reads.
function frameReader() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let fragments: string[] = [];
  let trailingCR = false;
  let frameBytes = 0;
  let name = "";
  let data: string[] = [];
  function append(piece: string) {
    frameBytes += Buffer.byteLength(piece);
    if (frameBytes > 64 * 1024 * 1024) throw new Error("The provider SSE event is too large.");
    if (piece) fragments.push(piece);
  }
  function* split(chunk: string) {
    if (!chunk) return;
    let start = trailingCR && chunk[0] === "\n" ? 1 : 0;
    trailingCR = chunk.endsWith("\r");
    const endings = /\r\n|[\r\n]/g;
    endings.lastIndex = start;
    for (const end of chunk.matchAll(endings)) {
      append(chunk.slice(start, end.index));
      frameBytes += end[0].length;
      if (fragments.length === 0) frameBytes = 0;
      yield fragments.join("");
      fragments = [];
      start = end.index + end[0].length;
    }
    if (start < chunk.length) append(chunk.slice(start));
  }
  function* lines(bytes?: Uint8Array) {
    yield* split(bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }));
    if (bytes === undefined && fragments.length) yield fragments.join("");
  }
  return function* frames(bytes?: Uint8Array): Generator<Frame | null> {
    for (const line of lines(bytes)) {
      if (!line) {
        if (data.length) yield { name, data: data.join("\n") };
        name = "";
        data = [];
      } else if (line.startsWith(":")) {
        yield null;
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("event:")) {
        name = line.slice(6).trim();
      }
    }
    if (bytes === undefined && data.length) yield { name, data: data.join("\n") };
  };
}

// Only a failed upstream read is reported as an error. Closing the consumer's iterator
// (e.g. the client disconnected) releases the source without reporting an error.
async function* streamChunks(source: AsyncIterable<Uint8Array>, onError: () => void, onInterrupted: () => void) {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  try {
    while (!done) {
      const next = await iterator.next().catch(error => {
        if (error?.code !== "ABORT_ERR" && error?.name !== "AbortError") onError();
        throw error;
      });
      done = !!next.done;
      yield next.done ? undefined : next.value;
    }
  } finally {
    if (!done) {
      onInterrupted();
      await iterator.return?.();
    }
  }
}

function providerEvents(path: string, onError?: (payload?: unknown) => void, onUsage?: () => void,
  onMeter?: (payload: unknown) => void) {
  const frames = frameReader();
  let terminal = false;
  let sawDone = false;
  let failed = false;
  let usageObserved = false;
  function fail(payload?: unknown) {
    if (!failed || payload !== undefined) onError?.(payload);
    failed = true;
  }
  function parseEvent(frame: Frame): Fields | undefined {
    let event: unknown;
    try { event = JSON.parse(frame.data); } catch { return; }
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    const e = event as Fields;
    if (e.type === undefined && frame.name) e.type = frame.name;
    const namedEvent = frame.name && frame.name !== e.type ? { ...e, type: frame.name } : undefined;
    const failureEvent = [e, namedEvent].find(isProviderFailure);
    if (failureEvent) {
      fail(failureEvent);
      terminal = true;
    }
    // Observe the original event before projection can hide reasoning or tool output.
    onMeter?.(e);
    if (onUsage && !usageObserved && (hasProviderUsage(e, path) ||
        (namedEvent && hasProviderUsage(namedEvent, path)))) {
      usageObserved = true;
      onUsage();
    }
    return e;
  }
  function inspectRemaining(remaining: Iterable<Frame | null>) {
    if ((!onMeter && !onError && (!onUsage || usageObserved)) || sawDone) return;
    try {
      for (const frame of remaining) {
        if (!frame) continue;
        if (frame.data === "[DONE]") { sawDone = true; break; }
        parseEvent(frame);
        if (usageObserved && !onError && !onMeter) break;
      }
    } catch { /* An incomplete or invalid record cannot establish further usage. */ }
  }
  function* read(bytes?: Uint8Array, tolerateMalformed = false): Generator<Fields | null | "[DONE]"> {
    if (sawDone) return;
    const remaining = frames(bytes);
    try {
      for (let next = remaining.next(); !next.done; next = remaining.next()) {
        const frame = next.value;
        if (!frame) { yield null; continue; }
        if (frame.data === "[DONE]") {
          sawDone = true;
          if (path !== "/v1/chat/completions" && !terminal) throw new Error("The provider stream ended before its terminal event.");
          terminal = true;
          yield "[DONE]";
          return;
        }
        const e = parseEvent(frame);
        if (!e) {
          fail();
          if (tolerateMalformed) continue;
          throw new Error("The provider returned a malformed SSE event.");
        }
        if ((path === "/v1/responses" && (e.type === "response.completed" || e.type === "response.incomplete")) ||
                   (path === "/v1/messages" && e.type === "message_stop")) {
          terminal = true;
        }
        yield e;
      }
      if (bytes === undefined && !terminal) throw new Error("The provider stream ended before its terminal event.");
    } catch (error) {
      fail();
      throw error;
    } finally {
      // The client can stop after one projected event from a multi-event chunk.
      inspectRemaining(remaining);
    }
  }
  return { read, fail, finishInterrupted: () => inspectRemaining(frames()), get failed() { return failed; } };
}

export async function* observeNativeStream(
  source: AsyncIterable<Uint8Array>, path: string, onError?: (payload?: unknown) => void, onUsage?: () => void,
  onMeter?: (payload: unknown) => void,
): AsyncGenerator<Uint8Array> {
  const events = providerEvents(path, onError, onUsage, onMeter);
  let canReadFrames = true;
  for await (const bytes of streamChunks(source, events.fail, events.finishInterrupted)) {
    if (canReadFrames) {
      try {
        // A usage frame can follow an error. Keep observing the original stream.
        for (const _event of events.read(bytes, true)) { /* Forward bytes below. */ }
      } catch { canReadFrames = false; }
    }
    if (bytes !== undefined) yield bytes;
  }
}

class VisibleIndices {
  visible = new Map<unknown, number>();
  hidden = new Set<unknown>();
  map(index: unknown): number | undefined {
    if (index === undefined) return undefined;
    if (!this.visible.has(index)) this.visible.set(index, this.visible.size);
    return this.visible.get(index);
  }
}

function errorFields(value: unknown): Fields {
  return fields(record(value), ["type", "code", "message", "param"]);
}

function isTextPart(part: Fields): boolean {
  return part.type === "output_text" || part.type === "refusal";
}

function textPart(part: Fields): Fields {
  return fields(part, part.type === "refusal" ? ["type", "refusal"] : ["type", "text"]);
}

function responsesProjector(path: string, params: Fields) {
  const indices = new VisibleIndices();
  const hiddenIds = new Set<unknown>();
  const declaredIds = new Map<unknown, unknown>();
  const declaredIndices = new Set<unknown>();
  const parts = new Map<unknown, VisibleIndices>();
  let sentParams = false;
  let sequence = 0;

  return (e: Fields): Fields | undefined => {
    const type = e.type;
    if (typeof type !== "string") return;
    let out: Fields;
    if (["error", "response.error"].includes(type)) {
      out = fields(e, ["type", "code", "message", "param"]);
      if (e.error !== undefined) out.error = errorFields(e.error);
    } else if (["response.created", "response.queued", "response.in_progress", "response.completed",
      "response.incomplete", "response.failed", "response.cancelled", "response.canceled"].includes(type)) {
      const response = record(compactJson(path, e.response, params));
      if (["response.created", "response.queued", "response.in_progress"].includes(type)) {
        delete response.usage;
      }
      if (sentParams) delete response.parameters;
      sentParams = true;
      out = { type, response };
      if (e.error !== undefined) out.error = errorFields(e.error);
    } else {
      const item = record(e.item);
      const id = item.id ?? e.item_id;
      const index = e.output_index ?? declaredIds.get(id);
      const itemKey = index ?? id;
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        if (item.type !== "message" || (item.role != null && item.role !== "assistant") ||
            (item.phase != null && item.phase !== "final_answer")) {
          if (index !== undefined) indices.hidden.add(index);
          if (id !== undefined) hiddenIds.add(id);
          return;
        }
        if (index !== undefined) declaredIndices.add(index);
        if (id !== undefined) declaredIds.set(id, index);
      } else {
        // A resumed stream may begin within a commentary or reasoning item.
        // Its typed terminal snapshot can still deliver the final assistant answer.
        if (id === undefined && index === undefined) return;
        if (id !== undefined && !declaredIds.has(id)) return;
        if (index !== undefined && !declaredIndices.has(index)) return;
        if (id !== undefined && index !== undefined && declaredIds.get(id) !== index) return;
      }
      if (indices.hidden.has(index) || hiddenIds.has(id)) return;
      let partIndices = parts.get(itemKey);
      if (!partIndices) { partIndices = new VisibleIndices(); parts.set(itemKey, partIndices); }
      const part = record(e.part);
      const partIndex = e.content_index;
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const content = Array.isArray(item.content) ? item.content : [];
        out = { type, item: { ...fields(item, ["id", "type", "role", "phase", "status"]),
          content: content.map(record).filter(isTextPart).map(textPart) } };
      } else if (type === "response.content_part.added" || type === "response.content_part.done") {
        if (!isTextPart(part)) { partIndices.hidden.add(partIndex); return; }
        out = { type, part: textPart(part) };
      } else if (["response.output_text.delta", "response.refusal.delta",
        "response.output_text.done", "response.refusal.done"].includes(type)) {
        if (partIndices.hidden.has(partIndex)) return;
        out = { type, ...fields(e, ["delta", "text", "refusal"]) };
      } else {
        return;
      }
      out.output_index = indices.map(index);
      out.content_index = partIndices.map(partIndex);
      if (e.item_id !== undefined) out.item_id = e.item_id;
    }
    if (typeof e.sequence_number === "number") out.sequence_number = sequence++;
    return out;
  };
}

function messagesProjector(path: string, params: Fields) {
  const indices = new VisibleIndices();
  const counters: Fields = {};
  const inputCounters = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  let pendingDelta: Fields | undefined;
  let stopped = false;
  return (e: Fields): Fields | Fields[] | undefined => {
    const type = e.type;
    switch (type) {
      case "message_start": {
        const raw = record(e.message);
        // The opening output count covers only the in-progress message.
        mergeCounters(counters, raw.usage, inputCounters);
        const message = record(compactJson(path, raw, params));
        delete message.usage;
        return { type, message };
      }
      case "content_block_start": {
        const block = record(e.content_block);
        if (block.type !== "text") { indices.hidden.add(e.index); return; }
        return { type, index: indices.map(e.index), content_block: fields(block, ["type", "text"]) };
      }
      case "content_block_delta": {
        const delta = record(e.delta);
        if (indices.hidden.has(e.index) || delta.type !== "text_delta") return;
        return { type, index: indices.map(e.index), delta: fields(delta, ["type", "text"]) };
      }
      case "content_block_stop":
        if (indices.hidden.has(e.index)) return;
        return { type, index: indices.map(e.index) };
      case "message_delta": {
        const delta = record(e.delta);
        mergeCounters(counters, e.usage, [...inputCounters, "output_tokens"]);
        const stop = fields(delta, ["stop_reason", "stop_sequence"]);
        if (delta.stop_details !== undefined) {
          stop.stop_details = delta.stop_details === null ? null :
            fields(record(delta.stop_details), ["type", "category", "explanation"]);
        }
        // Usage updates are cumulative. Keep the last delta for its final
        // counters, forwarding any earlier status event without provisional totals.
        const previous = pendingDelta;
        pendingDelta = { type, delta: stop };
        return previous;
      }
      case "message_stop": {
        if (stopped) return;
        stopped = true;
        mergeCounters(counters, e.usage, [...inputCounters, "output_tokens"]);
        const finalDelta = pendingDelta ?? { type: "message_delta", delta: {} };
        pendingDelta = undefined;
        return [{ ...finalDelta, usage: compactUsage(path, counters) }, { type }];
      }
      case "ping": return { type };
      case "error": {
        stopped = true;
        const error = { type, error: errorFields(e.error) };
        const previous = pendingDelta;
        pendingDelta = undefined;
        return previous ? [previous, error] : error;
      }
    }
  };
}

function chatProjector(path: string, params: Fields) {
  let started = false;
  const hiddenChoices = new Set<unknown>();
  const envelope: Fields = {};
  const envelopeKeys = ["model", "id", "object", "created"];
  const counters: Fields = {};
  function project(e: Fields): Fields | undefined {
    if (e.error != null) return { error: errorFields(e.error) };
    if (!Array.isArray(e.choices)) return;
    Object.assign(envelope, fields(e, envelopeKeys));
    mergeCounters(counters, e.usage, ["prompt_tokens", "completion_tokens", "total_tokens"]);
    const choices: Fields[] = [];
    for (const [i, value] of e.choices.entries()) {
      const choice = record(value);
      const index = choice.index ?? i;
      const raw = record(choice.delta);
      const phase = raw.phase ?? choice.phase ?? e.phase;
      if (phase != null) {
        if (phase === "final_answer") hiddenChoices.delete(index);
        else hiddenChoices.add(index);
      }
      const delta: Fields = {};
      if (!hiddenChoices.has(index) && (raw.role == null || raw.role === "assistant")) {
        if (raw.role === "assistant") delta.role = raw.role;
        if (typeof raw.content === "string" && raw.content) delta.content = raw.content;
        if (Array.isArray(raw.content)) {
          const parts = raw.content.map(record);
          const text = parts.filter(p => p.type === "text" && typeof p.text === "string").map(p => p.text).join("");
          const refusal = parts.filter(p => p.type === "refusal" && typeof p.refusal === "string").map(p => p.refusal).join("");
          if (text) delta.content = text;
          if (refusal) delta.refusal = refusal;
        }
        if (typeof raw.refusal === "string" && raw.refusal) delta.refusal = raw.refusal;
      }
      if (!Object.keys(delta).length && choice.finish_reason == null) continue;
      choices.push({ index, delta, ...fields(choice, ["finish_reason"]) });
    }
    if (!choices.length) return;
    if (!started) {
      started = true;
      return { ...fields(envelope, envelopeKeys), choices, parameters: params };
    }
    return { choices };
  }
  function summary(): Fields {
    return { ...fields(envelope, envelopeKeys), choices: [], usage: compactUsage(path, counters) };
  }
  return { project, summary };
}

export async function* compactStream(
  source: AsyncIterable<Uint8Array>, path: string, params: Fields, onError?: (payload?: unknown) => void, onUsage?: () => void,
  onMeter?: (payload: unknown) => void,
): AsyncGenerator<string> {
  const chat = path === "/v1/chat/completions" ? chatProjector(path, params) : undefined;
  const project = chat?.project ?? (path === "/v1/messages" ? messagesProjector(path, params) : responsesProjector(path, params));
  const events = providerEvents(path, onError, onUsage, onMeter);
  let lastWrite = Date.now();
  for await (const bytes of streamChunks(source, events.fail, events.finishInterrupted)) {
    for (const frame of events.read(bytes)) {
      if (frame === "[DONE]") {
        if (chat && !events.failed) yield `data: ${JSON.stringify(chat.summary())}\n\n`;
        yield "data: [DONE]\n\n";
        return;
      }
      let projected: Fields | Fields[] | undefined;
      try { projected = frame ? project(frame) : undefined; }
      catch (error) { events.fail(); throw error; }
      if (!projected) {
        if (Date.now() - lastWrite >= 15_000) {
          lastWrite = Date.now();
          yield ": keep-alive\n\n";
        }
        continue;
      }
      for (const event of Array.isArray(projected) ? projected : [projected]) {
        const name = typeof event.type === "string" ? `event: ${event.type}\n` : "";
        lastWrite = Date.now();
        yield `${name}data: ${JSON.stringify(event)}\n\n`;
      }
    }
  }
}

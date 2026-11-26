import { hasMeteredUsage, hasProviderUsage, isProviderFailure } from "./provider-outcome.ts";

const smallBodyLimit = 256 * 1024;

// Native replies can contain much more data than an in-memory JSON parse can
// accommodate. Validate incrementally and retain a bounded view of provider metadata.
type Phase = "root" | "firstKey" | "key" | "colon" | "firstItem" | "value" | "afterValue" | "end";
type Metadata = Record<string, unknown>;
type Projection = Metadata | unknown[];
type Container = {
  kind: string; fields?: Projection; key?: string; group?: string; hasWitness?: boolean;
  iterationBuckets?: Map<string, number>;
};
const atomSyntax = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const whitespace = " \r\n\t";
const projectedKeys = new Set([
  "error", "status", "object", "type", "role", "response", "message", "model", "usage", "stop_reason",
  "input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens",
  "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "input_tokens_details",
  "output_tokens_details", "prompt_tokens_details", "completion_tokens_details", "server_tool_use", "iterations",
  "output", "output_text", "choices", "delta", "content", "text", "refusal", "thinking", "reasoning",
  "reasoning_content", "data", "signature", "encrypted_content", "arguments", "name", "summary",
  "tool_calls", "function_call", "function", "custom", "audio", "transcript",
  "content_block", "partial_json", "item", "part", "code", "details", "error_code",
]);
const tokenDetails = new Set(["cache_creation", "input_tokens_details", "output_tokens_details",
  "prompt_tokens_details", "completion_tokens_details"]);
const generatedStrings = new Set(["output_text", "text", "refusal", "thinking", "reasoning", "reasoning_content",
  "data", "signature", "encrypted_content", "arguments", "name", "content", "input", "transcript"]);

const iterationCounts = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

// A native Claude reply can contain many billed iterations. Compact finished
// records with matching counter shapes, preserving missing and invalid values.
function foldPreviousIteration(container: Container, rows: unknown[]) {
  if (!rows.length) return;
  const row = rows.pop();
  const item = row && typeof row === "object" && !Array.isArray(row) ? row as Metadata : {};
  const kind = typeof item.type === "string" && ["message", "compaction", "fallback_message"].includes(item.type)
    ? item.type : "unknown";
  const shape = iterationCounts.map(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0
    ? "count" : Object.hasOwn(item, key) ? "invalid" : "missing");
  const signature = [kind, ...shape, hasMeteredUsage(item)].join("/");
  const buckets = container.iterationBuckets ??= new Map();
  const index = buckets.get(signature);
  if (index === undefined) {
    buckets.set(signature, rows.length);
    rows.push(row);
    return;
  }
  const total = rows[index] as Metadata;
  for (const [i, key] of iterationCounts.entries()) {
    if (shape[i] === "count") total[key] = Number(total[key]) + Number(item[key]);
  }
  if (kind === "fallback_message" && typeof item.model === "string") total.model = item.model;
}

function containsUsageWitness(group: string | undefined, items: unknown[]): boolean {
  // Enclosing type and role fields can appear after the array. Keep an item
  // that can establish usage, then apply the enclosing fields after parsing.
  switch (group) {
    case "content": case "summary": return hasProviderUsage({ role: "assistant", content: items });
    case "choices": return hasProviderUsage({ choices: items });
    case "output": return hasProviderUsage({ output: items });
    case "tool_calls": return hasProviderUsage({ choices: [{ message: { tool_calls: items } }] });
    default: return false;
  }
}

class LargeEnvelope {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private containers: Container[] = [];
  private phase: Phase = "root";
  private quoted = false;
  private stringHasData = false;
  private escaped = false;
  private hexRemaining = 0;
  private raw?: string;
  private atom = "";
  private numericLexeme = "";
  private digits = 0;
  private fields: Metadata = {};
  private invalid = false;
  private readonly route?: string;

  constructor(route?: string) { this.route = route; }

  private projectedKey(container: Container, name: unknown): string | undefined {
    if (typeof name !== "string") return;
    if (tokenDetails.has(container.group ?? "") && name.endsWith("_tokens")) return "reported_tokens";
    if (container.group === "server_tool_use" && name.endsWith("_requests")) return "reported_requests";
    // Arbitrary JSON under input, metadata, request tools or tool result values is opaque.
    if (projectedKeys.has(name)) return name;
    if (name === "input" && this.containers.length > 1) return name;
  }

  private projectValue(kind: string, value: unknown, parent?: Container): Projection | undefined {
    if (!parent) return this.fields;
    if (!parent.fields || this.containers.length > 9) return;
    const key = parent.key;
    if (!Array.isArray(parent.fields) && key === undefined) return;
    const child: Projection | undefined = kind === "{" ? Object.create(null) : kind === "[" ? [] : undefined;
    const projected = child ?? value;
    if (Array.isArray(parent.fields)) {
      if (parent.group === "iterations") {
        foldPreviousIteration(parent, parent.fields);
        parent.fields.push(projected);
        return child;
      }
      // A later enclosing role/type can still qualify the item, so keep a candidate
      // with usage evidence plus the current item as the next element arrives.
      if (parent.fields.length && !parent.hasWitness && containsUsageWitness(parent.group, parent.fields)) parent.hasWitness = true;
      parent.fields[parent.hasWitness ? 1 : 0] = projected;
    } else if (key !== undefined) {
      if ((key === "reported_tokens" || key === "reported_requests") && typeof projected === "number") {
        // Detail buckets can contain several token types or tools.
        const prior = parent.fields[key];
        if (typeof prior !== "number" || !(prior > 0 && Number.isSafeInteger(prior))) parent.fields[key] = projected;
      } else parent.fields[key] = projected;
      if (key === "input") return; // Keep the tool call's envelope and omit its arguments.
    }
    return child;
  }

  private token(kind: string, value: unknown = true) {
    const container = this.containers.at(-1);
    if (kind === "}" || kind === "]") {
      const matches = container?.kind === (kind === "}" ? "{" : "[");
      const empty = this.phase === (kind === "}" ? "firstKey" : "firstItem");
      if (!matches || !(empty || this.phase === "afterValue")) { this.invalid = true; return; }
      this.containers.pop();
      this.phase = this.containers.length ? "afterValue" : "end";
    } else if (kind === ",") {
      if (this.phase !== "afterValue") { this.invalid = true; return; }
      this.phase = container?.kind === "{" ? "key" : "value";
    } else if (kind === ":") {
      if (this.phase !== "colon") { this.invalid = true; return; }
      this.phase = "value";
    } else if (kind === "string" && (this.phase === "key" || this.phase === "firstKey")) {
      if (container?.fields) container.key = this.projectedKey(container, value);
      this.phase = "colon";
    } else {
      const root = this.phase === "root" && kind === "{";
      if (!root && this.phase !== "firstItem" && this.phase !== "value") { this.invalid = true; return; }
      const fields = this.projectValue(kind, value, container);
      if (kind === "{" || kind === "[") {
        this.containers.push({ kind, fields, group: container?.key });
        this.phase = kind === "{" ? "firstKey" : "firstItem";
      } else this.phase = "afterValue";
    }
  }

  private stringCharacter(ch: string) {
    if (this.hexRemaining) {
      if (!/[0-9a-f]/i.test(ch)) this.invalid = true;
      this.hexRemaining--;
    } else if (this.escaped) {
      if (ch === "u") this.hexRemaining = 4;
      else if (!'"\\/bfnrt'.includes(ch)) this.invalid = true;
      this.escaped = false;
    } else if (ch === "\\") {
      this.escaped = true;
    } else if (ch === '"') {
      this.quoted = false;
      this.token("string", this.raw === undefined ? "…" : JSON.parse(this.raw + '"'));
      return;
    } else if (ch < " ") this.invalid = true;
    this.stringHasData = true;
    if (this.raw !== undefined) {
      const parent = this.containers.at(-1);
      const maxLength = parent?.group === "error" && parent.key === "message" ? 2048 : parent?.key === "model" ? 961 : 128;
      this.raw = this.raw.length < maxLength ? this.raw + ch : undefined;
    }
  }

  private finishAtom() {
    if (!this.atom) return;
    if (atomSyntax.test(this.atom)) {
      const value = this.atom === "null" ? null : this.atom === "true" ? true : this.atom === "false" ? false
        : this.numericLexeme.length > 64 ? NaN : Number(this.numericLexeme);
      this.token("atom", value);
    }
    else this.invalid = true;
    this.atom = "";
    this.numericLexeme = "";
    this.digits = 0;
  }

  write(bytes: Uint8Array) {
    if (this.invalid) return;
    let text;
    try { text = this.decoder.decode(bytes, { stream: true }); }
    catch { this.invalid = true; return; }
    for (const ch of text) {
      if (this.invalid) break;
      if (this.quoted) {
        this.stringCharacter(ch);
      } else if ('{}[]:,"'.includes(ch) || whitespace.includes(ch)) {
        this.finishAtom();
        if (ch === '"') {
          this.quoted = true;
          this.stringHasData = false;
          const key = this.phase === "firstKey" || this.phase === "key";
          const container = this.containers.at(-1);
          this.raw = container?.fields && (key || container.key !== undefined || Array.isArray(container.fields)) ? '"' : undefined;
        } else if (!whitespace.includes(ch)) this.token(ch);
      } else {
        // Number syntax depends on a digit run's first two digits (e.g. 0 versus
        // 01). Longer runs have identical syntax, even in enormous exponents.
        this.digits = ch >= "0" && ch <= "9" ? this.digits + 1 : 0;
        if (this.numericLexeme.length <= 64) this.numericLexeme += ch;
        if (this.digits <= 2) this.atom += ch;
        if (this.atom.length > 12) this.invalid = true;
      }
    }
  }

  completed(): Metadata | undefined {
    try { this.decoder.decode(); }
    catch { return; }
    if (!this.invalid && !this.quoted && !this.atom && this.phase === "end") return this.fields;
  }

  partial() {
    // Only delimited numeric literals have a known value. The usage witness
    // below may still recognize the first digits of a cut-off positive count.
    return structuredClone(this.fields);
  }

  metered() {
    this.finishAtom();
    const container = this.containers.at(-1);
    if (this.quoted && this.stringHasData && this.phase === "value" && generatedStrings.has(container?.key ?? "")) {
      this.projectValue("string", "…", container);
    }
    return hasProviderUsage(this.fields, this.route);
  }
}

export async function* observeNativeJson(
  source: AsyncIterable<Uint8Array>, onError?: (payload?: unknown) => void, expectedLength?: number,
  onUsage?: () => void, path?: string, onMeter?: (payload: unknown, partial?: boolean) => void,
): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let large: LargeEnvelope | undefined;
  let checked = false;
  let sourceSettled = false;
  function projectBuffered() {
    if (!large) {
      large = new LargeEnvelope(path);
      for (const prior of chunks) large.write(prior);
      chunks.length = 0;
    }
    return large;
  }
  function observePartialUsage() {
    if (onMeter) onMeter(projectBuffered().partial(), true);
    if (onUsage && projectBuffered().metered()) onUsage();
  }
  function check() {
    if (checked) return;
    checked = true;
    let body;
    if (large) {
      body = large.completed();
      if (!body) { observePartialUsage(); onError?.(); return; }
    } else {
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
      catch { observePartialUsage(); onError?.(); return; }
    }
    onMeter?.(body);
    if (onUsage && hasProviderUsage(body, path)) onUsage();
    if (!body || typeof body !== "object" || Array.isArray(body) || isProviderFailure(body)) onError?.(body);
  }
  if (expectedLength === 0) check();
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (!large && size > smallBodyLimit) {
        projectBuffered();
      }
      if (large) large.write(chunk);
      else if (chunk.length) chunks.push(chunk);
      // With Content-Length a client can retry as soon as it receives this chunk.
      if (size === expectedLength) check();
      yield chunk;
    }
    sourceSettled = true;
  } catch (error) {
    sourceSettled = true;
    if (!checked) observePartialUsage();
    onError?.();
    throw error;
  } finally {
    // The downstream consumer may close its iterator before the provider's EOF.
    if (!sourceSettled && !checked) observePartialUsage();
  }
  if (expectedLength !== undefined && Number.isFinite(expectedLength) && expectedLength !== size) {
    if (!checked) observePartialUsage();
    onError?.();
  }
  else check();
}

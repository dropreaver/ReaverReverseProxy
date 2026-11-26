import { compactUsage } from './token-usage.ts';

type Fields = Record<string, unknown>;
type Counts = ReturnType<typeof compactUsage>;
export type MeterSnapshot = Counts & { model?: string; complete: boolean };

const messages = '/v1/messages';
const chat = '/v1/chat/completions';
const responses = '/v1/responses';
const ongoing = new Set(['queued', 'in_progress']);
const lifecycle = new Set(['created', 'queued', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled', 'canceled']);
const counterNames = ['input_tokens', 'output_tokens', 'total_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

function record(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeModelId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(value) &&
      !/^(?:sk|rk|api[_-]key)[_-]/i.test(value)) return value;
}

function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function add(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  const sum = (left ?? 0) + right;
  return valid(sum) ? sum : null;
}

function messageCounts(raw: Fields) {
  const counts = compactUsage(messages, raw);
  if (counts.input_tokens === null && !valid(raw.input_tokens)) {
    // An incomplete envelope may report only the cache-read or cache-write
    // portion. Preserve that known input as a lower bound.
    const cached = [raw.cache_read_input_tokens, raw.cache_creation_input_tokens].filter(valid);
    const input = cached.reduce((sum, value) => sum + value, 0);
    if (cached.length && valid(input)) {
      counts.input_tokens = input;
      if (counts.total_tokens === null && counts.output_tokens !== null) counts.total_tokens = add(input, counts.output_tokens);
    }
  }
  return counts;
}

// A Claude compaction iteration is billed separately from the top-level usage.
// When an iteration list is present it covers the whole call, including the
// ordinary message. Never add both that list and the top-level counters.
function iterationUsage(iterations: unknown[]) {
  let input: number | null = null;
  let output: number | null = null;
  let compactionInput = 0;
  let compactionOutput = 0;
  let complete = true;
  let model: string | undefined;
  for (const item of iterations) {
    if (!record(item)) { complete = false; continue; }
    const counts = messageCounts(item);
    if (counts.input_tokens !== null) input = (input ?? 0) + counts.input_tokens;
    if (counts.output_tokens !== null) output = (output ?? 0) + counts.output_tokens;
    if (!valid(item.input_tokens) || counts.input_tokens === null || counts.output_tokens === null) complete = false;
    if (item.type === 'compaction') {
      compactionInput += counts.input_tokens ?? 0;
      compactionOutput += counts.output_tokens ?? 0;
    }
    if (item.type === 'fallback_message') model = safeModelId(item.model) ?? model;
  }
  return { input: valid(input) ? input : null, output: valid(output) ? output : null,
    compactionInput, compactionOutput, complete, model };
}

export class GenerationMeter {
  #path: string;
  #model?: string;
  #counters: Fields = {};
  #iterations?: ReturnType<typeof iterationUsage>;
  #final = false;
  #claudeDeltaOutput = false;

  constructor(path: string) { this.#path = path; }

  // Snapshots can repeat or report only counters that changed. Keep the most
  // recent provider value for each dimension, then count the generation once.
  #update(raw: unknown): boolean {
    if (!record(raw)) return false;
    const source: Fields = this.#path === chat ? {
      input_tokens: raw.prompt_tokens ?? raw.input_tokens,
      output_tokens: raw.completion_tokens ?? raw.output_tokens, total_tokens: raw.total_tokens,
    } : raw;
    for (const name of counterNames) {
      const value = source[name];
      if (!valid(value)) continue;
      if (name !== 'total_tokens' && this.#counters[name] !== value && !valid(source.total_tokens)) {
        delete this.#counters.total_tokens;
      }
      this.#counters[name] = value;
    }
    if (this.#path === messages && Array.isArray(raw.iterations) && raw.iterations.length > 0) {
      this.#iterations = iterationUsage(raw.iterations);
      this.#model = this.#iterations.model ?? this.#model;
      return this.#iterations.output !== null;
    }
    // Subsequent cumulative Claude deltas may only update one dimension.
    if (this.#iterations) {
      const counts = messageCounts(this.#counters);
      if (valid(source.input_tokens) && counts.input_tokens !== null)
        this.#iterations.input = add(counts.input_tokens, this.#iterations.compactionInput);
      if (valid(source.output_tokens))
        this.#iterations.output = add(source.output_tokens, this.#iterations.compactionOutput);
    }
    return valid(source.output_tokens);
  }

  observe(payload: unknown, partial = false): void {
    if (!record(payload)) return;
    let body = payload;
    let final = !partial;
    if (this.#path === messages) {
      switch (body.type) {
        case 'message_start':
          if (!record(body.message)) return;
          body = body.message;
          final = false;
          break;
        case 'message_delta':
          if (this.#update(body.usage)) this.#claudeDeltaOutput = true;
          if (!partial && this.#claudeDeltaOutput && record(body.delta) && body.delta.stop_reason != null) this.#final = true;
          return;
        case 'message_stop':
          if ((this.#update(body.usage) || this.#claudeDeltaOutput) && !partial) this.#final = true;
          return;
        case 'content_block_start': {
          const block = body.content_block;
          if (record(block) && block.type === 'fallback' && record(block.to)) {
            this.#model = safeModelId(block.to.model) ?? this.#model;
          }
          return;
        }
        case 'message': case 'error': case undefined: break;
        default: return;
      }
    } else if (this.#path === responses) {
      if (typeof body.type === 'string' && body.type.startsWith('response.') && record(body.response)) {
        const event = body.type.slice('response.'.length);
        if (!lifecycle.has(event)) return;
        final &&= event !== 'created' && !ongoing.has(event);
        body = body.response;
      } else if (body.type !== undefined && body.type !== 'error' && body.type !== 'response.error') return;
      if (typeof body.status === 'string' && ongoing.has(body.status)) final = false;
    } else if (this.#path === chat) {
      if (body.type !== undefined && body.type !== 'error') return;
      if (Array.isArray(body.choices) && body.choices.length && (body.object === 'chat.completion.chunk' ||
          body.choices.some(choice => record(choice) && choice.delta !== undefined))) final = false;
    } else return;

    this.#model = safeModelId(body.model) ?? this.#model;
    // A metered error can carry its own usage, or share the ordinary envelope.
    const errorOutput = record(body.error) && this.#update(body.error.usage);
    const output = this.#update(body.usage);
    if (final && (output || errorOutput)) this.#final = true;
  }

  snapshot(): MeterSnapshot {
    // Chat field names were normalized on ingestion.
    const counts = this.#path === messages ? messageCounts(this.#counters) : compactUsage(responses, this.#counters);
    const iterations = this.#iterations;
    if (iterations) {
      counts.input_tokens = iterations.input;
      counts.output_tokens = iterations.output;
      counts.total_tokens = iterations.input === null || iterations.output === null ? null : add(iterations.input, iterations.output);
    }
    const complete = this.#final && counts.input_tokens !== null && counts.output_tokens !== null &&
      counts.total_tokens !== null && (iterations?.complete ?? valid(this.#counters.input_tokens));
    return { ...counts, model: this.#model, complete };
  }
}

import { compactUsage } from './token-usage.ts';

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectScalars(source: Fields, names: string[]): Fields {
  const selected: Fields = {};
  for (const name of names) {
    const value = source[name];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      selected[name] = value;
    }
  }
  return selected;
}

function formatType(format: unknown): Fields | undefined {
  if (isObject(format) && typeof format.type === 'string' && ['text', 'json_object', 'json_schema'].includes(format.type)) {
    return { type: format.type };
  }
}

function isVerbosity(value: unknown): boolean {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function activeParameters(path: string, request: Fields): Fields {
  const params: Fields = {};
  let numbers: string[];
  let stopField: string | undefined;
  if (path === '/v1/responses') {
    numbers = ['temperature', 'top_p', 'max_output_tokens', 'frequency_penalty', 'presence_penalty', 'top_logprobs'];
    if (isObject(request.text)) {
      const text: Fields = {};
      const format = formatType(request.text.format);
      if (format) text.format = format;
      if (isVerbosity(request.text.verbosity)) text.verbosity = request.text.verbosity;
      if (Object.keys(text).length) params.text = text;
    }
  } else if (path === '/v1/chat/completions') {
    numbers = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n', 'frequency_penalty',
      'presence_penalty', 'seed', 'top_logprobs'];
    stopField = 'stop';
    if (typeof request.logprobs === 'boolean') params.logprobs = request.logprobs;
    if (isVerbosity(request.verbosity)) params.verbosity = request.verbosity;
    const format = formatType(request.response_format);
    if (format) params.response_format = format;
    if (isObject(request.logit_bias)) {
      const biases = Object.entries(request.logit_bias).filter(([id, bias]) =>
        /^\d+$/.test(id) && typeof bias === 'number' && Number.isFinite(bias));
      if (biases.length) params.logit_bias = Object.fromEntries(biases);
    }
  } else if (path === '/v1/messages') {
    numbers = ['max_tokens', 'temperature', 'top_p', 'top_k'];
    stopField = 'stop_sequences';
    const currentFormat = isObject(request.output_config) && formatType(request.output_config.format);
    if (currentFormat) params.output_config = { format: currentFormat };
    const legacyFormat = formatType(request.output_format);
    if (legacyFormat) params.output_format = legacyFormat;
  } else {
    return params;
  }
  for (const field of numbers) {
    const value = request[field];
    if (typeof value === 'number' && Number.isFinite(value)) params[field] = value;
  }
  if (stopField) {
    const stop = request[stopField];
    if ((stopField === 'stop' && typeof stop === 'string') ||
        (Array.isArray(stop) && stop.length && stop.every(item => typeof item === 'string'))) {
      params[stopField] = stop;
    }
  }
  return params;
}

function textBlocks(content: unknown, textType: 'text' | 'output_text', refusals: boolean): Fields[] {
  const blocks: Fields[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === textType && typeof block.text === 'string') blocks.push({ type: textType, text: block.text });
    if (refusals && block.type === 'refusal' && typeof block.refusal === 'string') {
      blocks.push({ type: 'refusal', refusal: block.refusal });
    }
  }
  return blocks;
}

function openaiResponse(payload: Fields): Fields {
  const result = selectScalars(payload, ['model', 'id', 'object', 'status']);
  const output: Fields[] = [];
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isObject(item) || item.type !== 'message' || (item.role != null && item.role !== 'assistant') ||
          (item.phase != null && item.phase !== 'final_answer')) continue;
      output.push({
        ...selectScalars(item, ['id', 'type', 'role', 'status', 'phase']),
        content: textBlocks(item.content, 'output_text', true),
      });
    }
  }
  // Some compatible responses carry only the SDK's output_text convenience
  // field. Never use it to replace filtered commentary or reasoning items.
  if ((payload.output == null || (Array.isArray(payload.output) && payload.output.length === 0))
      && typeof payload.output_text === 'string') {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: payload.output_text }] });
  }
  result.output = output;
  if (payload.status === 'incomplete' && isObject(payload.incomplete_details)) {
    result.incomplete_details = selectScalars(payload.incomplete_details, ['reason']);
  }
  if (payload.status === 'failed' && isObject(payload.error)) {
    result.error = selectScalars(payload.error, ['code', 'message']);
  }
  return result;
}

function anthropicMessage(payload: Fields): Fields {
  const result = selectScalars(payload, ['model', 'id', 'type', 'role', 'stop_reason']);
  result.content = textBlocks(payload.content, 'text', false);
  if (payload.stop_reason === 'stop_sequence' && typeof payload.stop_sequence === 'string') {
    result.stop_sequence = payload.stop_sequence;
  }
  if (payload.stop_reason === 'refusal' && isObject(payload.stop_details) && payload.stop_details.type === 'refusal') {
    result.stop_details = selectScalars(payload.stop_details, ['type', 'category', 'explanation']);
  }
  return result;
}

function chatCompletion(payload: Fields): Fields {
  const result = selectScalars(payload, ['model', 'id', 'object']);
  const choices: Fields[] = [];
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!isObject(choice) || !isObject(choice.message)) continue;
      const raw = choice.message;
      if (raw.phase != null && raw.phase !== 'final_answer') continue;
      const message = selectScalars(raw, ['role']);
      if (typeof raw.content === 'string' || raw.content === null) message.content = raw.content;
      if (Array.isArray(raw.content)) message.content = textBlocks(raw.content, 'text', true);
      if (typeof raw.refusal === 'string') message.refusal = raw.refusal;
      choices.push({ ...selectScalars(choice, ['index', 'finish_reason']), message });
    }
  }
  result.choices = choices;
  return result;
}

export function compactJson(path: string, payload: unknown, params: Fields): unknown {
  let project: (value: Fields) => Fields;
  switch (path) {
    case '/v1/responses': project = openaiResponse; break;
    case '/v1/messages': project = anthropicMessage; break;
    case '/v1/chat/completions': project = chatCompletion; break;
    default: return payload;
  }
  if (!isObject(payload)) throw new TypeError('Expected a provider response object.');
  if (isObject(payload.error) && payload.status == null) {
    const error = selectScalars(payload.error, ['type', 'code', 'message', 'param']);
    return path === '/v1/messages' ? { type: 'error', error } : { error };
  }
  return {
    ...project(payload), parameters: params,
    usage: compactUsage(path, payload.usage),
  };
}

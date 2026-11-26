import { RelayError } from './input-budget.ts';

type Fields = Record<string, unknown>;
const omit = Symbol('omitted input');

function object(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function without(value: Fields, keys: readonly string[]): Fields {
  if (!keys.some(key => Object.hasOwn(value, key))) return value;
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function mapParts(items: unknown[], clean: (item: unknown) => unknown): unknown[] {
  const kept: unknown[] = [];
  let changed = false;
  for (const item of items) {
    const result = clean(item);
    if (result !== item) changed = true;
    if (result !== omit) kept.push(result);
  }
  return changed ? kept : items;
}

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (!object(value)) return false;
  switch (value.type) {
    case 'text': case 'input_text': case 'output_text': case 'summary_text': case 'reasoning_text':
      return typeof value.text === 'string' && value.text.trim().length > 0;
    case 'refusal': return typeof value.refusal === 'string' && value.refusal.trim().length > 0;
    case 'tool_result': case 'search_result': return hasContent(value.content);
    case 'function_call_output': case 'custom_tool_call_output': return hasContent(value.output);
    case 'document': return object(value.source) && hasContent(value.source.data ?? value.source.content);
    case 'message': case undefined:
      return hasContent(value.content) || (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) ||
        object(value.function_call);
    default: return true; // An inspected nonvisual tool call, thinking block, or audio input.
  }
}

// Inspect only provider input structures. URL strings in prompts, signed thinking
// blocks and application-defined tool arguments/schema are not image inputs.
const plainParts = new Set(['text', 'input_text', 'output_text', 'refusal', 'summary_text', 'reasoning_text',
  'thinking', 'redacted_thinking', 'tool_use', 'tool_reference', 'function_call', 'custom_tool_call',
  'input_audio', 'reasoning']);

function cleanContent(content: unknown, depth: number): unknown {
  if (depth > 32) throw new RelayError(400, 'Input content is nested too deeply to inspect.');
  if (typeof content === 'string' || content == null) return content;
  if (Array.isArray(content)) return mapParts(content, item => cleanPart(item, depth + 1));
  return cleanPart(content, depth + 1);
}

function cleanDocument(block: Fields, depth: number): unknown {
  const source = block.source;
  if (!object(source)) return omit;
  if (source.type === 'text' && source.media_type === 'text/plain' && typeof source.data === 'string') return block;
  if (source.type !== 'content') return omit;
  const content = cleanContent(source.content, depth);
  if (content === source.content) return block;
  return content === omit || !hasContent(content) ? omit : { ...block, source: { ...source, content } };
}

function inlineFileText(block: Fields, textType: 'input_text' | 'text'): unknown {
  // File IDs and URLs do not establish a file's type. Rewrap an inline UTF-8
  // plain-text attachment as text so no provider file renderer sees any bytes.
  if (typeof block.file_data !== 'string' || block.file_id != null || block.file_url != null) return omit;
  const header = /^data:text\/plain(?:;charset=utf-8)?;base64,/i.exec(block.file_data);
  if (!header) return omit;
  const encoded = block.file_data.slice(header[0].length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return omit;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
    if (!text.includes('\0')) return { type: textType, text };
  } catch { /* An opaque file has no verified inline text. */ }
  return omit;
}

function cleanPart(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value;
  if (!object(value)) return omit;
  const type = value.type;
  if (type === 'input_file') return inlineFileText(value, 'input_text');
  if (type === 'file' && object(value.file)) return inlineFileText(value.file, 'text');
  // An ID-only reasoning item asks the service to resolve a stored item. A
  // self-contained reasoning item carries its own signed content or summary.
  if (type === 'reasoning' && value.id != null && !value.encrypted_content &&
      !hasContent(value.content) && !hasContent(value.summary)) return omit;
  if (typeof type === 'string' && plainParts.has(type)) return value;
  if (type === 'document') return cleanDocument(value, depth);
  if (type === 'tool_result' || type === 'search_result' || type === 'function_call_output' || type === 'custom_tool_call_output') {
    const key = type === 'tool_result' || type === 'search_result' ? 'content' : 'output';
    const content = cleanContent(value[key], depth);
    if (content === value[key]) return value;
    if (type === 'search_result' && (content === omit || !hasContent(content))) return omit;
    // Completed client tool calls need a paired result even when their only
    // attachment was removed. Its call ID is distinct from a stored item ID.
    return { ...without(value, ['id']), [key]: content === omit || !hasContent(content) ? '' : content };
  }
  // Image, file, screenshot, compaction, and server-managed or future content
  // blocks cannot establish text-only input. Keep their inspectable siblings.
  return omit;
}

function cleanItem(item: unknown): unknown {
  if (!object(item)) return cleanPart(item, 0);
  if (item.type !== 'message' && !(item.type == null && typeof item.role === 'string')) return cleanPart(item, 0);
  if (item.id != null && item.content == null && item.tool_calls == null && item.function_call == null) return omit;
  const content = cleanContent(item.content, 0);
  if (content === item.content) return item;
  if (content === omit || (Array.isArray(content) && !content.length)) {
    if ((Array.isArray(item.tool_calls) && item.tool_calls.length > 0) || object(item.function_call)) {
      return { ...without(item, ['id']), content: null };
    }
    return omit;
  }
  return { ...without(item, ['id']), content };
}

function noText(): never {
  throw new RelayError(400, 'Image input is disabled. Include text or other usable inline input in your request.');
}

function cleanItems(items: unknown[]): unknown[] {
  const latestTurn = items.findLast(item => object(item) && (item.role === 'user' || item.role === 'tool' ||
    item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'computer_call_output'));
  return mapParts(items, item => {
    const cleaned = cleanItem(item);
    if (item === latestTurn && cleaned !== item && !hasContent(cleaned)) noText();
    return cleaned;
  });
}

const storedContext = ['previous_response_id', 'conversation', 'prompt', 'container', 'container_id'];

/** Strip image-bearing inputs before either token counting or generation. */
export function stripImageInputs(path: string, body: Fields): Fields {
  const responses = path === '/v1/responses' || path === '/v1/responses/input_tokens';
  const claude = path === '/v1/messages' || path === '/v1/messages/count_tokens';
  if (!responses && !claude && path !== '/v1/chat/completions') return body;
  const inputKey = responses ? 'input' : 'messages';
  let result = without(body, storedContext.filter(key => body[key] != null));
  const original = body[inputKey];
  if (original != null && !Array.isArray(original) && !(responses && typeof original === 'string')) {
    throw new RelayError(400, 'Invalid conversation input. Send inline text in the expected message format.');
  }
  const input = Array.isArray(original) ? cleanItems(original) : original;
  if (input !== body[inputKey]) result = { ...result, [inputKey]: input };
  const systemKey = claude ? 'system' : responses ? 'instructions' : undefined;
  if (systemKey && body[systemKey] != null && typeof body[systemKey] !== 'string' && !Array.isArray(body[systemKey])) {
    throw new RelayError(400, 'Invalid system instructions. Send inline text in the expected message format.');
  }
  if (systemKey && Array.isArray(body[systemKey])) {
    const value = cleanContent(body[systemKey], 0);
    if (value !== body[systemKey]) result = { ...result, [systemKey]: value };
  }
  if (result !== body && !hasContent(input)) noText();
  return result;
}

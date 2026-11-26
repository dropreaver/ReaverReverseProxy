type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const failureTypes = new Set(["error", "response.error", "response.failed", "response.cancelled", "response.canceled"]);
const failureStatuses = new Set(["failed", "cancelled", "canceled", "error"]);

function failedEnvelope(value: Fields): boolean {
  return value.error != null || (typeof value.status === "string" && failureStatuses.has(value.status));
}

export function isProviderFailure(payload: unknown): boolean {
  if (!isObject(payload)) return false;
  if (failedEnvelope(payload)) return true;
  const { type, response } = payload;
  if (typeof type !== "string") return false;
  if (failureTypes.has(type)) return true;
  // Responses lifecycle events wrap the response object. Tool arguments and
  // message content may contain arbitrary application-defined error fields.
  return type.startsWith("response.") && isObject(response) && failedEnvelope(response);
}

const tokenTotals = [
  "input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens",
  "cache_creation_input_tokens", "cache_read_input_tokens",
];
const tokenBreakdowns = [
  "input_tokens_details", "output_tokens_details", "prompt_tokens_details", "completion_tokens_details", "cache_creation",
];

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveBucket(bucket: unknown, suffix: string): boolean {
  return isObject(bucket) && Object.entries(bucket).some(([key, value]) => key.endsWith(suffix) && positive(value));
}

function positiveCounters(usage: Fields): boolean {
  return tokenTotals.some(key => positive(usage[key])) ||
    tokenBreakdowns.some(key => positiveBucket(usage[key], "_tokens")) ||
    positiveBucket(usage.server_tool_use, "_requests");
}

export function hasMeteredUsage(usage: unknown): boolean {
  // Claude can report a separately metered iteration even when its top-level counts are zero.
  return isObject(usage) && (positiveCounters(usage) || contains(usage.iterations, positiveCounters));
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function contains(list: unknown, check: (value: Fields) => boolean): boolean {
  return Array.isArray(list) && list.some(value => isObject(value) && check(value));
}

function generatedBlock(block: Fields): boolean {
  switch (block.type) {
    case "text": case "output_text": case "summary_text": case "reasoning_text": return nonempty(block.text);
    case "refusal": return nonempty(block.refusal);
    case "thinking": return nonempty(block.thinking) || nonempty(block.signature);
    case "redacted_thinking": return nonempty(block.data);
    case "tool_use": case "server_tool_use": case "mcp_tool_use": return nonempty(block.name);
    case "compaction": return nonempty(block.content) || nonempty(block.encrypted_content);
    default: return false;
  }
}

function generatedMessage(message: unknown): boolean {
  if (!isObject(message) || (message.role != null && message.role !== "assistant")) return false;
  if (nonempty(message.content) || contains(message.content, generatedBlock) || nonempty(message.refusal) ||
      nonempty(message.reasoning_content) || nonempty(message.reasoning)) return true;
  if (isObject(message.audio) && (nonempty(message.audio.data) || nonempty(message.audio.transcript))) return true;
  function tool(call: unknown) {
    return isObject(call) && (nonempty(call.name) || nonempty(call.arguments) || nonempty(call.input));
  }
  return tool(message.function_call) || contains(message.tool_calls, call => tool(call.function) || tool(call.custom));
}

function generatedItem(item: Fields): boolean {
  switch (item.type) {
    case "message": return generatedMessage(item);
    case "reasoning": return nonempty(item.encrypted_content) || contains(item.summary, generatedBlock) ||
      contains(item.content, generatedBlock);
    case "function_call": case "mcp_call": return nonempty(item.name) || nonempty(item.arguments);
    case "custom_tool_call": return nonempty(item.name) || nonempty(item.input);
    case "compaction": return generatedBlock(item);
    default: return false;
  }
}

function responseUsed(response: Fields): boolean {
  return hasMeteredUsage(response.usage) || (isObject(response.error) && hasMeteredUsage(response.error.usage)) ||
    nonempty(response.output_text) || contains(response.output, generatedItem);
}

const responseFragments = /^response\.(?:output_text|refusal|reasoning_text|reasoning_summary_text|function_call_arguments|custom_tool_call_input|mcp_call_arguments|code_interpreter_call_code|audio|audio_transcript|output_audio|output_audio_transcript)\.(?:delta|done)$/;

export function hasProviderUsage(payload: unknown, path?: string): boolean {
  if (!isObject(payload) || path?.endsWith("/count_tokens") || path?.endsWith("/input_tokens")) return false;
  // Only inspect provider-owned response fields. The request, error message and
  // tool input can themselves contain arbitrarily named token counts or output.
  if (responseUsed(payload)) return true;
  if (contains(payload.choices, choice => generatedMessage(choice.message) || generatedMessage(choice.delta))) return true;
  if (payload.type === "message" || payload.role === "assistant" || path === "/v1/messages") {
    if (generatedMessage(payload)) return true;
  }
  const type = payload.type;
  if (typeof type !== "string") return false;
  if (type === "message_start" && isObject(payload.message)) {
    return hasMeteredUsage(payload.message.usage) || generatedMessage(payload.message);
  }
  if (type === "content_block_start") return isObject(payload.content_block) && generatedBlock(payload.content_block);
  if (type === "content_block_delta" && isObject(payload.delta)) {
    const delta = payload.delta;
    switch (delta.type) {
      case "text_delta": return nonempty(delta.text);
      case "thinking_delta": return nonempty(delta.thinking);
      case "signature_delta": return nonempty(delta.signature);
      case "input_json_delta": return nonempty(delta.partial_json);
      default: return false;
    }
  }
  if (!type.startsWith("response.")) return false;
  if (isObject(payload.response) && responseUsed(payload.response)) return true;
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    return isObject(payload.item) && generatedItem(payload.item);
  }
  if (type === "response.content_part.added" || type === "response.content_part.done" ||
      type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
    return isObject(payload.part) && generatedBlock(payload.part);
  }
  return responseFragments.test(type) && [payload.delta, payload.text, payload.refusal, payload.arguments,
    payload.input, payload.code, payload.transcript].some(nonempty);
}

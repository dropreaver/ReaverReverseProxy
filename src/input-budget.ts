type Fields = Record<string, unknown>;
type CountInput = (path: string, payload: Fields) => Promise<number>;

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function object(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uncountable(): never {
  throw new RelayError(400, "The gateway cannot enforce token limits for this request. Use inline text and client-executed tools.");
}

// Forward every count-relevant field to the provider. A new input feature must
// be classified before generation rather than silently omitted from the count.
const responsesCountFields = new Set([
  "model", "input", "instructions", "previous_response_id", "parallel_tool_calls", "personality",
  "reasoning", "text", "tool_choice", "tools", "truncation",
]);
const responsesOptions = new Set([
  "background", "background_options", "include", "max_output_tokens", "max_tool_calls",
  "metadata", "moderation", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention",
  "safety_identifier", "service_tier", "store", "stream", "stream_options", "temperature",
  "frequency_penalty", "presence_penalty", "top_logprobs", "top_p", "user",
]);
const messagesCountFields = new Set([
  "model", "messages", "system", "cache_control", "tools", "tool_choice", "thinking", "speed",
  "output_config", "output_format", "user_profile_id", "workspace_id",
]);
const messagesOptions = new Set([
  "billing_policy", "diagnostics", "inference_geo", "metadata", "service_tier", "max_tokens",
  "stop_sequences", "stream", "temperature", "top_k", "top_p",
]);
const chatOptions = new Set([
  "model", "messages", "tools", "tool_choice", "functions", "function_call", "prediction",
  "response_format", "modalities", "frequency_penalty", "logit_bias", "logprobs",
  "max_completion_tokens", "max_tokens", "metadata", "moderation", "n", "parallel_tool_calls",
  "presence_penalty", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention",
  "reasoning_effort", "safety_identifier", "seed", "service_tier", "stop", "store", "stream",
  "stream_options", "temperature", "top_logprobs", "top_p", "user", "verbosity",
]);

function countPayload(body: Fields, include: Set<string>, omit: Set<string>): Fields {
  const entries = Object.entries(body).filter(([key, value]) => {
    if (include.has(key)) return true;
    if (value != null && !omit.has(key)) uncountable();
    return false;
  });
  return Object.fromEntries(entries);
}

function checkClientTools(tools: unknown, claude: boolean) {
  if (tools == null) return;
  if (!Array.isArray(tools)) uncountable();
  for (const tool of tools) {
    if (!object(tool)) uncountable();
    if (claude && (tool.type === undefined || tool.type === "custom") && typeof tool.name === "string") continue;
    if (!claude && (tool.type === "function" || tool.type === "custom")) continue;
    uncountable();
  }
}

function checkStableContent(input: unknown) {
  // Counting and generation must see the same remaining input. Remote media
  // URLs can change between those calls.
  const pending: unknown[] = [input];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    if (!object(node)) continue;
    if (node.type === "url" && typeof node.url === "string") uncountable();
    for (const name of ["image_url", "file_url", "video_url", "audio_url"]) {
      const url = node[name];
      if (url != null && (typeof url !== "string" || !url.startsWith("data:"))) uncountable();
    }
    // Recurse through provider content envelopes, excluding application-defined
    // JSON such as a Claude tool_use.input that may describe a URL as plain data.
    pending.push(node.content, node.output, node.source);
  }
}

async function chatInputCharge(body: Fields, limit: number, count: CountInput): Promise<number> {
  // Chat Completions has no native preflight. Byte-pair encodings consume at
  // most one token per UTF-8 byte of text. Charge the serialized input including
  // keys and quotes, plus slack for the chat and tool framing added by OpenAI.
  for (const [key, value] of Object.entries(body)) {
    if (value != null && !chatOptions.has(key)) uncountable();
  }
  if (body.modalities != null && (!Array.isArray(body.modalities) || body.modalities.some(mode => mode !== "text"))) uncountable();
  if (!Array.isArray(body.messages)) throw new RelayError(400, "Chat Completions requires a messages array.");
  let parts = 0;
  for (const message of body.messages) {
    if (!object(message) || message.audio != null) uncountable();
    if (message.content == null || typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) uncountable();
    for (const part of message.content) {
      if (!object(part) || (part.type !== "text" && part.type !== "refusal")) uncountable();
      parts++;
    }
  }
  const { messages, tools, functions, tool_choice, function_call, response_format, prediction } = body;
  if (functions != null && !Array.isArray(functions)) uncountable();
  const toolCount = (Array.isArray(tools) ? tools.length : 0) + (Array.isArray(functions) ? functions.length : 0);
  const promptBytes = Buffer.byteLength(JSON.stringify({ messages, tools, functions, tool_choice, function_call, response_format, prediction }));
  const framing = 32 + 16 * (messages.length + parts);
  const byteCharge = promptBytes + framing + 64 * toolCount;
  if (byteCharge <= limit || toolCount || tool_choice != null || function_call != null || prediction != null) return byteCharge;
  if (response_format != null && (!object(response_format) || response_format.type !== "text" || Object.keys(response_format).length !== 1)) return byteCharge;

  // Long plain-text chats can still fit. Count equivalent Responses messages on
  // the same model and reserve framing again for differences between protocols.
  // Names, historic tool calls and arbitrary message extensions have no such
  // one-to-one representation; retain their conservative byte charge.
  const input: Fields[] = [];
  for (const message of messages) {
    if (!["system", "developer", "user", "assistant"].includes(message.role) ||
        Object.keys(message).some(key => key !== "role" && key !== "content")) return byteCharge;
    const { role, content } = message;
    if (typeof content === "string") {
      input.push({ role, content });
      continue;
    }
    if (!Array.isArray(content) || !content.every(part => object(part) && part.type === "text" &&
        typeof part.text === "string" && Object.keys(part).length === 2)) return byteCharge;
    input.push({ role, content: content.map(part => ({ type: "input_text", text: part.text })) });
  }
  const equivalent: Fields = { model: body.model, input };
  if (body.reasoning_effort != null) equivalent.reasoning = { effort: body.reasoning_effort };
  if (body.verbosity != null) equivalent.text = { verbosity: body.verbosity };
  return (await checkedCount(count, "/v1/responses/input_tokens", equivalent)) + framing;
}

async function checkedCount(count: CountInput, path: string, payload: Fields): Promise<number> {
  const value = await count(path, payload);
  if (!Number.isSafeInteger(value) || value < 0) throw new RelayError(502, "The provider returned an invalid input token count.");
  return value;
}

export async function enforceInputBudget(path: string, body: Fields, limit: number, count: CountInput): Promise<void> {
  // These models can search or produce media without an explicit tools declaration.
  if (typeof body.model === "string" &&
      /(?:^|-)(?:search|deep-research|image|audio|realtime|live|tts|transcribe|whisper)(?:-|$)/i.test(body.model)) uncountable();
  const claude = path === "/v1/messages";
  checkClientTools(body.tools, claude);
  let tokens: number;
  if (path === "/v1/chat/completions") {
    tokens = await chatInputCharge(body, limit, count);
  } else if (claude) {
    checkStableContent(body.messages);
    tokens = await checkedCount(count, "/v1/messages/count_tokens", countPayload(body, messagesCountFields, messagesOptions));
  } else if (path === "/v1/responses") {
    checkStableContent(body.input);
    tokens = await checkedCount(count, "/v1/responses/input_tokens", countPayload(body, responsesCountFields, responsesOptions));
  } else {
    uncountable();
  }
  if (tokens > limit) {
    throw new RelayError(413, "Request exceeds the gateway input limit of " + limit + " tokens.");
  }
}

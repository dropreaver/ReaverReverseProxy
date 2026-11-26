import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { budgetFields, tokenCountPaths, type Route } from "./routes.ts";
import type { Config } from "./access.ts";
import { activeParameters, compactJson } from "./compact-response.ts";
import { compactStream, observeNativeStream } from "./compact-stream.ts";
import { hasProviderUsage, isProviderFailure } from "./provider-outcome.ts";
import { keyLimitedUntil } from "./key-limits.ts";
import { observeNativeJson } from "./native-json.ts";
import { observeEncodedBody } from "./encoded-observer.ts";
import { enforceInputBudget, RelayError } from "./input-budget.ts";
import { safeModelId } from "./model-meter.ts";
import { stripImageInputs } from "./vision-policy.ts";

export { resolveRoute, type Provider, type Route } from "./routes.ts";
export { RelayError };

const hosts = { openai: "api.openai.com", anthropic: "api.anthropic.com" } as const;
const jsonMediaType = /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i;

interface RelayObservers {
  onUsage(): void;
  onMeter?(payload: unknown, partial?: boolean): void;
  onModel(name: string): void;
  onKeyLimited(until: number): void;
}

function observeKeyLimits(origin: IncomingMessage, route: Route, onLimited: RelayObservers["onKeyLimited"]) {
  const status = origin.statusCode ?? 502;
  const receivedAt = Date.now();
  const initial = keyLimitedUntil(route.provider, status, origin.headers, undefined, receivedAt);
  if (initial !== undefined) onLimited(initial);
  // A successful HTTP stream can report a new rate error much later. Its
  // opening remaining/reset headers have already been applied at receipt.
  const success = status >= 200 && status < 300;
  const errorHeaders = success ? {
    "retry-after": origin.headers["retry-after"], "retry-after-ms": origin.headers["retry-after-ms"],
  } : origin.headers;
  return (payload?: unknown) => {
    if (payload === undefined) return;
    const until = keyLimitedUntil(route.provider, status, errorHeaders, payload, success ? Date.now() : receivedAt);
    if (until !== undefined) onLimited(until);
  };
}

function readBody(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw new RelayError(413, "Request exceeds the gateway body size limit.");
  if (req.method === "GET") {
    if (declared > 0 || req.headers["transfer-encoding"]) throw new RelayError(400, "GET requests must have an empty body.");
    return Promise.resolve(Buffer.alloc(0));
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw new RelayError(415, "Send an uncompressed request body.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignal);
    }
    function onData(chunk: Buffer) {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        cleanup();
        reject(new RelayError(413, "Request exceeds the gateway body size limit."));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    }
    function onAborted() { onError(new RelayError(400, "Request body was interrupted.")); }
    function onSignal() { onError(signal.reason); }
    function onError(error: unknown) {
      cleanup();
      reject(error);
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal.addEventListener("abort", onSignal, { once: true });
    if (req.destroyed) onAborted();
  });
}

const modelMetadataPaths = new Set([
  ...Object.keys(budgetFields), "/v1/messages/count_tokens", "/v1/responses/input_tokens",
  "/v1/responses/compact", "/v1/decisions",
]);

interface PreparedBody {
  body: Buffer;
  parameters?: Record<string, unknown>;
  payloadToCount?: Record<string, unknown>;
}

// These requests need provider-native blocks, signatures, or non-text output.
function needsNativeReply(request: Record<string, unknown>): boolean {
  const { modalities, include } = request;
  const hasTools = [request.tools, request.functions, request.mcp_servers].some(value => Array.isArray(value) && value.length > 0);
  return !!(hasTools || request.audio || (Array.isArray(modalities) && modalities.some(value => value !== "text")) ||
    request.background ||
    request.logprobs || request.top_logprobs ||
    (Array.isArray(include) && include.some(value => value !== "reasoning.encrypted_content")));
}

// RisuAI can send Chat Completions controls to Responses. Normalize them once
// so the token counter, generation API, and displayed parameters agree.
function normalizeResponsesOptions(body: Record<string, unknown>) {
  for (const [alias, group, field] of [["verbosity", "text", "verbosity"], ["reasoning_effort", "reasoning", "effort"]]) {
    if (!Object.hasOwn(body, alias)) continue;
    const value = body[alias];
    delete body[alias];
    if (value == null) continue;
    if (typeof value !== "string") throw new RelayError(400, alias + " must be a string.");
    const options = body[group] ?? {};
    if (typeof options !== "object" || Array.isArray(options) || JSON.isRawJSON(options)) {
      throw new RelayError(400, group + " must be an object when using " + alias + ".");
    }
    const current = (options as Record<string, unknown>)[field];
    if (current != null && current !== value) {
      throw new RelayError(400, "Conflicting values for " + alias + " and " + group + "." + field + ".");
    }
    body[group] = { ...options, [field]: value };
  }
  // These models have no temperature control. RisuAI sends 1 by default.
  if (typeof body.model === "string" && /^gpt-6\.2-(?:astra|sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(body.model)
      && body.temperature != null) {
    const temperature = JSON.isRawJSON(body.temperature) ? Number(body.temperature.rawJSON) : body.temperature;
    if (temperature !== 1) throw new RelayError(400, "This model does not support temperature. Omit temperature from the Responses request.");
    delete body.temperature;
  }
}

function prepareBody(route: Route, body: Buffer, contentType: string, limit: number, onModel?: (model: string) => void): PreparedBody {
  const fields = budgetFields[route.path];
  const budgeted = fields !== undefined;
  const inspectContent = budgeted || tokenCountPaths.has(route.path);
  const compact = !route.providerPrefixed && budgeted;
  const inspectModel = onModel && modelMetadataPaths.has(route.path) && (budgeted || body.length <= 2 * 1024 * 1024);
  if (!inspectContent && !inspectModel) return { body };
  if (!jsonMediaType.test(contentType)) {
    if (inspectContent) throw new RelayError(415, "This endpoint requires a JSON body.");
    return { body };
  }
  let payloadToCount;
  let preservedNumber = false;
  try {
    const source = body.toString("utf8");
    // Schema defaults and examples can contain numbers outside JS precision.
    // Send the same numeric literals for counting and for generation.
    payloadToCount = JSON.parse(source, (_key, value, context) => {
      if (typeof value === "number" && context.source !== String(value)) {
        preservedNumber = true;
        return JSON.rawJSON(context.source);
      }
      return value;
    });
  } catch {
    if (inspectContent) throw new RelayError(400, "Invalid JSON body.");
    return { body };
  }
  if (!payloadToCount || typeof payloadToCount !== "object" || Array.isArray(payloadToCount) || JSON.isRawJSON(payloadToCount)) {
    if (inspectContent) throw new RelayError(400, "The request body must be a JSON object.");
    return { body };
  }
  if (inspectContent) payloadToCount = stripImageInputs(route.path, payloadToCount);
  const model = inspectModel && safeModelId(payloadToCount.model);
  if (model) onModel?.(model);
  if (route.path === "/v1/responses" || route.path === "/v1/responses/input_tokens") {
    normalizeResponsesOptions(payloadToCount);
  }
  if (fields === undefined) {
    return { body: inspectContent ? Buffer.from(JSON.stringify(payloadToCount)) : body };
  }
  // Use ordinary numbers for request controls while keeping exact numeric
  // literals in the body shared by token counting and generation.
  const payload = preservedNumber ? JSON.parse(JSON.stringify(payloadToCount)) : payloadToCount;
  const parameters = compact && !needsNativeReply(payload) ? activeParameters(route.path, payload) : undefined;
  if (route.path === "/v1/chat/completions" && payload.stream === true) {
    const options = payload.stream_options;
    if (options == null) payloadToCount.stream_options = { include_usage: true };
    else if (typeof options === "object" && !Array.isArray(options) && !Object.hasOwn(options, "include_usage")) {
      payloadToCount.stream_options.include_usage = true;
    }
  }
  const choices = route.path === "/v1/chat/completions" ? payload.n ?? 1 : 1;
  if (!Number.isSafeInteger(choices) || choices < 1) throw new RelayError(400, "Invalid completion count.");
  const ceiling = Math.floor(limit / choices);
  if (ceiling < 1) throw new RelayError(400, "Requested completions exceed the gateway output limit.");
  const existing = fields.filter((field) => Object.hasOwn(payload, field));
  for (const field of existing) {
    if (!Number.isSafeInteger(payload[field]) || payload[field] < 1 || payload[field] > ceiling) {
      throw new RelayError(400, "Requested " + field + " must be between 1 and " + ceiling + ".");
    }
  }
  if (existing.length === 0) {
    payloadToCount[fields[0]] = ceiling;
    if (parameters) parameters[fields[0]] = ceiling;
  }
  // Serialize the same object used for admission. Duplicate keys must resolve
  // identically for the gateway, the token counter, and the generation API.
  return { body: Buffer.from(JSON.stringify(payloadToCount)), parameters, payloadToCount };
}

function upstreamHeaders(req: IncomingMessage, route: Route, key: string, length: number): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { "accept-encoding": "identity" };
  const nominated = new Set((req.headers.connection || "").toLowerCase().split(",").map((s) => s.trim()));
  const pass = ["accept", "content-type", route.provider === "openai" ? "openai-beta" : "anthropic-beta"];
  for (const name of pass) {
    if (req.headers[name] !== undefined && !nominated.has(name)) headers[name] = req.headers[name];
  }
  if (route.provider === "anthropic") {
    headers["x-api-key"] = key;
    const version = nominated.has("anthropic-version") ? undefined : req.headers["anthropic-version"];
    headers["anthropic-version"] = version || "2026-10-21";
  } else {
    headers.authorization = "Bearer " + key;
  }
  if (req.method === "POST") {
    headers["content-type"] ??= "application/json";
    headers["content-length"] = length;
  }
  return headers;
}

async function sendToProvider(
  route: Route, method: string, path: string, headers: OutgoingHttpHeaders, body: Buffer, signal: AbortSignal,
): Promise<IncomingMessage> {
  try {
    return await new Promise<IncomingMessage>((resolve, reject) => {
      const call = request({ hostname: hosts[route.provider], method, path, headers, signal }, resolve);
      call.on("error", reject);
      call.end(body.length ? body : undefined);
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RelayError(502, "Could not reach the model provider.");
  }
}

async function providerTokenCount(
  req: IncomingMessage, route: Route, key: string, path: string, payload: Record<string, unknown>, signal: AbortSignal,
  onLimited: RelayObservers["onKeyLimited"],
): Promise<number> {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = upstreamHeaders(req, route, key, body.length);
  headers.accept = "application/json";
  headers["content-type"] = "application/json";
  const countSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let origin: IncomingMessage | undefined;
  try {
    origin = await sendToProvider(route, "POST", path, headers, body, countSignal);
    const onError = observeKeyLimits(origin, route, onLimited);
    const status = origin.statusCode ?? 502;
    if (status !== 200) {
      // Preserve the safe preflight error sent to clients while inspecting the provider's reason.
      if (jsonMediaType.test(origin.headers["content-type"] ?? "")) {
        const inspect = (data: AsyncIterable<Uint8Array>) => observeNativeJson(data, onError);
        const encoding = origin.headers["content-encoding"];
        const data = encoding && encoding !== "identity" ? observeEncodedBody(origin, encoding, inspect) : inspect(origin);
        try {
          for await (const _chunk of data) { /* Read only for quota signals. */ }
        } catch (error) {
          if (countSignal.aborted) throw error;
          // The known failure status still applies if its explanation was cut short.
        }
      }
      throw new RelayError(status >= 400 && status < 500 ? status : 502,
        "The provider could not count this input. Generation was not started.");
    }
    if (!jsonMediaType.test(origin.headers["content-type"] ?? "") ||
        (origin.headers["content-encoding"] && origin.headers["content-encoding"] !== "identity")) {
      throw new RelayError(502, "The provider returned an invalid token count.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of origin) {
      size += chunk.length;
      if (size > 16_384) throw new RelayError(502, "The provider returned an invalid token count.");
      chunks.push(chunk);
    }
    let count: unknown;
    try {
      const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      onError(result);
      if (!isProviderFailure(result)) count = result?.input_tokens;
    }
    catch { /* Reject malformed counts below. */ }
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new RelayError(502, "The provider returned an invalid token count.");
    }
    return count;
  } catch (error) {
    if (!signal.aborted && countSignal.aborted) {
      throw new RelayError(504, "The provider timed out while counting input tokens.");
    }
    throw error;
  } finally {
    origin?.destroy();
  }
}

const responseMetadata = new Set([
  "retry-after", "retry-after-ms", "request-id", "x-request-id", "openai-processing-ms",
]);

const permissionCodes = new Set([
  "access_denied", "insufficient_permissions", "insufficient_scope", "model_access_denied",
  "model_not_found", "permission_denied", "unsupported_country_region_territory",
]);

async function permissionCode(origin: IncomingMessage, body: AsyncIterable<Uint8Array>): Promise<string | undefined> {
  const maxBytes = 8192;
  const inspectCode = origin.statusCode === 403 && jsonMediaType.test(origin.headers["content-type"] ?? "")
    && !origin.headers["content-encoding"] && !(Number(origin.headers["content-length"]) > maxBytes);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (inspectCode && size <= maxBytes) chunks.push(chunk);
    }
    if (!inspectCode || size > maxBytes) return;
    const code = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))?.error?.code;
    if (permissionCodes.has(code)) return code;
  } catch {
    // A missing or malformed error body still gets the credential-safe response.
  }
}

export async function relay(
  req: IncomingMessage, res: ServerResponse, route: Route, key: string, signal: AbortSignal,
  config: Pick<Config, "maxBodyBytes" | "tokenLimits">, observers: RelayObservers,
): Promise<void> {
  const limits = config.tokenLimits[route.provider];
  let prepared: PreparedBody;
  try {
    const input = await readBody(req, config.maxBodyBytes, signal);
    prepared = prepareBody(route, input, req.headers["content-type"] ?? "application/json", limits.maxOutputTokens, observers.onModel);
  } catch (error) {
    if (!req.complete && !res.headersSent) res.setHeader("connection", "close");
    throw error;
  }
  signal.throwIfAborted();
  const { body, parameters, payloadToCount } = prepared;
  if (payloadToCount) {
    await enforceInputBudget(route.path, payloadToCount, limits.maxInputTokens,
      (path, payload) => providerTokenCount(req, route, key, path, payload, signal, observers.onKeyLimited));
  }
  const url = req.url || "";
  const queryIndex = url.indexOf("?");
  const path = route.path + (queryIndex >= 0 ? url.slice(queryIndex) : "");
  const origin = await sendToProvider(route, req.method!, path, upstreamHeaders(req, route, key, body.length), body, signal);
  await forwardResponse(origin, res, route, parameters, signal, observers);
}

async function forwardResponse(
  origin: IncomingMessage, res: ServerResponse, route: Route, parameters: Record<string, unknown> | undefined,
  signal: AbortSignal, observers: RelayObservers,
) {
  const status = origin.statusCode ?? 502;
  const success = status >= 200 && status < 300;
  const media = origin.headers["content-type"] ?? "";
  const isStream = /^text\/event-stream(?:\s*;|$)/i.test(media);
  const encoding = origin.headers["content-encoding"];
  const onError = observeKeyLimits(origin, route, observers.onKeyLimited);
  const onUsage = budgetFields[route.path] ? observers.onUsage : undefined;
  const onMeter = budgetFields[route.path] ? observers.onMeter : undefined;
  function observedBody(): AsyncIterable<Uint8Array> {
    const length = Number(origin.headers["content-length"]);
    const inspect = (source: AsyncIterable<Uint8Array>, decodedLength?: number) => isStream
      ? observeNativeStream(source, route.path, onError, onUsage, onMeter)
      : observeNativeJson(source, onError, decodedLength, onUsage, route.path, onMeter);
    return encoding && encoding !== "identity"
      ? observeEncodedBody(origin, encoding, inspect, undefined, length)
      : inspect(origin, length);
  }
  async function inspectDiscardedBody() {
    for await (const _chunk of observedBody()) { /* Usage can be present even when the body is not forwarded. */ }
  }
  for (const [name, value] of Object.entries(origin.headers)) {
    if (value !== undefined && (responseMetadata.has(name) || name.startsWith("x-ratelimit-") || name.startsWith("anthropic-ratelimit-"))) {
      res.setHeader(name, value);
    }
  }
  res.setHeader("cache-control", "no-store");
  if (status >= 300 && status < 400) {
    await inspectDiscardedBody();
    throw new RelayError(502, "The model provider returned an unexpected redirect.");
  }
  if (status === 401 || status === 403) {
    // Provider authentication errors can contain fragments of the server's key.
    const code = await permissionCode(origin, observedBody());
    origin.destroy();
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    const type = status === 401 ? "authentication_error" : "permission_error";
    const error = { type, code, message: "The provider credential does not have access to this request." };
    res.end(JSON.stringify(route.provider === "anthropic" ? { type: "error", error } : { error }));
    return;
  }
  res.statusCode = status;
  if (parameters && success) {
    if (encoding && encoding !== "identity") {
      await inspectDiscardedBody();
      throw new RelayError(502, "Unexpected encoding in the provider response.");
    }
    if (isStream) {
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      await pipeline(compactStream(origin, route.path, parameters, onError, onUsage, onMeter), res, { signal });
      return;
    }
    if (!jsonMediaType.test(media)) {
      await inspectDiscardedBody();
      throw new RelayError(502, "Expected JSON or an event stream from the provider.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let payload;
    try {
      for await (const chunk of origin) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw new RelayError(502, "Provider JSON response exceeded the compact response limit.");
      }
      payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch (error) {
      // A cut-off JSON reply may already contain token counts or model output.
      // Replay only the bytes received locally; the provider is never called again.
      const partial = observeNativeJson(Readable.from(chunks), onError, undefined, onUsage, route.path, onMeter);
      for await (const _chunk of partial) { /* Account for the received prefix. */ }
      throw error;
    }
    onError(payload);
    onMeter?.(payload);
    if (onUsage && hasProviderUsage(payload, route.path)) onUsage();
    const output = compactJson(route.path, payload, parameters);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(output));
    return;
  }
  for (const name of ["content-type", "content-length", "content-encoding", "content-disposition"]) {
    if (origin.headers[name] !== undefined) res.setHeader(name, origin.headers[name]!);
  }
  if (isStream) {
    res.setHeader("x-accel-buffering", "no");
  }
  res.flushHeaders();
  await pipeline(observedBody(), res, { signal });
}

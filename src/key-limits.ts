import type { IncomingHttpHeaders } from "node:http";
import type { Provider } from "./routes.ts";

type ProviderHeaders = Headers | IncomingHttpHeaders;
type Fields = Record<string, unknown>;
const defaultCooldown = 60_000;
const hardOpenAICodes = new Set([
  "insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded",
  "usage_limit_exceeded",
]);
const rateCodes = new Set(["rate_limit_error", "rate_limit_exceeded", "slow_down"]);

function object(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function header(headers: ProviderHeaders, name: string): string | undefined {
  const value = headers instanceof Headers ? headers.get(name) : headers[name];
  return typeof value === "string" ? value.trim() : undefined;
}

function providerError(payload: unknown): Fields | undefined {
  if (!object(payload)) return;
  if (payload.type === "response.failed" && object(payload.response) && object(payload.response.error)) {
    return payload.response.error;
  }
  // Only provider error envelopes qualify. Tool output, model text, metadata and
  // echoed caller input can all contain unrelated "error" and "code" fields.
  if (payload.type != null && (typeof payload.type !== "string" || !["error", "response.error", "response.failed"].includes(payload.type))) return;
  if (object(payload.error)) return payload.error;
  if (payload.type === "error" || payload.type === "response.error") return payload;
}

function durationMs(value: string): number | undefined {
  const parts = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value);
  if (!parts || !value) return;
  return Number(parts[1] ?? 0) * 86_400_000 + Number(parts[2] ?? 0) * 3_600_000 +
    Number(parts[3] ?? 0) * 60_000 + Number(parts[4] ?? 0) * 1000 + Number(parts[5] ?? 0);
}

function deadline(time: number | undefined, now: number): number | undefined {
  if (time !== undefined && Number.isSafeInteger(Math.ceil(time)) && time <= 8.64e15) return Math.max(now, Math.ceil(time));
}

function retryDeadline(headers: ProviderHeaders, now: number): number | undefined {
  const seconds = header(headers, "retry-after");
  const ms = header(headers, "retry-after-ms");
  const decimal = /^\d+(?:\.\d+)?$/;
  const dates: number[] = [];
  if (seconds && decimal.test(seconds)) dates.push(now + Number(seconds) * 1000);
  else if (seconds && /^[A-Z][a-z]{2}, .+ GMT$/.test(seconds)) dates.push(Date.parse(seconds));
  if (ms && decimal.test(ms)) dates.push(now + Number(ms));
  const valid = dates.map(time => deadline(time, now)).filter(time => time !== undefined);
  if (valid.length) return Math.max(...valid);
}

const openaiBuckets = ["requests", "tokens", "project-tokens"];
const claudeBuckets = ["requests", "tokens", "input-tokens", "output-tokens"];

/** Absolute eligibility time, Infinity for exhausted credits/limits requiring
 * operator action, or undefined when this response establishes no limit. */
export function keyLimitedUntil(
  provider: Provider, status: number, headers: ProviderHeaders, payload?: unknown, now = Date.now(),
): number | undefined {
  const success = status >= 200 && status < 300;
  if (!success && ![400, 402, 403, 429].includes(status)) return;
  const error = providerError(payload);
  const code = typeof error?.code === "string" ? error.code : "";
  const type = typeof error?.type === "string" ? error.type : "";
  if (provider === "openai" && (hardOpenAICodes.has(code) || hardOpenAICodes.has(type))) return Infinity;
  if (provider === "anthropic" && error) {
    const detail = object(error.details) ? error.details.error_code : undefined;
    const message = typeof error.message === "string" ? error.message : "";
    const billingOrValidation = type === "invalid_request_error" || type === "billing_error";
    if (billingOrValidation && /^Your credit balance is too low to access the Anthropic API\b/.test(message)) return Infinity;
    // This organization/workspace spend cap resets on the first of the month in UTC.
    if (detail === "enforced_spend_limit_reached" ||
        (billingOrValidation && /^You have reached your specified (?:workspace )?API usage limits\b/.test(message))) {
      const date = new Date(now);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
  const rateError = status === 429 || rateCodes.has(code) || rateCodes.has(type);
  if (!rateError && !success) return;
  if (rateError) {
    // Retry-After tells us when this request can be tried again. Bucket-reset
    // headers can instead describe the time until the entire bucket is full.
    const retry = retryDeadline(headers, now);
    if (retry !== undefined) return retry;
  }

  let depleted = false;
  let reset: number | undefined;
  let unspecifiedReset: number | undefined;
  for (const bucket of provider === "openai" ? openaiBuckets : claudeBuckets) {
    const openai = provider === "openai";
    // Claude rounds token counts to the nearest thousand, which can yield a
    // zero on successful requests that still have hundreds of tokens available.
    if (!openai && !rateError && bucket !== "requests") continue;
    const remaining = header(headers, openai ? "x-ratelimit-remaining-" + bucket : "anthropic-ratelimit-" + bucket + "-remaining");
    if (remaining === "0") depleted = true;
    else if (!rateError || remaining !== undefined) continue;
    const raw = header(headers, openai ? "x-ratelimit-reset-" + bucket : "anthropic-ratelimit-" + bucket + "-reset");
    if (!raw) continue;
    const delay = openai ? durationMs(raw) : undefined;
    const time = delay !== undefined ? now + delay : !openai && /^\d{4}-\d\d-\d\dT/.test(raw) ? Date.parse(raw) : undefined;
    const validated = deadline(time, now);
    if (validated === undefined) continue;
    if (remaining === "0") reset = Math.max(reset ?? now, validated);
    else unspecifiedReset = Math.max(unspecifiedReset ?? now, validated);
  }
  if (depleted || rateError) return reset ?? unspecifiedReset ?? now + defaultCooldown;
}

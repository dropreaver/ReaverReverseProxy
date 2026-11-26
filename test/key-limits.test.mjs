import assert from "node:assert/strict";
import test from "node:test";
import { keyLimitedUntil } from "../src/key-limits.ts";

const now = Date.UTC(2026, 11, 31, 23, 59);
const limit = (provider, status, headers = {}, body) => keyLimitedUntil(provider, status, headers, body, now);

test("OpenAI distinguishes depleted credits and enforced spend limits from expiring rate limits", () => {
  for (const code of ["insufficient_quota", "credit_balance_exhausted", "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded", "organization_usage_limit_exceeded", "billing_hard_limit_reached"]) {
    assert.equal(limit("openai", 429, { "retry-after": "1" }, { error: { code } }), Infinity);
    assert.equal(limit("openai", 200, {}, { type: "error", code }), Infinity);
  }
  assert.equal(limit("openai", 429, {}, { error: { type: "insufficient_quota" } }), Infinity);
  assert.equal(limit("openai", 200, {}, { type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }),
    now + 60_000);
  assert.equal(limit("openai", 200, {}, { status: "failed", error: { code: "insufficient_quota" } }), Infinity);
});

test("Claude identifies the official credit exhaustion message and monthly cap", () => {
  const credit = { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
  assert.equal(limit("anthropic", 400, {}, credit), Infinity);
  assert.equal(limit("anthropic", 402, {}, { type: "error", error: { ...credit.error, type: "billing_error" } }), Infinity);
  const nextMonth = Date.UTC(2027, 0, 1);
  assert.equal(limit("anthropic", 429, {}, { type: "error", error: { type: "rate_limit_error",
    details: { error_code: "enforced_spend_limit_reached" } } }), nextMonth);
  for (const scope of ["", "workspace "]) {
    assert.equal(limit("anthropic", 400, {}, { type: "error", error: { type: "invalid_request_error",
      message: "You have reached your specified " + scope + "API usage limits." } }), nextMonth);
  }
  assert.equal(limit("anthropic", 402, {}, { type: "error", error: { type: "billing_error",
    details: { error_code: "linked_organization_spend_limit_reached" } } }), undefined);
});

test("rate limits honor retry delays or depleted bucket resets across both transports", () => {
  assert.equal(limit("openai", 429, new Headers({ "Retry-After": "0.8", "retry-after-ms": "1300" })), now + 1300);
  assert.equal(limit("anthropic", 429, { "retry-after": new Date(now + 5000).toUTCString() }), now + 5000);
  assert.equal(limit("anthropic", 429, { "retry-after": "0" }), now);
  const headers = { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "3m0s100ms",
    "x-ratelimit-remaining-requests": "3", "x-ratelimit-reset-requests": "1h1m" };
  assert.equal(limit("openai", 429, headers), now + 180_100);
  assert.equal(limit("openai", 429, { ...headers, "retry-after": "2" }), now + 2000);
  assert.equal(limit("openai", 200, headers), now + 180_100);
  assert.equal(limit("openai", 429, { "x-ratelimit-reset-tokens": "1.25s" }), now + 1250);
  assert.equal(limit("openai", 200, { "x-ratelimit-remaining-project-tokens": "0" }), now + 60_000);
  assert.equal(limit("openai", 429, { "retry-after": "-1", "x-ratelimit-reset-tokens": "bad" }), now + 60_000);
  assert.equal(limit("openai", 429, { "retry-after-ms": "9".repeat(30) }), now + 60_000);
  const reset = new Date(now + 17_000).toISOString();
  assert.equal(limit("anthropic", 429, { "anthropic-ratelimit-output-tokens-remaining": "0",
    "anthropic-ratelimit-output-tokens-reset": reset }), now + 17_000);
  assert.equal(limit("anthropic", 200, { "anthropic-ratelimit-output-tokens-remaining": "0",
    "anthropic-ratelimit-output-tokens-reset": reset }), undefined);
  assert.equal(limit("anthropic", 200, { "anthropic-ratelimit-requests-remaining": "0",
    "anthropic-ratelimit-requests-reset": reset }), now + 17_000);
});

test("unrelated failures, generated output and user-supplied input cannot suspend a key", () => {
  for (const [provider, status, body] of [
    ["openai", 200, { output: [{ type: "message", error: { code: "insufficient_quota" } }] }],
    ["openai", 200, { type: { toString: "error", valueOf: "error" }, error: { code: "insufficient_quota" } }],
    ["openai", 200, { type: "response.mcp_call.failed", error: { code: "insufficient_quota" } }],
    ["openai", 403, { error: { code: "insufficient_permissions" } }],
    ["openai", 401, { error: { code: "incorrect_api_key" } }],
    ["openai", 503, { error: { code: "server_is_overloaded" } }],
    ["anthropic", 529, { type: "error", error: { type: "overloaded_error" } }],
    ["anthropic", 400, { type: "error", error: { type: "invalid_request_error",
      message: 'Unknown model "Your credit balance is too low to access the Anthropic API."' } }],
  ]) assert.equal(limit(provider, status, { "retry-after": "2" }, body), undefined);
});

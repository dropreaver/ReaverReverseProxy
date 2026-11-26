import assert from "node:assert/strict";
import test from "node:test";
import { hasProviderUsage } from "../src/provider-outcome.ts";

test("usage evidence includes provider input, cache, reasoning and tool buckets even on errors", () => {
  for (const usage of [
    { input_tokens: 1, output_tokens: 0 },
    { prompt_tokens: 2 }, { completion_tokens: 4 }, { total_tokens: 1 },
    { cache_read_input_tokens: 1 }, { cache_creation_input_tokens: 1 },
    { cache_creation: { ephemeral_1h_input_tokens: 3 } },
    { completion_tokens_details: { reasoning_tokens: 1 } },
    { output_tokens_details: { thinking_tokens: 1 } },
    { server_tool_use: { web_fetch_requests: 1 } },
    { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 15 }] },
  ]) {
    assert.equal(hasProviderUsage({ error: { message: "unavailable" }, usage }), true);
    assert.equal(hasProviderUsage({ type: "response.failed", response: { usage } }), true);
    assert.equal(hasProviderUsage({ type: "message_start", message: { type: "message", usage } }), true);
  }
  assert.equal(hasProviderUsage({ error: { usage: { input_tokens: 2 } } }), true);
  assert.equal(hasProviderUsage({ type: "response.failed", response: { error: { usage: { input_tokens: 2 } } } }), true);
});

test("generated output is evidence before a provider sends final usage", () => {
  for (const packet of [
    { choices: [{ delta: { content: " " } }] },
    { choices: [{ message: { role: "assistant", refusal: "No" } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: "{" } }] } }] },
    { type: "response.output_text.delta", delta: "some" },
    { type: "response.reasoning_summary_text.done", text: "summary" },
    { type: "response.function_call_arguments.delta", delta: "{}" },
    { type: "response.output_item.added", item: { type: "function_call", name: "lookup", arguments: "" } },
    { type: "response.failed", response: { output: [{ type: "reasoning", encrypted_content: "encrypted" }] } },
    { status: "failed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "part" }] }] },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "partial" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    { type: "message", role: "assistant", content: [{ type: "redacted_thinking", data: "encrypted" }] },
  ]) assert.equal(hasProviderUsage(packet), true, JSON.stringify(packet));
});

test("empty events, untrusted data and preflight estimates provide no model usage evidence", () => {
  for (const packet of [
    { input_tokens: 500 }, { usage: { input_tokens: 0, output_tokens: 0 } },
    { usage: { iterations: [{ input: { input_tokens: 1 } }] } },
    { usage: { input_tokens: "50", completion_tokens: -10, max_output_tokens: 123, metadata: { output_tokens: 2 } } },
    { error: { message: "max_output_tokens = 50", details: { usage: { output_tokens: 23 } } } },
    { type: "response.created", response: { output: [], instructions: "Answer", input: [{ role: "user", content: "Hi" }] } },
    { type: "response.output_item.added", item: { type: "message", id: "item-1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", delta: "" },
    { choices: [{ message: { role: "user", content: "echo" } }, { delta: { role: "assistant", content: "" } }] },
    { output: [{ type: "message", role: "user", content: [{ type: "output_text", text: "echo" }] }] },
    { type: "message_start", message: { id: "msg_123", content: [], usage: { input_tokens: 0 } } },
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "message", role: "user", content: [{ type: "text", text: "echo" }] },
    { metadata: { usage: { output_tokens: 99 } }, tools: [{ type: "function", name: "lookup" }] },
    { type: "error", delta: "provider debug text" },
  ]) assert.equal(hasProviderUsage(packet), false, JSON.stringify(packet));
  assert.equal(hasProviderUsage({ usage: { input_tokens: 99 } }, "/v1/responses/input_tokens"), false);
});

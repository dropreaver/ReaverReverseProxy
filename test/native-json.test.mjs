import assert from "node:assert/strict";
import test from "node:test";
import { observeNativeJson } from "../src/native-json.ts";

async function* chunks(bytes, width) {
  for (let start = 0; start < bytes.length; start += width) yield bytes.subarray(start, start + width);
}

test("large native JSON preserves raw bytes and examines only the provider envelope", async () => {
  const toolOutput = { error: "tool error", status: "failed", text: '[{\\"테스트"}]'.repeat(40_000) };
  const prefix = '{"output":' + JSON.stringify([toolOutput]) + ',';
  for (const [suffix, expected] of [
    ['"status":"incomplete","error":null}', 0],
    ['"error":{"message":"upstream failure"}}', 1],
    ['"st\\u0061tus":"f\\u0061iled"}', 1],
    ['"type":"error"}', 1],
    ['"status":"cancelled"}', 1],
    ['"status":"canceled"}', 1],
    ['"response":{"error":null,"status":"failed"},"type":"response.completed"}', 1],
    ['"response":{"status":"failed"},"type":"message"}', 0],
    ['"status":"completed"', 1],
  ]) {
    const data = Buffer.from(prefix + suffix);
    let errors = 0;
    const raw = await Array.fromAsync(observeNativeJson(chunks(data, 4093), () => errors++));
    assert.deepEqual(Buffer.concat(raw), data);
    assert.equal(errors, expected, suffix);
  }
});

test("native JSON reports an error by the final announced byte, even before the producer signals EOF", async () => {
  const data = Buffer.from('{"error":{"message":"provider unavailable"}}');
  let errors = 0;
  const output = observeNativeJson(chunks(data, 1), () => errors++, data.length);
  for (let i = 0; i < data.length; i++) {
    assert.equal(errors, 0);
    assert.deepEqual((await output.next()).value, data.subarray(i, i + 1));
  }
  assert.equal(errors, 1);
  assert.equal((await output.next()).done, true);
  assert.equal(errors, 1);
});

test("large native replies validate nested JSON grammar, strings, numbers and UTF-8", async () => {
  const prefix = Buffer.from('{"padding":"' + "x".repeat(300_000) + '","output":');
  for (const [tail, expected] of [
    ['[1,]}', 1], ['{"oops":truue}}', 1], ['{"a":1 "b":2}}', 1], ['{"a":[false}}}', 1],
    ['["bad\\x31"]}', 1], ['["bad\\u01xx"]}', 1], ['[4.502e+,0]}', 1], ['[01]}', 1],
    [Buffer.from([34, 0xc0, 0xaf, 34, 125]), 1],
    ['{"list":[true,null,false,-12e-7777777,0.3456],"text":"\\u006f\\\"\\\\\\n"}}', 0],
    ['[1' + '5'.repeat(100_000) + 'e9]}', 0],
  ]) {
    let errors = 0;
    const body = Buffer.concat([prefix, Buffer.from(tail)]);
    const result = await Array.fromAsync(observeNativeJson(chunks(body, 1021), () => errors++, body.length));
    assert.deepEqual(Buffer.concat(result), body);
    assert.equal(errors, expected);
  }
});

test("the observer reports a provider read error before propagating it and skips caller cancellation", async () => {
  const failure = new Error("upstream socket reset");
  async function* faulty() {
    yield Buffer.from('{"output":');
    throw failure;
  }
  let errors = 0;
  const broken = observeNativeJson(faulty(), () => errors++);
  await broken.next();
  await assert.rejects(broken.next(), err => err === failure && errors === 1);

  const abandoned = observeNativeJson(faulty(), () => errors++);
  await abandoned.next();
  await abandoned.return();
  assert.equal(errors, 1);
});

test("native replies report usage even on failures and ignore usage embedded in caller data", async () => {
  for (const padding of ["", "x".repeat(270_000)]) {
    const tests = [
      ["/v1/responses", { status: "failed", usage: { input_tokens: 2 } }, true],
      ["/v1/responses", { error: { usage: { output_tokens_details: { reasoning_tokens: 5, audio_tokens: 0 } } } }, true],
      ["/v1/messages", { type: "message", usage: { cache_read_input_tokens: 42 } }, true],
      ["/v1/messages", { type: "message", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "" }] }, true],
      ["/v1/responses", { output: [{ content: [{ type: "text", text: "" }, { type: "output_text", text: "ok" },
        { type: "text", text: "" }], type: "message" }] }, true],
      ["/v1/chat/completions", { choices: [{ message: { tool_calls: [{ function: { name: "f" } }] } }] }, true],
      ["/v1/chat/completions", { choices: [{ message: { content: "no", role: "user" } }] }, false],
      ["/v1/responses", { input: [{ role: "assistant", content: "input" }], metadata: { usage: { total_tokens: 99 } },
        output: [], status: "failed", error: { message: "not generated" } }, false],
      ["/v1/messages", { type: "error", usage: { iterations: [{ input_tokens: 9 }, { input_tokens: 0 }] } }, true],
      ["/v1/messages", { type: "error", usage: { input_tokens: 0, output_tokens: 0 } }, false],
    ];
    for (const [path, payload, expected] of tests) {
      const data = Buffer.from(JSON.stringify({ padding, ...payload }));
      let signals = 0;
      const raw = await Array.fromAsync(observeNativeJson(chunks(data, 4091), () => {}, data.length, () => signals++, path));
      assert.deepEqual(Buffer.concat(raw), data);
      assert.equal(signals, Number(expected), JSON.stringify(payload));
    }
  }
});

test("a truncated or cancelled native body preserves evidence already received", async () => {
  for (const fragment of ['{"usage":{"input_tokens":4', '{"output_text":"started', '{"usage":{"input_tokens":0']) {
    for (const end of ["clean", "reset", "cancel"]) {
      const data = Buffer.from(fragment);
      let used = false;
      async function* source() { yield data; if (end === "reset") throw Error("reset"); }
      const body = observeNativeJson(source(), () => {}, data.length + 10, () => { used = true; }, "/v1/responses");
      assert.deepEqual((await body.next()).value, data);
      if (end === "reset") await assert.rejects(body.next(), /reset/);
      else if (end === "cancel") await body.return();
      else assert.equal((await body.next()).done, true);
      assert.equal(used, !fragment.endsWith(":0"), fragment + " " + end);
    }
  }
});

test("large native arrays keep output evidence until the enclosing role and type arrive", async () => {
  const content = [{ type: "output_text", text: "already used" }, { type: "unknown" }];
  for (const role of ["assistant", "user"]) {
    const payload = { metadata: { usage: { total_tokens: 99 } }, padding: "x".repeat(270_000),
      output: [{ content, role, type: "message" }] };
    const completed = Buffer.from(JSON.stringify(payload));
    for (const body of [completed, completed.subarray(0, -1)]) {
      let used = false;
      const observed = observeNativeJson(chunks(body, 4019), undefined, completed.length, () => { used = true; }, "/v1/responses");
      assert.deepEqual(Buffer.concat(await Array.fromAsync(observed)), body);
      assert.equal(used, role === "assistant");
    }
  }
});

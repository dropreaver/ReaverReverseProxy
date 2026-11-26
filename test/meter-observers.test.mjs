import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { observeNativeJson } from '../src/native-json.ts';
import { compactStream, observeNativeStream } from '../src/compact-stream.ts';
import { observeEncodedBody } from '../src/encoded-observer.ts';

const chat = '/v1/chat/completions';
const messages = '/v1/messages';

test('truncated JSON reports only counters with a delimiter, keeping the independent usage witness', async () => {
  for (const padding of ['', 'x'.repeat(260 * 1024)]) {
    for (const stop of ['eof', 'error', 'cancel']) {
      const prefix = Buffer.from('{"padding":"' + padding + '","model":"m","usage":{"input_tokens":42,"output_tokens":17');
      async function* body() { yield prefix; if (stop === 'error') throw new Error('reset'); }
      const reports = [];
      let used = false;
      const raw = observeNativeJson(body(), undefined, undefined, () => { used = true; }, messages,
        (payload, partial) => reports.push({ payload, partial }));
      assert.deepEqual((await raw.next()).value, prefix);
      if (stop === 'cancel') await raw.return();
      else if (stop === 'error') await assert.rejects(raw.next(), /reset/);
      else assert.equal((await raw.next()).done, true);
      assert.equal(used, true);
      assert.deepEqual(reports.map(({ payload, partial }) => [payload.model, payload.usage, partial]), [
        ['m', { input_tokens: 42 }, true],
      ]);
    }
  }
});

test('large compressed native JSON preserves model metadata and sums every sampling iteration', async () => {
  const iterations = Array.from({ length: 1000 }, (_, i) => ({
    type: i % 2 ? 'message' : 'compaction',
    input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3,
  }));
  iterations.push({ type: 'fallback_message', model: 'fallback', input_tokens: 2, output_tokens: 3 });
  const model = 'm' + 'o'.repeat(157);
  const source = Buffer.from(JSON.stringify({ padding: 'x'.repeat(270_000), model, type: 'message',
    usage: { iterations }, metadata: { model: 'injected', usage: { input_tokens: 99999 } } }));
  const bytes = gzipSync(source);
  const records = [];
  const raw = observeEncodedBody([bytes], 'gzip', decoded => observeNativeJson(decoded, undefined, undefined, undefined,
    messages, (payload, partial) => records.push([payload, partial])), undefined, bytes.length);
  assert.deepEqual(Buffer.concat(await Array.fromAsync(raw)), bytes);
  assert.equal(records.length, 1);
  const [[payload, partial]] = records;
  assert.equal(payload.model, model);
  assert.equal(partial, undefined);
  const rows = payload.usage.iterations;
  assert.ok(rows.length <= 4);
  assert.equal(rows.reduce((n, row) => n + row.input_tokens, 0), 1002);
  assert.equal(rows.reduce((n, row) => n + row.output_tokens, 0), 2003);
  assert.equal(rows.reduce((n, row) => n + (row.cache_read_input_tokens ?? 0), 0), 3000);
  assert.equal(rows.find(row => row.type === 'fallback_message').model, 'fallback');
  assert.equal(payload.metadata, undefined);
});

test('SSE observes a trailing usage frame already received when the client stops after answer text', async () => {
  const frames = [
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    '[DONE]',
    { choices: [], usage: { total_tokens: 999 } },
  ];
  const bytes = Buffer.from(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''));
  for (const native of [false, true]) {
    const read = [];
    const observe = payload => { if (payload.usage) read.push(payload.usage); };
    const source = (async function* () { yield bytes; })();
    const stream = native ? observeNativeStream(source, chat, undefined, undefined, observe)
      : compactStream(source, chat, {}, undefined, () => {}, observe);
    await stream.next();
    await stream.return();
    assert.deepEqual(read, [frames[1].usage]);
  }
});

test('native SSE forwards all bytes but stops interpreting the stream at DONE', async () => {
  const before = 'data: {"model":"m","choices":[]}\n\ndata: [DONE]\n\n';
  const after = 'data: {"error":{"code":"insufficient_quota"},"usage":{"total_tokens":999}}\n\n';
  for (const chunks of [[before + after], [before, after]]) {
    async function* body() { for (const chunk of chunks) yield Buffer.from(chunk); }
    let errors = 0;
    let uses = 0;
    const observed = [];
    const raw = observeNativeStream(body(), chat, () => { errors++; }, () => { uses++; }, p => observed.push(p));
    assert.equal(Buffer.concat(await Array.fromAsync(raw)).toString(), before + after);
    assert.deepEqual(observed, [{ model: 'm', choices: [] }]);
    assert.equal(errors, 0);
    assert.equal(uses, 0);
  }
});

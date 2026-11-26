import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationMeter, safeModelId } from '../src/model-meter.ts';

function snapshot(model, input_tokens, output_tokens, total_tokens, complete) {
  return { model, input_tokens, output_tokens, total_tokens, complete };
}

test('Chat JSON uses inclusive counters, including reported zeroes, and preserves authoritative totals', () => {
  const meter = new GenerationMeter('/v1/chat/completions');
  meter.observe({ model: 'gpt-model', choices: [{ message: { role: 'assistant', content: '' } }],
    usage: { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } } });
  assert.deepEqual(meter.snapshot(), snapshot('gpt-model', 0, 5, 5, true));
  const missing = new GenerationMeter('/v1/chat/completions');
  missing.observe({ choices: [], usage: { total_tokens: 9, prompt_tokens: 2.5, completion_tokens: -3 } });
  assert.deepEqual(missing.snapshot(), snapshot(undefined, null, null, 9, false));
});

test('Chat streaming snapshots are cumulative and become final on the provider usage chunk', () => {
  const meter = new GenerationMeter('/v1/chat/completions');
  meter.observe({ object: 'chat.completion.chunk', model: 'snapshot-1', choices: [{ delta: { role: 'assistant' } }],
    usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 } });
  assert.deepEqual(meter.snapshot(), snapshot('snapshot-1', 30, 2, 32, false));
  const final = { choices: [], usage: { completion_tokens: 6 } };
  meter.observe(final);
  meter.observe(final);
  assert.deepEqual(meter.snapshot(), snapshot('snapshot-1', 30, 6, 36, true));
});

test('Responses snapshots support metered failures and incomplete terminal statuses', () => {
  const meter = new GenerationMeter('/v1/responses');
  meter.observe({ type: 'response.created', response: { model: 'gpt-real', usage: { input_tokens: 30, output_tokens: 1 } } });
  assert.deepEqual(meter.snapshot(), snapshot('gpt-real', 30, 1, 31, false));
  meter.observe({ type: 'response.failed', response: { error: { usage: { input_tokens: 30, output_tokens: 3 } } } });
  assert.deepEqual(meter.snapshot(), snapshot('gpt-real', 30, 3, 33, true));
  const limited = new GenerationMeter('/v1/responses');
  limited.observe({ model: 'gpt-real', status: 'incomplete', usage: { input_tokens: 10, output_tokens: 20 } });
  assert.deepEqual(limited.snapshot(), snapshot('gpt-real', 10, 20, 30, true));
  const queued = new GenerationMeter('/v1/responses');
  queued.observe({ status: 'queued', usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(queued.snapshot().complete, false);
});

test('Claude opening and cumulative deltas merge cache buckets once, and interruption preserves known progress', () => {
  const makeStart = () => ({ type: 'message_start', message: { model: 'claude-real', usage: {
    input_tokens: 4, cache_read_input_tokens: 9, cache_creation_input_tokens: 1, output_tokens: 1 } } });
  const meter = new GenerationMeter('/v1/messages');
  meter.observe(makeStart());
  meter.observe({ type: 'message_delta', delta: {}, usage: { output_tokens: 2 } });
  assert.deepEqual(meter.snapshot(), snapshot('claude-real', 14, 2, 16, false));
  meter.observe({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: null, output_tokens: 8 } });
  meter.observe({ type: 'message_stop' });
  assert.deepEqual(meter.snapshot(), snapshot('claude-real', 14, 8, 22, true));
  const broken = new GenerationMeter('/v1/messages');
  broken.observe(makeStart());
  broken.observe({ type: 'message_stop' });
  assert.deepEqual(broken.snapshot(), snapshot('claude-real', 14, 1, 15, false));
});

test('Claude compaction and ordinary iterations include all reported usage without double-counting top-level counters', () => {
  const meter = new GenerationMeter('/v1/messages');
  meter.observe({ type: 'message', model: 'claude-serving', usage: { input_tokens: 10, output_tokens: 4, iterations: [
    { type: 'compaction', input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 1 },
    { type: 'message', input_tokens: 4, output_tokens: 2 }, { type: 'message', input_tokens: 6, output_tokens: 2 },
  ] } });
  assert.deepEqual(meter.snapshot(), snapshot('claude-serving', 41, 7, 48, true));
  const stream = new GenerationMeter('/v1/messages');
  stream.observe({ type: 'message_start', message: { model: 'claude-original', usage: { input_tokens: 5, output_tokens: 1,
    iterations: [{ type: 'compaction', input_tokens: 30, output_tokens: 3 }, { type: 'message', input_tokens: 5, output_tokens: 1 }] } } });
  stream.observe({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
  assert.deepEqual(stream.snapshot(), snapshot('claude-original', 35, 8, 43, true));
  const incomplete = new GenerationMeter('/v1/messages');
  incomplete.observe({ type: 'message', usage: { iterations: [
    { type: 'message', input_tokens: 6, output_tokens: 2 },
    { type: 'fallback_message', model: 'claude-fallback', cache_read_input_tokens: 10 },
  ] } });
  assert.deepEqual(incomplete.snapshot(), snapshot('claude-fallback', 16, 2, 18, false));
});

test('Incomplete JSON, totals-only errors, and Claude cache-only fragments keep known dimensions', () => {
  const meter = new GenerationMeter('/v1/responses');
  meter.observe({ error: { usage: { total_tokens: 15 } } });
  assert.deepEqual(meter.snapshot(), snapshot(undefined, null, null, 15, false));
  meter.observe({ usage: { input_tokens: 5, output_tokens: 10 } }, true);
  assert.deepEqual(meter.snapshot(), snapshot(undefined, 5, 10, 15, false));
  const claude = new GenerationMeter('/v1/messages');
  claude.observe({ type: 'error', error: { usage: { cache_read_input_tokens: 8 } } });
  assert.deepEqual(claude.snapshot(), snapshot(undefined, 8, null, null, false));
});

test('Meter never traverses arbitrary tool arguments, request metadata, or input-count responses', () => {
  const spoof = { model: 'fake', usage: { input_tokens: 99, output_tokens: 1 } };
  const meter = new GenerationMeter('/v1/responses');
  meter.observe({ input: spoof, metadata: spoof, error: { details: spoof }, output: [{ arguments: spoof }] });
  meter.observe({ type: 'response.output_item.added', item: spoof, response: spoof });
  assert.deepEqual(meter.snapshot(), snapshot(undefined, null, null, null, false));
  const count = new GenerationMeter('/v1/messages/count_tokens');
  count.observe(spoof);
  assert.deepEqual(count.snapshot(), snapshot(undefined, null, null, null, false));
  for (const value of ['sk-private', 'rk-secret', 'api_key-secret', ' model', 'x'.repeat(161), 'name\ncontrol']) {
    assert.equal(safeModelId(value), undefined);
  }
});

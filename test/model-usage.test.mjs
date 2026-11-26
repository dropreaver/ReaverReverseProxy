import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsage } from '../src/model-usage.ts';

const known = { input_tokens: 4, output_tokens: 3, total_tokens: 7, complete: true };
const missing = { input_tokens: null, output_tokens: null, total_tokens: null, complete: false };

test('model usage keeps unknown fields separate from zero and aggregates known counts once per request', () => {
  const ledger = new ModelUsage();
  ledger.record(0, 'openai', 'm', missing);
  ledger.record(0, 'openai', 'm', { ...missing, input_tokens: 0 });
  assert.deepEqual(ledger.report(0).data, [{ provider: 'openai', model: 'm', requests: 2,
    incomplete_requests: 2, input_tokens: 0, output_tokens: null, total_tokens: null }]);

  ledger.record(0, 'openai', 'm', { ...missing, input_tokens: 5, output_tokens: 1, total_tokens: 6 });
  ledger.record(0, 'openai', 'm', known);
  assert.deepEqual(ledger.report(0).data, [{ provider: 'openai', model: 'm', requests: 4,
    incomplete_requests: 3, input_tokens: 9, output_tokens: 4, total_tokens: 13 }]);
});

test('reports isolate proxy tokens and providers, with a stable reporting start and independent snapshots', () => {
  const ledger = new ModelUsage();
  const { since, data } = ledger.report(1);
  assert.deepEqual(data, []);
  assert.equal(new Date(since).toISOString(), since);
  ledger.record(1, 'openai', 'z', known);
  ledger.record(1, 'openai', 'm', known);
  ledger.record(1, 'anthropic', 'm', missing);
  ledger.record(3, 'anthropic', 'other', known);
  const result = ledger.report(1);
  assert.equal(result.since, since);
  assert.deepEqual(result.data.map(row => [row.provider, row.model]), [
    ['anthropic', 'm'], ['openai', 'm'], ['openai', 'z'],
  ]);
  assert.deepEqual(ledger.report(3).data.map(row => row.model), ['other']);
  result.data[0].requests = 77;
  assert.equal(ledger.report(1).data[0].requests, 1);
  assert.deepEqual(ledger.report(2), { since, data: [] });
});

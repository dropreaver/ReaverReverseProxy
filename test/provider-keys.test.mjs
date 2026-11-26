import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderKeys } from '../src/provider-keys.ts';

test('rotation skips only exhausted credentials and preserves the configured lists and order', () => {
  const config = {
    openai: Object.freeze(['a', 'b', 'c']),
    anthropic: Object.freeze(['a', 'd']),
  };
  const pool = new ProviderKeys(config);
  assert.deepEqual(pool.select('openai'), { status: 'ready', key: 'a' });
  pool.suppress('openai', 'a', Infinity);
  pool.suppress('openai', 'c', Infinity);
  assert.deepEqual(pool.peek('anthropic'), { status: 'ready', key: 'a' });
  assert.deepEqual(pool.peek('anthropic'), { status: 'ready', key: 'a' });
  assert.equal(pool.select('anthropic').key, 'a');
  assert.equal(pool.select('openai').key, 'b');
  assert.equal(pool.select('anthropic').key, 'd');
  assert.equal(pool.select('openai').key, 'b');
  assert.deepEqual(config.openai, ['a', 'b', 'c']);
  assert.deepEqual(new ProviderKeys(config).select('openai'), { status: 'ready', key: 'a' });
});

test('overlapping deadlines keep the strongest signal and report the earliest available retry', t => {
  let now = 50_000;
  t.mock.method(Date, 'now', () => now);
  const pool = new ProviderKeys({ openai: ['a', 'b', 'c'], anthropic: [] });
  pool.suppress('openai', 'a', Infinity);
  pool.suppress('openai', 'a', now + 100);
  pool.suppress('openai', 'b', now + 3_300);
  pool.suppress('openai', 'b', now + 300);
  pool.suppress('openai', 'c', now + 1_201);
  pool.suppress('openai', 'c', now + 2_001);
  assert.deepEqual(pool.select('openai'), { status: 'exhausted', retryAfterSeconds: 3 });
  now += 2_000;
  assert.deepEqual(pool.peek('openai'), { status: 'exhausted', retryAfterSeconds: 1 });
  now++;
  assert.deepEqual(pool.select('openai'), { status: 'ready', key: 'c' });
  now += 1_299;
  assert.equal(pool.select('openai').key, 'b');
  assert.equal(pool.select('openai').key, 'c');
  pool.suppress('openai', 'b', Infinity);
  pool.suppress('openai', 'c', Infinity);
  assert.deepEqual(pool.select('openai'), { status: 'exhausted' });
  assert.deepEqual(pool.select('anthropic'), { status: 'unconfigured' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/catalog.ts';
import { ProviderKeys } from '../src/provider-keys.ts';

test('catalog refresh selects one key for all pages and all waiting readers', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const keys = ['catalog-first', 'catalog-second'];
  const pool = new ProviderKeys({ openai: [], anthropic: keys });
  const selection = t.mock.method(pool, 'select');
  const getCatalog = createCatalog(['anthropic'], pool);
  const seen = [];
  const firstPage = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    seen.push([url.searchParams.get('after_id'), headers['x-api-key']]);
    if (seen.length === 1) await firstPage.promise;
    const page = url.searchParams.has('after_id')
      ? { data: [{ id: 'model-2' }], has_more: false }
      : { data: [{ id: 'model-1' }], has_more: true };
    return Response.json(page);
  });

  const controller = new AbortController();
  const abandoned = getCatalog(controller.signal);
  const completed = getCatalog();
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  firstPage.resolve();
  const fresh = await completed;
  assert.deepEqual(fresh.body.data.map(item => item.id), ['model-1', 'model-2']);
  assert.deepEqual(fresh.body.providers, { anthropic: 'fresh' });
  assert.deepEqual(await getCatalog(), fresh);
  assert.equal(selection.mock.callCount(), 1);
  assert.deepEqual(seen, [[null, keys[0]], ['model-1', keys[0]]]);

  now += 60_000;
  await getCatalog();
  assert.equal(selection.mock.callCount(), 2);
  assert.deepEqual(seen.slice(2), [[null, keys[1]], ['model-1', keys[1]]]);
});

test('catalog cache is private to each gateway and discards revoked access', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let fail = 0;
  const selected = [];
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    const key = headers.authorization.slice('Bearer '.length);
    selected.push(key);
    if (key === 'other') return Response.json({ data: [{ id: 'other-model' }] });
    return fail ? Response.json({}, { status: fail }) : Response.json({ data: [{ id: 'first-model' }] });
  });
  const primary = createCatalog(['openai'], new ProviderKeys({ openai: ['primary'], anthropic: [] }));
  const other = createCatalog(['openai'], new ProviderKeys({ openai: ['other'], anthropic: [] }));
  assert.equal((await primary()).body.data[0].id, 'first-model');
  assert.equal((await other()).body.data[0].id, 'other-model');
  assert.equal((await primary()).body.data[0].id, 'first-model');
  assert.deepEqual(selected, ['primary', 'other']);

  now += 60_000;
  fail = 503;
  const stale = await primary();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.partial, true);
  assert.equal(stale.body.providers.openai, 'stale');
  assert.equal(stale.body.data[0].id, 'first-model');
  await primary();
  assert.equal(selected.length, 3);

  now += 5_000;
  fail = 403;
  const revoked = await primary();
  assert.equal(revoked.status, 502);
  assert.equal(revoked.body.providers.openai, 'unavailable');
  assert.equal(revoked.body.data, undefined);
  assert.equal((await other()).body.data[0].id, 'other-model');
});

test('a limit during pagination suppresses the selected key and lets the next caller refresh', async t => {
  const pool = new ProviderKeys({ openai: ['first', 'second'], anthropic: [] });
  const getCatalog = createCatalog(['openai'], pool);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    const key = headers.authorization;
    sent.push([key, url.searchParams.get('after')]);
    if (key === 'Bearer second') return Response.json({ data: [{ id: 'result' }] });
    if (!url.searchParams.has('after')) return Response.json({ data: [{ id: 'partial-page' }], has_more: true });
    return Response.json({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 });
  });
  const limited = await getCatalog();
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterSeconds, undefined);
  assert.deepEqual(sent, [['Bearer first', null], ['Bearer first', 'partial-page']]);
  const fresh = await getCatalog();
  assert.deepEqual(fresh.body.data.map(m => m.id), ['result']);
  assert.deepEqual(sent.at(-1), ['Bearer second', null]);
  assert.deepEqual(pool.select('openai'), { status: 'ready', key: 'second' });
});

test('exhausted providers skip upstream catalog calls until a temporary key becomes eligible', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pool = new ProviderKeys({ openai: ['out-of-credit'], anthropic: ['rate-limited'] });
  pool.suppress('openai', 'out-of-credit', Infinity);
  pool.suppress('anthropic', 'rate-limited', now + 12_000);
  const getCatalog = createCatalog(['openai', 'anthropic'], pool);
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(url.hostname);
    return Response.json({ data: [{ id: 'claude' }] });
  });

  const limited = await getCatalog();
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterSeconds, 12);
  now += 10_000;
  assert.equal((await getCatalog()).retryAfterSeconds, 2);
  assert.deepEqual(paths, []);
  now += 2_000;
  const partial = await getCatalog();
  assert.equal(partial.status, 200);
  assert.equal(partial.body.partial, true);
  assert.deepEqual(partial.body.providers, { openai: 'unavailable', anthropic: 'fresh' });
  assert.deepEqual(paths, ['api.anthropic.com']);
});

test('catalog refresh handles both an exhausted successful page and a quota error envelope', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pool = new ProviderKeys({ openai: ['window', 'credit'], anthropic: [] });
  const getCatalog = createCatalog(['openai'], pool);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    calls.push([headers.authorization, url.searchParams.get('after')]);
    if (calls.length === 1) return Response.json({ data: [{ id: 'p1' }], has_more: true },
      { headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '3s' } });
    if (calls.length === 2) return Response.json({ error: { code: 'insufficient_quota' } });
    return Response.json({ data: [{ id: 'fresh' }] });
  });
  assert.equal((await getCatalog()).status, 429);
  assert.deepEqual(calls, [['Bearer window', null]]);
  assert.equal((await getCatalog()).retryAfterSeconds, 3);
  now += 3_000;
  assert.equal((await getCatalog()).body.providers.openai, 'fresh');
  assert.deepEqual(calls, [['Bearer window', null], ['Bearer credit', null], ['Bearer window', null]]);
});

test('cached and stale catalog data remain readable after all configured keys are exhausted', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pool = new ProviderKeys({ openai: ['primary'], anthropic: [] });
  const getCatalog = createCatalog(['openai'], pool);
  const call = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'known' }] }));
  assert.equal((await getCatalog()).body.providers.openai, 'fresh');
  pool.suppress('openai', 'primary', Infinity);
  assert.equal((await getCatalog()).body.providers.openai, 'fresh');
  now += 60_000;
  const stale = await getCatalog();
  assert.equal(stale.body.providers.openai, 'stale');
  assert.equal(stale.body.data[0].id, 'known');
  now += 15 * 60_000;
  const expired = await getCatalog();
  assert.equal(expired.status, 429);
  assert.equal(expired.retryAfterSeconds, undefined);
  assert.equal(call.mock.callCount(), 1);
});

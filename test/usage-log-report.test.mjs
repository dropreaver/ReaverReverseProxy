import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { usageReport } from '../scripts/model-usage.mjs';

const now = Date.UTC(2026, 10, 26, 5);
const since = '2026-11-19T05:00:00.000Z';
const until = '2026-11-26T05:00:00.000Z';
const first = { id: '00000000-0000-4000-8000-000000000001', provider: 'openai', model: 'snapshot',
  generation_counted: true, token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, complete: true } };
const second = { ...first, id: '00000000-0000-4000-8000-000000000002',
  token_usage: { input_tokens: 7, output_tokens: null, total_tokens: null, complete: false } };
const expected = [{ provider: 'openai', model: 'snapshot', requests: 2, input_tokens: 10,
  output_tokens: 2, total_tokens: 5, incomplete_requests: 1 }];

test('piped app JSON and Dashboard lines share one report and count each generation once', async () => {
  const lines = [JSON.stringify(first), 'Nov 25 02:05:13 [abc] ' + JSON.stringify(second), JSON.stringify(first),
    'regular log line', JSON.stringify({ ...first, token_usage: undefined }),
    JSON.stringify({ ...second, generation_counted: false }), '{"token_usage": ',
    JSON.stringify({ ...first, token_usage: { ...first.token_usage, total_tokens: -10 } }),
    JSON.stringify({ ...second, model: 'sk-api-credential' })];
  const result = await usageReport(['--stdin'], { input: Readable.from([lines.join('\r\n')]), env: {},
    fetchImpl: () => assert.fail('stdin does not need Render access') });
  assert.deepEqual(result, { source: 'stdin', since: null, until: null, skipped_usage_lines: 3, data: expected });
});

test('Render fetch uses the service owner, covers seven days, and deduplicates overlapping pages', async () => {
  const urls = [];
  const cursor = '2026-11-21T08:01:02.123456Z';
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer server-token');
    assert.equal(options.redirect, 'error');
    urls.push(new URL(url));
    if (urls.length === 1) return Response.json({ ownerId: 'tea-owner' });
    if (urls.length === 2) return Response.json({ hasMore: true, nextStartTime: cursor, nextEndTime: until,
      logs: [{ message: JSON.stringify(first) }] });
    assert.equal(urls.length, 3);
    return Response.json({ hasMore: false, logs: [{ message: JSON.stringify(first) }, { message: JSON.stringify(second) }] });
  };
  const result = await usageReport([], { now, env: { RENDER_API_KEY: 'server-token', RENDER_SERVICE_ID: 'srv-example' }, fetchImpl });
  assert.deepEqual(result, { source: 'render_logs', since, until, skipped_usage_lines: 0, data: expected });
  assert.equal(urls[0].pathname, '/v1/services/srv-example');
  assert.deepEqual(Object.fromEntries(urls[1].searchParams), { ownerId: 'tea-owner', resource: 'srv-example',
    type: 'app', text: 'token_usage', direction: 'forward', limit: '100', startTime: since, endTime: until });
  assert.equal(urls[2].searchParams.get('startTime'), cursor);
  assert.equal(urls[2].searchParams.get('endTime'), until);
});

test('explicit owner skips the service lookup, service flag overrides the environment, and rate limits can recover', async () => {
  let calls = 0;
  const result = await usageReport(['--render', '--service', 'srv-override'], {
    now, env: { RENDER_API_KEY: 'key', RENDER_OWNER_ID: 'tea-given', RENDER_SERVICE_ID: 'srv-env' },
    fetchImpl: async url => {
      calls++;
      assert.equal(url.pathname, '/v1/logs');
      assert.equal(url.searchParams.get('ownerId'), 'tea-given');
      assert.equal(url.searchParams.get('resource'), 'srv-override');
      if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      return Response.json({ hasMore: false, logs: [] });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.data, []);
});

test('API errors, malformed pages, and broken pagination fail without returning partial reports or response contents', async () => {
  const env = { RENDER_API_KEY: 'secret', RENDER_OWNER_ID: 'tea-given', RENDER_SERVICE_ID: 'srv-example' };
  const firstPage = { hasMore: true, nextStartTime: '2026-11-20T00:00:00Z', nextEndTime: until,
    logs: [{ message: JSON.stringify(first) }] };
  for (const [badPage, message] of [
    [new Response('private Render error', { status: 403 }), 'Render API returned HTTP 403.'],
    [Response.json(firstPage), 'Render returned a repeated log page cursor.'],
    [Response.json({ hasMore: true, logs: [] }), 'Render did not provide the next log page.'],
    [Response.json({ hasMore: false, logs: [{ log: 'private' }] }), 'Render returned an invalid log entry.'],
  ]) {
    let calls = 0;
    await assert.rejects(usageReport([], { now, env, fetchImpl: async () => ++calls === 1 ? Response.json(firstPage) : badPage }),
      { message });
    assert.equal(calls, 2);
  }
  await assert.rejects(usageReport(['--render'], { env: {} }), /RENDER_API_KEY/);
  await assert.rejects(usageReport(['--render'], { env: { RENDER_API_KEY: 'key' },
    fetchImpl: () => assert.fail('A missing service ID must fail before querying Render') }), /--service ID or set RENDER_SERVICE_ID/);
});

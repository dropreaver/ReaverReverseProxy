import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readConfig } from '../src/access.ts';
import { createGateway } from '../src/server.ts';

const reportPath = '/v1/usage/models';
const chat = '/v1/chat/completions';
const messages = '/anthropic/v1/messages';

test('model usage reports isolate credentials, group served aliases and count each metered request once', async t => {
  const outcomes = [];
  const requestLogs = [];
  t.mock.method(console, 'info', line => requestLogs.push(JSON.parse(line)));
  const provider = http.createServer((req, res) => {
    if (req.url.endsWith('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 23 }));
    }
    const { status = 200, json, events } = outcomes.shift();
    res.writeHead(status, { 'content-type': events ? 'text/event-stream' : 'application/json' });
    res.end(events ? events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') : JSON.stringify(json));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => provider.close());
  const redirected = t.mock.method(https, 'request', (options, callback) =>
    http.request({ ...options, hostname: '127.0.0.1', port: provider.address().port }, callback));
  syncBuiltinESMExports();
  t.after(() => { redirected.mock.restore(); syncBuiltinESMExports(); });

  const proxy = createGateway(readConfig({ OPENAI_API_KEY: 'openai-private', ANTHROPIC_API_KEY: 'claude-private',
    PROXY_TOKENS: 'first-private,second-private', REQUESTS_PER_MINUTE: '5' }));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const base = 'http://127.0.0.1:' + proxy.address().port;
  const headers = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
  async function send(path, model, reply, token = 'first-private') {
    outcomes.push(reply);
    const res = await fetch(base + path, { method: 'POST', headers: headers(token),
      body: JSON.stringify({ model, stream: !!reply.events, messages: [{ role: 'user', content: 'private-user-message' }] }) });
    await res.text();
    assert.equal(res.status, reply.status ?? 200);
  }
  const report = async token => {
    const res = await fetch(base + reportPath, {headers: headers(token)});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    return res.json();
  };
  assert.equal((await fetch(base + reportPath)).status, 401);
  assert.deepEqual((await report('first-private')).data, []);

  const served = 'served-version';
  const answer = { choices: [{ index: 0, message: { role: 'assistant', content: 'private-answer' }, finish_reason: 'stop' }] };
  await send(chat, 'alias-one', { json: { ...answer, model: served,
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } });
  await send('/openai' + chat, 'alias-two', { status: 400, json: { model: served, error: { message: 'error' },
    usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } } });
  await send(chat, 'alias-three', { json: { ...answer, model: served } });
  await send(chat, 'unused', { status: 400, json: { error: { message: 'free failure' } } });
  await send(messages, 'claude-alias', { events: [
    { type: 'message_start', message: { model: served, usage: { input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ] });
  await send(chat, 'fallback-alias', { json: { ...answer, usage: { prompt_tokens: 2, completion_tokens: 1 } } }, 'second-private');

  assert.deepEqual((await report('first-private')).data, [
    { provider: 'anthropic', model: served, requests: 1, input_tokens: 12, output_tokens: 4, total_tokens: 16, incomplete_requests: 0 },
    { provider: 'openai', model: served, requests: 3, input_tokens: 9, output_tokens: 3, total_tokens: 12, incomplete_requests: 1 },
  ]);
  assert.deepEqual((await report('second-private')).data, [
    { provider: 'openai', model: 'fallback-alias', requests: 1, input_tokens: 2, output_tokens: 1, total_tokens: 3, incomplete_requests: 0 },
  ]);
  const records = requestLogs.filter(entry => entry.token_usage);
  assert.equal(records.length, 5);
  assert(records.every(entry => entry.generation_counted && entry.id && entry.model && entry.provider));
  assert.equal(requestLogs.filter(entry => entry.generation_counted === false).length, 1);
  assert.doesNotMatch(JSON.stringify(requestLogs), /private|alias-one|alias-two/);
  assert.equal(outcomes.length, 0);
});

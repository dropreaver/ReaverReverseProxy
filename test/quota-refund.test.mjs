import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { readConfig } from '../src/access.ts';
import { createGateway } from '../src/server.ts';
import { compactStream, observeNativeStream } from '../src/compact-stream.ts';

const chat = '/v1/chat/completions';
const responses = '/v1/responses';
const messages = '/v1/messages';
const messageBody = { messages: [{ role: 'user', content: 'hello' }] };
const chatReply = { choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }] };
const providerError = { type: 'overloaded_error', message: 'Synthetic provider failure' };

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function gateway(t, upstream, rpm = 1, env = {}) {
  const vendor = http.createServer(upstream);
  vendor.listen(0, '127.0.0.1');
  await once(vendor, 'listening');
  t.after(() => vendor.close());
  const redirect = t.mock.method(https, 'request', (options, callback) =>
    http.request({ ...options, hostname: '127.0.0.1', port: vendor.address().port }, callback));
  syncBuiltinESMExports();
  t.after(() => { redirect.mock.restore(); syncBuiltinESMExports(); });

  const proxy = createGateway(readConfig({
    OPENAI_API_KEY: 'openai-a,openai-b', ANTHROPIC_API_KEY: 'claude-a,claude-b',
    PROXY_TOKENS: 'client-fixture', REQUESTS_PER_MINUTE: String(rpm), ...env,
  }));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  return async (path = chat, extra = {}, signal) => {
    const body = path.includes(responses) ? { input: 'hello' } : messageBody;
    return fetch('http://127.0.0.1:' + proxy.address().port + path, {
      method: 'POST',
      signal,
      headers: { authorization: 'Bearer client-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', ...body, ...extra }),
    });
  };
}

async function expectStatus(promise, status) {
  const reply = await promise;
  const wire = await reply.text();
  assert.equal(reply.status, status, wire);
  return wire;
}

function clock(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return () => { now += 60_001; };
}

test('provider HTTP, connection and preflight errors leave the next generation available', async t => {
  let countCalls = 0;
  let generationCalls = 0;
  const post = await gateway(t, (req, res) => {
    if (req.url === messages + '/count_tokens') {
      countCalls++;
      return json(res, 503, { error: providerError });
    }
    generationCalls++;
    if (generationCalls === 1) return json(res, 429, { error: providerError });
    if (generationCalls === 2) return req.socket.destroy();
    if (generationCalls === 3) return json(res, 403, { error: { code: 'insufficient_permissions' } });
    json(res, 200, chatReply);
  });
  await expectStatus(post(messages), 502);
  await expectStatus(post(), 429);
  await expectStatus(post(), 502);
  await expectStatus(post(), 403);
  await expectStatus(post(), 200);
  assert.match(await expectStatus(post(), 429), /Proxy request limit/);
  assert.equal(countCalls, 1);
  assert.equal(generationCalls, 4);
});

test('a token estimate above the input cap never starts a generation or consumes a slot', async t => {
  const paths = [];
  const post = await gateway(t, (req, res) => {
    paths.push(req.url);
    json(res, 200, req.url === messages + '/count_tokens' ? { input_tokens: 100_001 } : chatReply);
  });
  await expectStatus(post(messages), 413);
  await expectStatus(post(), 200);
  await expectStatus(post(), 429);
  assert.deepEqual(paths, [messages + '/count_tokens', chat]);
});

test('unmetered Responses API errors are free on both paths and token-limited output counts', async t => {
  let generated = 0;
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('/input_tokens')) return json(res, 200, { input_tokens: 2 });
    generated++;
    const response = generated <= 2 ? { status: 'failed', error: { code: 'server_error', message: providerError.message } }
      : { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' }, output_text: 'some output' };
    json(res, 200, { model: 'test-model', object: 'response', ...response });
  });
  for (const path of [responses, '/openai' + responses]) {
    const data = JSON.parse(await expectStatus(post(path), 200));
    assert.equal(data.status, 'failed');
  }
  const partial = JSON.parse(await expectStatus(post(responses), 200));
  assert.equal(partial.incomplete_details.reason, 'max_output_tokens');
  await expectStatus(post(), 429);
  assert.equal(generated, 3);
});

function event(type, payload) {
  return (type ? 'event: ' + type + '\r\n' : '') + 'data: ' + JSON.stringify(payload) + '\r\n\r\n';
}

const openaiQuotaError = { code: 'insufficient_quota', message: 'Synthetic exhausted account.' };
const claudeQuotaError = { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' };
const exhaustedPoolMessage = 'All configured keys for this provider have reached a usage limit.';

test('quota errors in compact and native model replies suppress the selected credential', async t => {
  for (const [path, nativePrefix, first, second] of [
    [chat, '/openai', 'Bearer openai-a', 'Bearer openai-b'],
    [responses, '/openai', 'Bearer openai-a', 'Bearer openai-b'],
    [messages, '/anthropic', 'claude-a', 'claude-b'],
  ]) {
    for (const stream of [false, true]) {
      for (const prefix of ['', nativePrefix]) {
        await t.test((stream ? 'SSE ' : 'JSON ') + prefix + path, async t => {
          const nextMinute = clock(t);
          const calls = [];
          const post = await gateway(t, (req, res) => {
            if (req.url.endsWith('_tokens')) return json(res, 200, { input_tokens: 2 });
            calls.push(req.headers['x-api-key'] ?? req.headers.authorization);
            if (calls.length > 1) return json(res, 200, path === messages
              ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
              : path === responses ? { status: 'completed', output_text: 'answer' } : chatReply);
            const error = path === messages ? claudeQuotaError : openaiQuotaError;
            if (!stream) return json(res, 200, path === responses ? { status: 'failed', error }
              : path === messages ? { type: 'error', error } : { error });
            // The in-progress generation already used tokens before the quota error.
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            if (path === responses) {
              res.write(event('response.output_text.delta', { type: 'response.output_text.delta', delta: 'partial' }));
              return res.end(event('response.failed', { type: 'response.failed', response: { status: 'failed', error } }));
            }
            if (path === messages) {
              res.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }));
              return res.end(event('error', { type: 'error', error }));
            }
            res.write(event('', { choices: [{ index: 0, delta: { content: 'partial' } }] }));
            res.end(event('', { error }) + 'data: [DONE]\n\n');
          });
          const wire = await expectStatus(post(prefix + path, { stream }), 200);
          assert.match(wire, path === messages ? /credit balance is too low/ : /insufficient_quota/);
          assert.deepEqual(calls, [first]);
          if (stream) {
            assert.match(await expectStatus(post(prefix + path), 429), /Proxy request limit/);
            nextMinute();
          }
          await expectStatus(post(prefix + path), 200);
          nextMinute();
          await expectStatus(post(prefix + path), 200);
          assert.deepEqual(calls, [first, second, second]);
        });
      }
    }
  }
});

test('hard quota during preflight blocks only that provider and stops before generation', async t => {
  const calls = [];
  const post = await gateway(t, (req, res) => {
    calls.push(req.url);
    if (req.url === messages + '/count_tokens') return json(res, 400, { type: 'error', error: claudeQuotaError });
    return json(res, 200, chatReply);
  }, 3, { ANTHROPIC_API_KEY: 'only-claude-key' });
  await expectStatus(post(messages), 400);
  assert.deepEqual(calls, [messages + '/count_tokens']);
  const blocked = await post('/anthropic' + messages);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), null);
  assert.equal((await blocked.json()).error.message, exhaustedPoolMessage);
  await expectStatus(post(chat), 200);
  assert.deepEqual(calls, [messages + '/count_tokens', chat]);
});

test('a successful preflight can deplete a key for later requests while the current generation keeps it', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const post = await gateway(t, (req, res) => {
    calls.push([req.url, req.headers.authorization]);
    if (req.url.endsWith('/input_tokens')) {
      if (calls.length === 1) {
        res.setHeader('x-ratelimit-remaining-requests', '0');
        res.setHeader('x-ratelimit-reset-requests', '5s');
      }
      return json(res, 200, { input_tokens: 2 });
    }
    json(res, 200, req.url === responses ? { status: 'completed', output_text: 'answer' } : chatReply);
  }, 5);
  await expectStatus(post(responses), 200);
  await expectStatus(post(), 200);
  await expectStatus(post(), 200);
  now += 5_000;
  await expectStatus(post(), 200);
  assert.deepEqual(calls, [
    [responses + '/input_tokens', 'Bearer openai-a'], [responses, 'Bearer openai-a'],
    [chat, 'Bearer openai-b'], [chat, 'Bearer openai-b'], [chat, 'Bearer openai-a'],
  ]);
});

test('all cooling keys return the remaining retry interval without contacting the provider', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const post = await gateway(t, (req, res) => {
    calls.push(req.headers.authorization);
    if (calls.length > 2) return json(res, 200, chatReply);
    res.setHeader('retry-after', calls.length === 1 ? '20' : '5');
    return json(res, 429, { error: { type: 'rate_limit_error', message: 'Try again later' } });
  });
  await expectStatus(post(), 429);
  await expectStatus(post(), 429);
  now += 2_001;
  const blocked = await post();
  assert.equal(blocked.headers.get('retry-after'), '3');
  assert.equal((await blocked.json()).error.message, exhaustedPoolMessage);
  assert.deepEqual(calls, ['Bearer openai-a', 'Bearer openai-b']);
  now += 2_999;
  await expectStatus(post(), 200);
  assert.deepEqual(calls, ['Bearer openai-a', 'Bearer openai-b', 'Bearer openai-b']);
});

test('ordinary failed requests and generated text quoting quota errors keep both keys in rotation', async t => {
  const calls = [];
  const post = await gateway(t, (req, res) => {
    calls.push(req.headers.authorization);
    if (calls.length === 1) return json(res, 400, { error: {
      type: 'invalid_request_error', message: 'Unknown model: insufficient_quota',
    } });
    return json(res, 200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({ error: openaiQuotaError }) } }],
      metadata: { error: openaiQuotaError } });
  }, 4);
  await expectStatus(post(), 400);
  for (let i = 0; i < 3; i++) await expectStatus(post(), 200);
  assert.deepEqual(calls, ['Bearer openai-a', 'Bearer openai-b', 'Bearer openai-a', 'Bearer openai-b']);
});

test('HTTP errors with input-only usage count once, including sanitized credential errors', async t => {
  const nextMinute = clock(t);
  const privateMessage = 'synthetic credential details';
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('_tokens')) return json(res, 200, { input_tokens: 11 });
    const [path, query] = req.url.split('?');
    if (!query) return json(res, 200, chatReply);
    const options = new URLSearchParams(query);
    const status = Number(options.get('status'));
    const input = Number(options.get('input'));
    const usage = path === chat ? { prompt_tokens: input, completion_tokens: 0 } : { input_tokens: input, output_tokens: 0 };
    const error = { code: 'insufficient_permissions', message: privateMessage };
    json(res, status, { error, usage, ...(path === responses ? { status: 'failed' } : {}) });
  });
  for (const [path, status] of [[responses, 200], ['/openai' + responses, 200], [chat, 429],
    ['/openai' + chat, 500], [messages, 401], ['/anthropic' + messages, 403]]) {
    for (const input of [0, 9]) {
      const body = await expectStatus(post(path + '?status=' + status + '&input=' + input), status);
      if (status === 401 || status === 403) {
        assert.ok(!body.includes(privateMessage));
        assert.match(body, /provider credential/);
      } else assert.match(body, /synthetic credential details/);
    }
    assert.match(await expectStatus(post(), 429), /Proxy request limit/);
    nextMinute();
  }
});

test('compact errors remain readable and refusals count only with evidence of usage', async t => {
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('/count_tokens')) return json(res, 200, { input_tokens: 2 });
    if (req.url.includes('?refusal')) {
      const usage = req.url.endsWith('metered') ? { input_tokens: 8, output_tokens: 0 } : undefined;
      return json(res, 200, { type: 'message', role: 'assistant', stop_reason: 'refusal', content: [], usage });
    }
    json(res, 200, { error: providerError });
  });
  for (const path of [messages, chat]) {
    const reply = JSON.parse(await expectStatus(post(path), 200));
    assert.deepEqual(reply.error, providerError);
  }
  const refusal = JSON.parse(await expectStatus(post(messages + '?refusal'), 200));
  assert.equal(refusal.stop_reason, 'refusal');
  await expectStatus(post(messages + '?refusal=metered'), 200);
  await expectStatus(post(), 429);
});

test('partial generation counts on all compact and native routes even when the stream ends with an error', async t => {
  const nextMinute = clock(t);
  const generated = {
    [chat]: event('', { choices: [{ index: 0, delta: { content: 'partial' } }] }),
    [responses]: event('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', delta: 'partial' }),
    [messages]: event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }),
  };
  const end = {
    [chat]: event('', { error: providerError }) + 'data: [DONE]\r\n\r\n',
    [responses]: event('response.failed', { type: 'response.failed', response: { status: 'failed', error: providerError } }),
    [messages]: event('error', { type: 'error', error: providerError }),
  };
  const idle = {
    [chat]: event('', { choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    [responses]: event('response.created', { type: 'response.created', response: { status: 'in_progress' } }),
    [messages]: event('ping', { type: 'ping' }),
  };
  let streams = 0;
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('_tokens')) return json(res, 200, { input_tokens: 2 });
    const path = req.url.split('?')[0];
    streams++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(req.url.endsWith('?generated') ? generated[path] : idle[path]);
    res.end(end[path]);
  });
  for (const [path, prefix] of [[chat, '/openai'], [responses, '/openai'], [messages, '/anthropic']]) {
    for (const native of [false, true]) {
      for (const query of ['?idle', '?generated']) {
        const wire = await expectStatus(post((native ? prefix : '') + path + query, { stream: true }), 200);
        assert.match(wire, /Synthetic provider failure/);
        if (native) assert.equal(wire, (query === '?generated' ? generated[path] : idle[path]) + end[path]);
      }
      assert.match(await expectStatus(post(), 429), /Proxy request limit/);
      nextMinute();
    }
  }
  assert.equal(streams, 12);
});

test('a pending generation reserves its place and only its own failure frees one', async t => {
  const waiting = Promise.withResolvers();
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('?hold')) return waiting.resolve(res);
    json(res, 200, chatReply);
  }, 2);
  const held = post(chat + '?hold');
  const upstream = await waiting.promise;
  try {
    await expectStatus(post(), 200);
    await expectStatus(post(), 429);
  } finally {
    json(upstream, 503, { error: providerError });
  }
  await expectStatus(held, 503);
  await expectStatus(post(), 200);
  await expectStatus(post(), 429);
});

test('an early stream error reserves its slot until a later usage-only chunk is read', async t => {
  const nextMinute = clock(t);
  let waiting;
  const post = await gateway(t, (req, res) => {
    if (!req.url.endsWith('?hold')) return json(res, 200, chatReply);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('', { error: providerError }));
    waiting.resolve(res);
  });
  for (const path of [chat, '/openai' + chat]) {
    waiting = Promise.withResolvers();
    const reply = await post(path + '?hold', { stream: true });
    assert.equal(reply.status, 200);
    const upstream = await waiting.promise;
    const reader = reply.body.getReader();
    try {
      assert.match(new TextDecoder().decode((await reader.read()).value), /Synthetic provider failure/);
      assert.match(await expectStatus(post(), 429), /Proxy request limit/);
    } finally {
      upstream.end(event('', { choices: [], usage: { prompt_tokens: 12, completion_tokens: 0 } }) + 'data: [DONE]\r\n\r\n');
    }
    while (!(await reader.read()).done) { /* Wait until the client receives the complete stream. */ }
    assert.match(await expectStatus(post(), 429), /Proxy request limit/);
    nextMinute();
  }
});

test('a premature stream EOF counts only when the provider already generated output', async t => {
  const nextMinute = clock(t);
  const partial = event('', { choices: [{ index: 0, delta: { content: 'unfinished' } }] });
  const empty = event('', { choices: [{ index: 0, delta: { role: 'assistant' } }] });
  let calls = 0;
  const post = await gateway(t, (req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(req.url.endsWith('?partial') ? partial : empty);
  });
  for (const path of [chat, '/openai' + chat]) {
    for (const query of ['?empty', '?partial']) {
      const reply = await post(path + query, { stream: true });
      assert.equal(reply.status, 200);
      // The compact relay can signal the missing terminal event by closing its response.
      await reply.text().catch(() => {});
    }
    assert.match(await expectStatus(post(), 429), /Proxy request limit/);
    nextMinute();
  }
  assert.equal(calls, 4);
});

test('a caller can cancel before any usage and a later cancellation after output counts once', async t => {
  let closed;
  const post = await gateway(t, (req, res) => {
    if (!req.url.includes('?')) return json(res, 200, chatReply);
    res.on('close', closed.resolve);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = req.url.endsWith('?empty') ? { role: 'assistant' } : { content: 'cancel this answer' };
    res.write(event('', { choices: [{ index: 0, delta }] }));
  });
  for (const query of ['?empty', '?partial']) {
    closed = Promise.withResolvers();
    const controller = new AbortController();
    try {
      const stream = await post(chat + query, { stream: true }, controller.signal);
      assert.equal(stream.status, 200);
      const first = await stream.body.getReader().read();
      assert.match(new TextDecoder().decode(first.value), query === '?empty' ? /assistant/ : /cancel this answer/);
    } finally {
      controller.abort();
    }
    await closed.promise;
  }
  await expectStatus(post(), 429);
});

test('an interrupted SSE record establishes usage only when its received JSON is complete', async () => {
  const first = event('', { choices: [{ delta: { role: 'assistant' } }] });
  const usage = 'data: {"choices":[],"usage":{"prompt_tokens":4}}';
  const reset = new Error('upstream connection reset');
  for (const [tail, charged] of [[usage, 1], [usage + '\r\n', 1], [usage.slice(0, -1), 0]]) {
    const body = Buffer.from(first + tail);
    async function* upstream() { yield body; throw reset; }
    for (const native of [false, true]) {
      for (const cancel of [false, true]) {
        let charges = 0;
        const count = () => { charges++; };
        const relay = native ? observeNativeStream(upstream(), chat, undefined, count)
          : compactStream(upstream(), chat, {}, undefined, count);
        const start = await relay.next();
        if (native) assert.deepEqual(start.value, body);
        else assert.match(start.value, /assistant/);
        if (cancel) assert.equal((await relay.return()).done, true);
        else await assert.rejects(relay.next(), error => error === reset);
        assert.equal(charges, charged);
      }
    }
  }
});

test('a cut-off native JSON body counts only when its received fields already establish usage', async t => {
  let writing;
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('/input_tokens')) return json(res, 200, { input_tokens: 2 });
    if (!req.url.includes('?cut')) return json(res, 200, chatReply);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
    res.write(req.url.endsWith('used') ? '{"usage":{"input_tokens":8},"output":[' : '{"object":"response","output":[');
    writing.resolve(res);
  });
  for (const query of ['?cut', '?cut=used']) {
    writing = Promise.withResolvers();
    const reply = await post('/openai' + responses + query);
    assert.equal(reply.status, 200);
    const upstream = await writing.promise;
    try {
      const reader = reply.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /"output"/);
      upstream.destroy();
      await assert.rejects(reader.read());
    } finally {
      upstream.destroy();
    }
  }
  await expectStatus(post(), 429);
});

test('a late provider failure cannot refund another generation in the new minute', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const waiting = Promise.withResolvers();
  const post = await gateway(t, (req, res) => {
    if (req.url.endsWith('?hold')) return waiting.resolve(res);
    json(res, 200, chatReply);
  });
  const held = post(chat + '?hold');
  const upstream = await waiting.promise;
  try {
    now += 60_001;
    await expectStatus(post(), 200);
  } finally {
    json(upstream, 503, { error: providerError });
  }
  await expectStatus(held, 503);
  await expectStatus(post(), 429);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/access.ts';
import { createGateway } from '../src/server.ts';

// Exercise the actual HTTP entry points with an isolated upstream on loopback.
function defaultCount(_req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: 12 }));
}

async function startGateway(t, handler, env = {}, countHandler = defaultCount) {
  const vendor = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/v1/responses/input_tokens' || path === '/v1/messages/count_tokens') {
      return countHandler(req, res);
    }
    return handler(req, res);
  });
  vendor.listen(0, '127.0.0.1');
  await once(vendor, 'listening');
  t.after(() => vendor.close());
  const request = t.mock.method(https, 'request', (options, callback) =>
    http.request({ ...options, hostname: '127.0.0.1', port: vendor.address().port }, callback));
  syncBuiltinESMExports();
  t.after(() => { request.mock.restore(); syncBuiltinESMExports(); });

  const gateway = createGateway(readConfig({ OPENAI_API_KEY: 'vendor-one', ANTHROPIC_API_KEY: 'vendor-two',
    PROXY_TOKENS: 'local-token', ...env }));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  return 'http://127.0.0.1:' + gateway.address().port;
}

test('RisuAI authentication, new model IDs and native streams', async t => {
  const sent = [];
  const origin = 'https://risu.example';
  const sse = 'event: test\ndata: {"text":"한글"}\n\n';
  const base = await startGateway(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"role":"assistant","content":"OK"}}]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'vendor-id' });
    res.end(sse);
  }, { ALLOWED_ORIGINS: origin, ADDITIONAL_ALLOWED_ORIGINS: 'https://risuai.xyz' });
  for (const [client, allowed] of [[origin, true], ['https://risuai.xyz', true], ['https://other.risuai.xyz', false]]) {
    const preflight = await fetch(base + '/v1/messages', { method: 'OPTIONS', headers: {
      origin: client, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-api-key',
    } });
    assert.equal(preflight.status, allowed ? 204 : 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowed ? client : null);
    await preflight.text();
  }
  const unauthorized = await fetch(base + '/v1/models');
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();

  for (const [path, auth, body] of [
    ['/openai/v1/responses', { authorization: 'Bearer local-token' }, { model: 'future-openai-id', input: 'hi', stream: true }],
    ['/anthropic/v1/messages', { 'x-api-key': 'local-token', 'anthropic-version': '2023-06-01' },
      { model: 'future-claude-id', max_tokens: 24, messages: [{ role: 'user', content: 'hi' }], stream: true }],
  ]) {
    const res = await fetch(base + path, { method: 'POST', headers: { ...auth, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('request-id'), 'vendor-id');
    assert.equal(await res.text(), sse);
    const expected = path === '/openai/v1/responses' ? { ...body, max_output_tokens: 10000 } : body;
    assert.deepEqual(sent.at(-1).body, expected);
    assert.equal(sent.at(-1).path, path.slice(path.indexOf('/v1/')));
    assert.equal(sent.at(-1).headers.origin, undefined);
  }
  assert.equal(sent[0].headers.authorization, 'Bearer vendor-one');
  assert.equal(sent[1].headers['x-api-key'], 'vendor-two');
  assert.equal(sent[1].headers['anthropic-version'], '2023-06-01');
  const chat = await fetch(base + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'another-chat-model', messages: [{ role: 'user', content: 'hello' }] }) });
  const data = await chat.json();
  assert.equal(data.choices[0].message.content, 'OK');
  assert.deepEqual(data.usage, { input_tokens: null, output_tokens: null, total_tokens: null });
  assert.equal(Object.hasOwn(data, 'tokenizer'), false);
  assert.equal(sent.length, 3);
});

const responsesPath = '/v1/responses';
const chatPath = '/v1/chat/completions';
const messagesPath = '/v1/messages';
const messages = [{ role: 'user', content: 'Synthetic test prompt' }];
const answer = '최종 답변';
const hidden = 'hidden-fixture-only';

function post(base, path, body, token = 'local-token', headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'synthetic-model', ...body }),
  });
}

function outputMessage(phase, text) {
  return { id: phase, type: 'message', role: 'assistant', phase, status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
}

const responseOutput = [
  { id: 'r', type: 'reasoning', encrypted_content: hidden, summary: [{ type: 'summary_text', text: hidden }] },
  outputMessage('commentary', hidden),
  outputMessage('final_answer', answer),
];
const responsesReply = { id: 'resp', object: 'response', model: 'gpt-4o-2024-08-06', status: 'completed', tokenizer: 'vendor-test-encoder',
  output: responseOutput, metadata: { debug: hidden }, usage: {
    input_tokens: 14, output_tokens: 6, total_tokens: 20,
    input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 },
  } };
const messagesReply = { id: 'msg', type: 'message', model: 'claude-fable-5-2', role: 'assistant', stop_reason: 'end_turn', tokenizer: 'vendor-test-encoder',
  content: [{ type: 'thinking', thinking: hidden, signature: hidden }, { type: 'text', text: answer }],
  usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 } } };
const chatReply = { id: 'chat', object: 'chat.completion', model: 'gpt-4', tokenizer: 'vendor-test-encoder', choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: answer, reasoning_content: hidden } }], usage: {
    prompt_tokens: 0, completion_tokens: 7, total_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 },
  } };
const vendorReplies = new Map([[responsesPath, responsesReply], [messagesPath, messagesReply], [chatPath, chatReply]]);
const expectedUsage = new Map([
  [responsesPath, { input_tokens: 14, output_tokens: 6, total_tokens: 20 }],
  [messagesPath, { input_tokens: 10, output_tokens: 7, total_tokens: 17 }],
  [chatPath, { input_tokens: 0, output_tokens: 7, total_tokens: 7 }],
]);

test('plain chat requests return the final text and effective sampling parameters', async t => {
  let forwarded;
  const base = await startGateway(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { MAX_OUTPUT_TOKENS: '24' });

  for (const [path, body, expected, texts] of [
    [responsesPath, { input: 'hello', temperature: 0, instructions: hidden },
      { temperature: 0, max_output_tokens: 24 }, data => data.output.flatMap(item => item.content.map(part => part.text))],
    [messagesPath, { messages, max_tokens: 7, top_k: 0, system: hidden },
      { max_tokens: 7, top_k: 0 }, data => data.content.map(block => block.text)],
    [chatPath, { messages, n: 2, presence_penalty: 0, logprobs: false },
      { n: 2, presence_penalty: 0, logprobs: false, max_completion_tokens: 12 }, data => data.choices.map(choice => choice.message.content)],
  ]) {
    const res = await post(base, path, body);
    assert.equal(res.status, 200, path);
    const wire = await res.text();
    assert.match(wire, /^\s*\{\s*"model"\s*:/, path);
    assert.doesNotMatch(wire, /"tokenizer"\s*:/, path);
    const data = JSON.parse(wire);
    assert.deepEqual(texts(data), [answer], path);
    assert.equal(data.model, vendorReplies.get(path).model, path);
    assert.deepEqual(data.parameters, expected, path);
    for (const [key, value] of Object.entries(expected)) assert.equal(forwarded[key], value, key);
    assert.deepEqual(data.usage, expectedUsage.get(path), path);
    assert.ok(!wire.includes(hidden), path);
  }
});

test('native prefixes, advanced requests and provider errors keep the original response', async t => {
  const providerError = { error: { type: 'invalid_request_error', code: 'invalid_model', message: 'Synthetic provider error' } };
  const usageStream = frame({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] }) +
    frame({ choices: [], usage: { completion_tokens: 15 } }) + 'data: [DONE]\r\n\r\n';
  const base = await startGateway(t, (req, res) => {
    if (req.url.endsWith('?usage=1')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(usageStream);
      return;
    }
    const fails = req.url.endsWith('?error=1');
    res.writeHead(fails ? 422 : 200, { 'content-type': 'application/json', 'request-id': 'upstream-test' });
    res.end(JSON.stringify(fails ? providerError : vendorReplies.get(req.url)));
  }, { REQUESTS_PER_MINUTE: '10' });
  for (const [path, body, native] of [
    ['/openai' + responsesPath, { input: 'hello' }, responsesReply],
    ['/anthropic' + messagesPath, { messages, max_tokens: 8 }, messagesReply],
    ['/openai' + chatPath, { messages }, chatReply],
    [messagesPath, { messages, max_tokens: 8, tools: [{ name: 'clock', input_schema: { type: 'object' } }] }, messagesReply],
    [chatPath, { messages, tools: [{ type: 'function', function: { name: 'clock', parameters: { type: 'object' } } }] }, chatReply],
    [responsesPath, { input: 'hello', background: true }, responsesReply],
  ]) {
    const res = await post(base, path, body);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), JSON.stringify(native), path);
  }
  const nativeUsage = await post(base, '/openai' + chatPath + '?usage=1', { messages, stream: true, stream_options: { include_usage: true } });
  assert.equal(nativeUsage.status, 200);
  assert.equal(await nativeUsage.text(), usageStream);
  const res = await post(base, responsesPath + '?error=1', { input: 'hello' });
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('request-id'), 'upstream-test');
  assert.deepEqual(await res.json(), providerError);
});

function frame(event) {
  const name = event.type ? 'event: ' + event.type + '\r\n' : '';
  return name + 'data: ' + JSON.stringify(event) + '\r\n\r\n';
}

function readEvents(text) {
  return text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => {
    const data = line.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

test('Chat stream usage defaults on for compact and native requests and honors explicit options', async t => {
  let receivedOptions;
  const base = await startGateway(t, async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes));
    receivedOptions = body.stream_options;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] }));
    res.write(frame({ model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    if (receivedOptions?.include_usage === true) res.write(frame({ model: 'gpt-4o', choices: [], usage: chatReply.usage }));
    res.end('data: [DONE]\n\n');
  }, { REQUESTS_PER_MINUTE: '10' });
  for (const [options, expected] of [
    [undefined, { include_usage: true }],
    [{ include_obfuscation: false }, { include_obfuscation: false, include_usage: true }],
    [{ include_usage: true }, { include_usage: true }],
    [{ include_usage: false }, { include_usage: false }],
  ]) {
    const res = await post(base, chatPath, { messages, stream: true, stream_options: options });
    const chunks = readEvents(await res.text());
    assert.equal(res.status, 200);
    assert.deepEqual(receivedOptions, expected);
    assert.equal(chunks.at(-1), '[DONE]');
    assert.deepEqual(chunks.at(-2).choices, []);
    assert.equal(Object.keys(chunks.at(-2))[0], 'model');
    assert.equal(Object.hasOwn(chunks.at(-2), 'tokenizer'), false);
    const reported = expected.include_usage ? expectedUsage.get(chatPath) : { input_tokens: null, output_tokens: null, total_tokens: null };
    assert.deepEqual(chunks.at(-2).usage, reported);
  }
  for (const options of [undefined, { include_usage: false }]) {
    const native = await post(base, '/openai' + chatPath, { messages, stream: true, stream_options: options });
    const events = readEvents(await native.text());
    assert.deepEqual(receivedOptions, options ?? { include_usage: true });
    assert.equal(events.at(-1), '[DONE]');
    assert.equal(events.at(-2).tokenizer, undefined);
    if (options) assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
    else assert.deepEqual(events.at(-2).usage, chatReply.usage);
  }
});

test('partial provider token counts preserve zeros and unknown fields stay null', async t => {
  const partials = new Map([
    [responsesPath, { input_tokens: 0 }],
    [chatPath, { completion_tokens: 0 }],
    [messagesPath, { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
  ]);
  const base = await startGateway(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...vendorReplies.get(req.url), model: 'synthetic-unknown', tokenizer: undefined,
      usage: partials.get(req.url) }));
  });
  for (const [path, counts] of [
    [responsesPath, { input_tokens: 0, output_tokens: null, total_tokens: null }],
    [chatPath, { input_tokens: null, output_tokens: 0, total_tokens: null }],
    [messagesPath, { input_tokens: 0, output_tokens: 0, total_tokens: 0 }],
  ]) {
    const body = path === responsesPath ? { input: 'hello' } : { messages };
    const res = await post(base, path, body);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data.usage, counts, path);
    assert.equal(Object.hasOwn(data, 'tokenizer'), false, path);
  }
});

test('stream projection preserves answer deltas, lifecycle and numbering for all chat formats', async t => {
  const replyEvents = [
    { type: 'response.created', response: { id: 'resp', object: 'response', model: responsesReply.model, output: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'commentary', content_index: 0, delta: hidden },
    { type: 'response.output_item.added', output_index: 0, item: responseOutput[0] },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'r', delta: hidden },
    { type: 'response.output_item.added', output_index: 1, item: { ...responseOutput[1], content: [] } },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'commentary', content_index: 0, delta: hidden },
    { type: 'response.output_item.added', output_index: 2, item: { ...responseOutput[2], content: [] } },
    { type: 'response.content_part.added', output_index: 2, item_id: 'final_answer', content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 2, item_id: 'final_answer', content_index: 0, delta: answer },
    { type: 'response.output_item.done', output_index: 2, item: responseOutput[2] },
    { type: 'response.completed', response: responsesReply },
  ];
  const blockEvents = [
    { type: 'message_start', message: { ...messagesReply, content: [], stop_reason: null, usage: { ...messagesReply.usage, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: hidden } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: hidden } },
    { type: 'content_block_stop', index: 0 },
  ];
  for (const [index, text] of [[1, '최종 '], [2, '답변']]) {
    blockEvents.push(
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index },
    );
  }
  blockEvents.push(
    { type: 'message_delta', delta: {}, usage: { output_tokens: 4 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 } },
    { type: 'message_stop', tokenizer: messagesReply.tokenizer },
  );
  const chatEvents = [
    { id: 'chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: hidden } }] },
    { model: chatReply.model, choices: [{ index: 0, delta: { reasoning_content: hidden } }] },
    { choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
    { choices: [], tokenizer: chatReply.tokenizer, usage: chatReply.usage },
  ];
  const fixtures = new Map([
    [responsesPath, replyEvents.map(frame).join('')],
    [messagesPath, blockEvents.map(frame).join('')],
    [chatPath, chatEvents.map(frame).join('') + 'data: [DONE]\r\n\r\n'],
  ]);
  const base = await startGateway(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(fixtures.get(req.url));
    const split = bytes.indexOf(Buffer.from('최')) + 1;
    res.write(bytes.subarray(0, split));
    setImmediate(() => res.end(bytes.subarray(split)));
  });

  const projected = new Map();
  for (const [path, body] of [[responsesPath, { input: 'hello' }], [messagesPath, { messages, max_tokens: 12 }], [chatPath, { messages }]]) {
    const res = await post(base, path, { ...body, stream: true, temperature: 0 });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const text = await res.text();
    assert.ok(!text.includes(hidden), path);
    assert.ok(!text.includes('reasoning_tokens'), path);
    assert.ok(!text.includes('cache_creation_input_tokens'), path);
    assert.doesNotMatch(text, /"tokenizer"\s*:/, path);
    projected.set(path, readEvents(text));
  }
  const response = projected.get(responsesPath);
  for (const event of [response[0], response.at(-1)]) {
    assert.equal(Object.keys(event.response)[0], 'model');
    assert.equal(event.response.model, responsesReply.model);
  }
  assert.equal(response[0].response.parameters.temperature, 0);
  assert.deepEqual(response.filter(e => e.type === 'response.output_text.delta').map(e => e.delta), [answer]);
  assert.equal(response.at(-1).type, 'response.completed');
  assert.deepEqual(response.at(-1).response.usage, expectedUsage.get(responsesPath));
  assert.deepEqual(response.at(-1).response.output.map(item => item.content[0].text), [answer]);

  const claude = projected.get(messagesPath);
  assert.equal(Object.keys(claude[0].message)[0], 'model');
  assert.equal(claude[0].message.model, messagesReply.model);
  assert.deepEqual(claude[0].message.parameters, { temperature: 0, max_tokens: 12 });
  for (const suffix of ['start', 'delta', 'stop']) {
    assert.deepEqual(claude.filter(e => e.type === 'content_block_' + suffix).map(e => e.index), [0, 1]);
  }
  assert.equal(claude.filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join(''), answer);
  assert.equal(claude.at(-2).delta.stop_reason, 'end_turn');
  assert.deepEqual(claude.at(-2).usage, expectedUsage.get(messagesPath));
  assert.equal(claude.at(-1).type, 'message_stop');

  const chunks = projected.get(chatPath);
  for (const chunk of [chunks[0], chunks.at(-2)]) {
    assert.equal(Object.keys(chunk)[0], 'model');
    assert.equal(chunk.model, chatReply.model);
  }
  assert.equal(chunks[0].parameters.temperature, 0);
  assert.equal(chunks[0].choices[0].delta.content, answer);
  assert.equal(chunks.at(-3).choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-2).choices, []);
  assert.deepEqual(chunks.at(-2).usage, expectedUsage.get(chatPath));
  assert.equal(chunks.at(-1), '[DONE]');
});

test('a malformed SSE frame interrupts an ongoing reply', async t => {
  const sendMalformed = Promise.withResolvers();
  t.after(() => sendMalformed.resolve());
  const base = await startGateway(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] }));
    await sendMalformed.promise;
    res.end('data: {"choices":\r\n\r\n');
  });
  const res = await post(base, chatPath, { messages, stream: true });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let initial = '';
  while (!initial.includes('\n\n')) {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    initial += decoder.decode(value, { stream: true });
  }
  assert.equal(readEvents(initial)[0].choices[0].delta.content, 'first');
  sendMalformed.resolve();
  await assert.rejects(reader.read());
});

test('one token and address share three generation attempts per rolling minute across providers', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let generations = 0;
  const base = await startGateway(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end('{"id":"synthetic-model"}');
    generations++;
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { PROXY_TOKENS: 'local-token,second-user' });
  const run = (path, token) => post(base, path,
    path.endsWith('/responses') ? { input: 'hi' } : { messages }, token);
  const headers = { authorization: 'Bearer local-token' };
  const detail = () => fetch(base + '/openai/v1/models/synthetic-model', { headers });

  const started = now;
  assert.equal((await detail()).status, 200);
  assert.equal((await run('/openai/v1/responses')).status, 200);
  now += 10_000;
  assert.equal((await post(base, '/v1/messages/count_tokens', { messages })).status, 200);
  const preflight = await fetch(base + messagesPath, {
    method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal((await run(messagesPath)).status, 200);
  now += 10_000;
  assert.equal((await run(chatPath)).status, 200);
  const refused = await run('/anthropic/v1/messages');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '40');
  assert.equal(generations, 3);
  assert.equal((await detail()).status, 200);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await post(base, '/openai/v1/responses/input_tokens', { input: 'hi' })).status, 200);
  assert.equal((await run(messagesPath, 'second-user')).status, 200);
  now = started + 60_000;
  assert.equal((await run(responsesPath)).status, 200);
  assert.equal((await run(messagesPath)).status, 429);
  assert.equal(generations, 5);
});

test('RisuAI Responses options reach the token counter and generator in the native format', async t => {
  const sent = [];
  const countPath = responsesPath + '/input_tokens';
  const provider = async (req, res) => {
    sent.push({ path: req.url, body: JSON.parse(await readText(req)) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url) ?? { input_tokens: 12 }));
  };
  const base = await startGateway(t, provider, { REQUESTS_PER_MINUTE: '10' }, provider);
  const input = [
    { role: 'system', content: [{ type: 'input_text', text: '[Start a new chat]' }] },
    { role: 'user', content: [{ type: 'input_text', text: '자기 소개 해봐' }] },
  ];
  const aliases = { reasoning_effort: 'high', verbosity: 'low' };
  const controls = { max_output_tokens: 10000, store: false, stream: false };
  const models = [
    [responsesPath, 'gpt-6.2-astra', {}],
    ['/openai' + responsesPath, 'gpt-6.2-sol-2026-11-01', { text: { format: { type: 'text' } }, reasoning: { summary: 'auto' } }],
  ];
  for (const [path, model, siblings] of models) {
    const res = await post(base, path, { model, input, ...controls, temperature: 1, ...aliases, ...siblings });
    assert.equal(res.status, 200, path);
    const canonical = { model, input, text: { ...siblings.text, verbosity: 'low' },
      reasoning: { ...siblings.reasoning, effort: 'high' } };
    assert.deepEqual(sent.splice(0), [
      { path: countPath, body: canonical },
      { path: responsesPath, body: { ...canonical, ...controls } },
    ]);
    if (path === responsesPath) {
      assert.deepEqual((await res.json()).parameters, { max_output_tokens: 10000, text: { verbosity: 'low' } });
    }
  }
  const model = 'gpt-4o';
  const counted = await post(base, countPath, { model, input, ...aliases });
  assert.equal(counted.status, 200);
  assert.deepEqual(sent.splice(0), [{ path: countPath, body: { model, input,
    text: { verbosity: 'low' }, reasoning: { effort: 'high' } } }]);
  assert.equal((await post(base, responsesPath, { model, input, temperature: 1 })).status, 200);
  assert.equal(sent.at(-1).body.temperature, 1);
  const chat = { model, messages, temperature: 0.7, ...aliases, max_completion_tokens: 8 };
  assert.equal((await post(base, chatPath, chat)).status, 200);
  assert.deepEqual(sent.at(-1), { path: chatPath, body: chat });
});

test('ambiguous Responses controls and unsupported temperatures fail before provider calls', async t => {
  let calls = 0;
  const provider = (req, res) => { calls++; defaultCount(req, res); };
  const base = await startGateway(t, provider, {}, provider);
  for (const [options, field] of [
    [{ verbosity: 'low', text: { verbosity: 'high' } }, /verbosity/],
    [{ reasoning_effort: 'high', reasoning: { effort: 'low' } }, /effort/],
    [{ reasoning_effort: 'high', reasoning: [] }, /reasoning/],
    [{ temperature: 0.3 }, /temperature/],
  ]) {
    const res = await post(base, responsesPath, { model: 'gpt-6.2-astra', input: 'hi', ...options });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, field);
  }
  assert.equal(calls, 0);
});

test('provider preflight enforces the input boundary on compact and native generation', async t => {
  const generations = [];
  const counts = [];
  let inputTokens = 100_000;
  const base = await startGateway(t, async (req, res) => {
    generations.push(JSON.parse(await readText(req)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { REQUESTS_PER_MINUTE: '20' }, async (req, res) => {
    counts.push({ path: req.url, headers: req.headers, body: JSON.parse(await readText(req)) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: inputTokens }));
  });

  const system = [{ type: 'text', text: 'System text', cache_control: { type: 'ephemeral' } }];
  const edge = await fetch(base + '/anthropic/v1/messages', {
    method: 'POST', headers: { 'x-api-key': 'local-token', 'content-type': 'application/json',
      'anthropic-version': '2023-06-01', 'anthropic-beta': 'synthetic-beta' },
    body: JSON.stringify({ model: 'synthetic-model', system, messages }),
  });
  assert.equal(edge.status, 200);
  assert.equal(generations.at(-1).max_tokens, 10_000);
  const anthropicCount = counts.at(-1);
  assert.equal(anthropicCount.path, '/v1/messages/count_tokens');
  assert.equal(anthropicCount.headers['x-api-key'], 'vendor-two');
  assert.equal(anthropicCount.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropicCount.headers['anthropic-beta'], 'synthetic-beta');
  assert.deepEqual(anthropicCount.body.system, system);
  assert.deepEqual(anthropicCount.body.messages, messages);
  assert.equal(Object.hasOwn(anthropicCount.body, 'max_tokens'), false);

  inputTokens++;
  for (const [path, body] of [
    [responsesPath, { input: 'question', instructions: 'System text', stream: true }],
    ['/openai' + responsesPath, { input: 'question', instructions: 'System text' }],
    [messagesPath, { system, messages }],
  ]) {
    const before = counts.length;
    const denied = await post(base, path, body);
    assert.equal(denied.status, 413, path);
    assert.equal(counts.length, before + 1);
    assert.equal(generations.length, 1);
    if (path.endsWith('/responses')) {
      const count = counts.at(-1);
      assert.equal(count.path, '/v1/responses/input_tokens');
      assert.equal(count.headers.authorization, 'Bearer vendor-one');
      assert.equal(count.body.input, body.input);
      assert.equal(count.body.instructions, body.instructions);
      assert.equal(Object.hasOwn(count.body, 'stream'), false);
    }
  }
});

test('long text Chat inputs use the requested model for preflight and reserve framing overhead', async t => {
  let generated = 0;
  let counterStatus = 200;
  let count = 100;
  const counted = [];
  const base = await startGateway(t, (_req, res) => {
    generated++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatReply));
  }, { REQUESTS_PER_MINUTE: '10' }, async (req, res) => {
    counted.push({ path: req.url, body: JSON.parse(await readText(req)) });
    res.writeHead(counterStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: count }));
  });
  const text = '한'.repeat(34_000);
  assert.ok(text.length < 100_000 && Buffer.byteLength(text) > 100_000);
  const model = 'gpt-4o-mini';
  const history = [{ role: 'system', content: 'reply briefly' }, { role: 'user', content: text }];
  const request = { model, messages: history };
  const accepted = await post(base, chatPath, request);
  assert.equal(accepted.status, 200);
  assert.deepEqual(counted, [{ path: '/v1/responses/input_tokens', body: { model, input: history } }]);
  count = 100_000;
  const over = await post(base, '/openai' + chatPath, request);
  assert.equal(over.status, 413);
  counterStatus = 500;
  const unavailable = await post(base, chatPath, request);
  assert.equal(unavailable.status, 502);
  assert.equal(counted.length, 3);
  const rich = await post(base, '/openai' + chatPath, {
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { format: 'wav', data: 'AA==' } }] }],
  });
  assert.equal(rich.status, 400);
  assert.equal(counted.length, 3);
  assert.equal(generated, 1);
});

test('count and generation see identical client tool schemas while unbounded tools and mutable media are blocked', async t => {
  const counted = [];
  const generated = [];
  const base = await startGateway(t, async (req, res) => {
    generated.push(await readText(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { REQUESTS_PER_MINUTE: '12' }, async (req, res) => {
    counted.push(await readText(req));
    defaultCount(req, res);
  });
  const literal = '12345678901234567890123456789';
  const tools = [{ name: 'describe', input_schema: { type: 'object', properties: {
    image_url: { type: 'string' }, value: { type: 'integer', default: JSON.rawJSON(literal) },
  } } }];
  const history = [
    ...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'describe',
      input: { image_url: 'https://example.invalid/plain-tool-argument', value: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'done' }] },
  ];
  const accepted = await post(base, messagesPath, { messages: history, tools });
  assert.equal(accepted.status, 200);
  assert.ok(counted[0].includes(literal));
  assert.ok(generated[0].includes(literal));
  assert.deepEqual(JSON.parse(counted[0]).tools, JSON.parse(generated[0]).tools);

  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } };
  for (const [path, payload] of [
    [responsesPath, { input: 'hi', tools: [{ type: 'web_search' }] }],
    [messagesPath, { messages, mcp_servers: [{ type: 'url', name: 'server', url: 'https://example.invalid' }] }],
    [messagesPath, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'id', content: [image] }] }] }],
    [responsesPath, { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.invalid/img.png' }] }] }],
  ]) {
    const denied = await post(base, path, payload);
    assert.equal(denied.status, 400, path);
  }
  assert.equal(counted.length, 1);
  assert.equal(generated.length, 1);
});

test('token-limited mode rejects specialized model routes before sending to a provider', async t => {
  let forwarded = 0;
  const base = await startGateway(t, (_req, res) => {
    forwarded++;
    res.end('{}');
  }, { REQUESTS_PER_MINUTE: '20' });
  for (const path of ['/v1/images/generations', '/openai/v1/audio/speech', '/v1/embeddings', '/openai/v1/responses/compact']) {
    const unauthenticated = await fetch(base + path, { method: 'POST' });
    assert.equal(unauthenticated.status, 401, path);
    const denied = await post(base, path, { input: 'hello' });
    assert.equal(denied.status, 403, path);
  }
  const upgrade = http.get(base + '/openai/v1/realtime?model=synthetic-model', { headers: {
    authorization: 'Bearer local-token', connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16).toString('base64'),
  } });
  const [handshake] = await once(upgrade, 'response');
  handshake.resume();
  assert.equal(handshake.statusCode, 403);
  assert.equal(forwarded, 0);
});

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('input counting failures stop generation and do not disclose the provider response', async t => {
  let generated = 0;
  let counterResponse;
  const secret = 'synthetic-upstream-secret';
  const base = await startGateway(t, (_req, res) => {
    generated++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(responsesPath)));
  }, {}, (_req, res) => {
    res.writeHead(counterResponse.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(counterResponse.body));
  });
  for (counterResponse of [
    { status: 500, body: { error: { message: secret } } },
    { status: 200, body: { message: secret } },
    { status: 200, body: { input_tokens: -1, debug: secret } },
  ]) {
    const reply = await post(base, responsesPath, { input: 'hello' });
    assert.ok(reply.status >= 400);
    assert.ok(!(await reply.text()).includes(secret));
    assert.equal(generated, 0);
  }
  counterResponse = { status: 200, body: { input_tokens: 3 } };
  assert.equal((await post(base, responsesPath, { input: 'hello' })).status, 200);
  assert.equal(generated, 1);
});

test('output budgets preserve smaller requested caps and cover all Chat choices', async t => {
  const sent = [];
  const base = await startGateway(t, async (req, res) => {
    sent.push(JSON.parse(await readText(req)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { REQUESTS_PER_MINUTE: '12' });
  for (const [path, body, field, cap] of [
    [responsesPath, { input: 'hi' }, 'max_output_tokens', 10_000],
    [messagesPath, { messages, max_tokens: 1 }, 'max_tokens', 1],
    ['/openai' + chatPath, { messages, n: 3 }, 'max_completion_tokens', 3333],
  ]) {
    const res = await post(base, path, body);
    assert.equal(res.status, 200, path);
    assert.equal(sent.at(-1)[field], cap, path);
  }
  for (const [path, body] of [
    [responsesPath, { input: 'hi', max_output_tokens: 10_001 }],
    ['/anthropic' + messagesPath, { messages, max_tokens: 10_001 }],
    [chatPath, { messages, n: 3, max_tokens: 3334 }],
  ]) {
    assert.equal((await post(base, path, body)).status, 400, path);
    assert.equal(sent.length, 3);
  }
});

test('each provider enforces its own input and output limits on native and compact routes', async t => {
  let count = 500;
  const sent = [];
  const base = await startGateway(t, async (req, res) => {
    sent.push(JSON.parse(await readText(req)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, {
    REQUESTS_PER_MINUTE: '24',
    OPENAI_MAX_INPUT_TOKENS: '500', OPENAI_MAX_OUTPUT_TOKENS: '40',
    ANTHROPIC_MAX_INPUT_TOKENS: '600', ANTHROPIC_MAX_OUTPUT_TOKENS: '70',
  }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: count }));
  });

  for (const prefix of ['', '/openai']) {
    assert.equal((await post(base, prefix + responsesPath, { input: 'hi' })).status, 200);
    assert.equal(sent.at(-1).max_output_tokens, 40);
    assert.equal((await post(base, prefix + chatPath, { messages, n: 2 })).status, 200);
    assert.equal(sent.at(-1).max_completion_tokens, 20);
  }
  count = 600;
  for (const prefix of ['', '/anthropic']) {
    assert.equal((await post(base, prefix + messagesPath, { messages })).status, 200);
    assert.equal(sent.at(-1).max_tokens, 70);
  }
  const accepted = sent.length;
  for (const prefix of ['', '/openai']) {
    assert.equal((await post(base, prefix + responsesPath, { input: 'hi' })).status, 413);
    assert.equal((await post(base, prefix + responsesPath, { input: 'hi', max_output_tokens: 41 })).status, 400);
  }
  count = 601;
  for (const prefix of ['', '/anthropic']) {
    assert.equal((await post(base, prefix + messagesPath, { messages })).status, 413);
    assert.equal((await post(base, prefix + messagesPath, { messages, max_tokens: 71 })).status, 400);
  }
  assert.equal(sent.length, accepted);
});

test('legacy token limits fill only unspecified provider-specific fields', () => {
  const env = {
    OPENAI_API_KEY: 'vendor-one', PROXY_TOKENS: 'shared-token',
    MAX_INPUT_TOKENS: '900', MAX_OUTPUT_TOKENS: '90',
    OPENAI_MAX_OUTPUT_TOKENS: '45', ANTHROPIC_MAX_INPUT_TOKENS: '540',
  };
  assert.deepEqual(readConfig(env).tokenLimits, {
    openai: { maxInputTokens: 900, maxOutputTokens: 45 },
    anthropic: { maxInputTokens: 540, maxOutputTokens: 90 },
  });
  assert.throws(() => readConfig({ ...env, OPENAI_MAX_INPUT_TOKENS: '0' }), /OPENAI_MAX_INPUT_TOKENS/);
});

test('shared credentials give each Render client address an independent rolling quota', async t => {
  const forwarded = [];
  const base = await startGateway(t, (req, res) => {
    forwarded.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url) ?? { id: 'synthetic-model' }));
  }, { RENDER: 'true', PROXY_TOKENS: 'local-token,second-token' });

  const run = (address, path, token = 'local-token', extra = {}) => post(base, path,
    path.endsWith('/responses') ? { input: 'hi' } : { messages }, token,
    { ...(address && { 'cf-connecting-ip': address }), ...extra });
  for (const path of [responsesPath, '/anthropic' + messagesPath, chatPath]) {
    assert.equal((await run('2001:db8:1:2::a', path)).status, 200);
    assert.equal((await run('192.0.2.8', path)).status, 200);
  }
  const ipv6 = await run('2001:0DB8:0001:0002:0000:0000:0000:000A', messagesPath);
  assert.equal(ipv6.status, 429);
  assert.ok(Number(ipv6.headers.get('retry-after')) > 0);
  assert.equal((await run('::ffff:192.0.2.8', responsesPath)).status, 429);
  assert.equal((await run('192.0.2.8', messagesPath, 'second-token')).status, 200);
  const lookup = await fetch(base + '/openai/v1/models/synthetic-model', {
    headers: { authorization: 'Bearer local-token', 'cf-connecting-ip': '192.0.2.8' },
  });
  assert.equal(lookup.status, 200);
  for (const address of [undefined, 'invalid', '192.0.2.11, 192.0.2.12']) {
    assert.equal((await run(address, chatPath)).status, 200);
  }
  assert.equal((await run(undefined, chatPath, 'local-token', { 'x-forwarded-for': '192.0.2.44' })).status, 429);
  assert.equal(forwarded.length, 11);
  assert.ok(forwarded.every(headers => headers['cf-connecting-ip'] === undefined && headers['x-forwarded-for'] === undefined));
});

test('a direct gateway identifies network clients from their socket addresses', async t => {
  let generated = 0;
  const base = await startGateway(t, (_req, res) => {
    generated++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatReply));
  }, { REQUESTS_PER_MINUTE: '1' });
  const url = new URL(chatPath, base);
  async function sendFrom(localAddress, forwardedAddress) {
    const req = http.request(url, { method: 'POST', localAddress, agent: false, headers: {
      authorization: 'Bearer local-token', 'content-type': 'application/json',
      'cf-connecting-ip': forwardedAddress, 'x-forwarded-for': forwardedAddress,
    } });
    const pending = once(req, 'response');
    req.end(JSON.stringify({ model: 'synthetic-model', messages }));
    const [res] = await pending;
    await readText(res);
    return res.statusCode;
  }
  assert.equal(await sendFrom('127.0.0.1', '192.0.2.1'), 200);
  assert.equal(await sendFrom('127.0.0.1', '192.0.2.2'), 429);
  assert.equal(await sendFrom('127.0.0.2', '192.0.2.1'), 200);
  assert.equal(generated, 2);
});

test('simultaneous generations on a shared token have separate address slots', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let generated = 0;
  const base = await startGateway(t, async (_req, res) => {
    if (++generated === 1) {
      started.resolve();
      await finish.promise;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatReply));
  }, { RENDER: 'true', MAX_ACTIVE_PER_TOKEN: '1' });
  const generate = address => post(base, chatPath, { messages }, 'local-token', { 'cf-connecting-ip': address });
  const first = generate('198.51.100.1');
  try {
    await started.promise;
    assert.equal((await generate('198.51.100.1')).status, 429);
    assert.equal((await generate('198.51.100.2')).status, 200);
  } finally {
    finish.resolve();
    assert.equal((await first).status, 200);
  }
  assert.equal((await generate('198.51.100.1')).status, 200);
  assert.equal(generated, 3);
});

test('concurrent model requests rotate each provider independently and keep their preflight key', async t => {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const calls = new Map();
  async function recordKey(req, res) {
    const { model } = JSON.parse(await readText(req));
    const key = req.headers['x-api-key'] ?? req.headers.authorization;
    const trace = calls.get(model) ?? [];
    trace.push([req.url, key]);
    calls.set(model, trace);
    if (model === 'first-gpt' && req.url === responsesPath + '/input_tokens') {
      started.resolve();
      await resume.promise;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url) ?? { input_tokens: 4 }));
  }
  const base = await startGateway(t, recordKey, {
    OPENAI_API_KEY: ' openai-a, ,openai-b,openai-a, ',
    ANTHROPIC_API_KEY: ' claude-a, claude-b ',
    REQUESTS_PER_MINUTE: '12',
  }, recordKey);
  const first = post(base, responsesPath, { model: 'first-gpt', input: 'hi' });
  try {
    await Promise.race([started.promise, first.then(res => { throw new Error('Expected a pending preflight, received ' + res.status); })]);
    for (const [path, body] of [
      [messagesPath, { model: 'first-claude', messages }],
      ['/openai' + responsesPath, { model: 'second-gpt', input: 'hi' }],
      [chatPath, { model: 'third-gpt', messages }],
      ['/anthropic' + messagesPath, { model: 'second-claude', messages }],
      [messagesPath, { model: 'third-claude', messages }],
    ]) assert.equal((await post(base, path, body)).status, 200);
  } finally {
    resume.resolve();
    assert.equal((await first).status, 200);
  }
  for (const [model, path, key] of [
    ['first-gpt', responsesPath, 'Bearer openai-a'], ['second-gpt', responsesPath, 'Bearer openai-b'],
    ['first-claude', messagesPath, 'claude-a'], ['second-claude', messagesPath, 'claude-b'],
    ['third-claude', messagesPath, 'claude-a'],
  ]) {
    const countPath = path === responsesPath ? path + '/input_tokens' : path + '/count_tokens';
    assert.deepEqual(calls.get(model), [[countPath, key], [path, key]], model);
  }
  assert.deepEqual(calls.get('third-gpt'), [[chatPath, 'Bearer openai-a']]);
});

test('rotating provider credentials do not replay failures or charge them against the user quota', async t => {
  const keys = [];
  const base = await startGateway(t, (req, res) => {
    keys.push(req.headers.authorization);
    const failed = keys.length === 1;
    res.writeHead(failed ? 429 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failed ? { error: { message: 'provider limit reached' } } : chatReply));
  }, { OPENAI_API_KEY: 'openai-a,openai-b' });
  const send = () => post(base, chatPath, { messages });
  assert.equal((await send()).status, 429);
  assert.deepEqual(keys, ['Bearer openai-a']);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.deepEqual(keys, ['Bearer openai-a', 'Bearer openai-b', 'Bearer openai-b', 'Bearer openai-b']);
});

test('a client credential cannot match any member of either provider pool', () => {
  const env = { OPENAI_API_KEY: 'openai-a,openai-b', ANTHROPIC_API_KEY: 'claude-a,claude-b' };
  for (const key of ['openai-b', 'claude-b']) {
    assert.throws(() => readConfig({ ...env, PROXY_TOKENS: 'local-token,' + key }), /PROXY_TOKENS/);
  }
});

test('a configured provider list takes precedence while the missing provider uses its first file key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-keys-test-'));
  const file = join(dir, 'providers.txt');
  await writeFile(file, 'sk-fixture-one\nsk-ant-fixture-one\nsk-fixture-two\nsk-ant-fixture-two\n');
  t.after(async () => { await unlink(file); await rmdir(dir); });
  const keys = [];
  const base = await startGateway(t, (req, res) => {
    keys.push(req.headers['x-api-key'] ?? req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(vendorReplies.get(req.url)));
  }, { PROVIDER_KEYS_FILE: file, OPENAI_API_KEY: 'openai-a,openai-b', ANTHROPIC_API_KEY: '', REQUESTS_PER_MINUTE: '8' });
  for (const path of [chatPath, messagesPath, chatPath, messagesPath]) {
    assert.equal((await post(base, path, { messages })).status, 200);
  }
  assert.deepEqual(keys, ['Bearer openai-a', 'sk-ant-fixture-one', 'Bearer openai-b', 'sk-ant-fixture-one']);
});

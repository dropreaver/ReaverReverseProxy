import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createGateway } from '../src/server.ts';
import { readConfig } from '../src/access.ts';

const chat = '/v1/chat/completions';
const responses = '/v1/responses';
const messages = '/v1/messages';
const openaiCount = responses + '/input_tokens';
const claudeCount = messages + '/count_tokens';
const headers = { authorization: 'Bearer local-vision-test', 'content-type': 'application/json' };
const model = 'multimodal-test-model';
const imageUrl = 'https://example.invalid/picture.png';
const imageData = 'data:image/png;base64,AAAA';
const responseImage = { type: 'input_image', image_url: imageData };
const claudeImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const history = content => [{ role: 'user', content }];
const claudeDocument = source => ({ type: 'document', source });

async function gateway(t, rpm = 50) {
  const sent = [];
  const origin = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    sent.push({ path: req.url, body });
    const usage = { input_tokens: 7, output_tokens: 2 };
    const replies = {
      [chat]: { model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
      [responses]: { model, object: 'response', status: 'completed', output_text: 'ok', usage },
      [messages]: { model, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
      [openaiCount]: { input_tokens: 7 }, [claudeCount]: { input_tokens: 7 },
    };
    if (req.url !== openaiCount && req.url !== claudeCount && JSON.parse(body).stream) {
      const frames = req.url === chat ? [
        { choices: [{ index: 0, delta: { content: 'ok' } }] }, '[DONE]',
      ] : req.url === responses ? [
        { type: 'response.completed', response: replies[responses] },
      ] : [
        { type: 'message_start', message: replies[messages] }, { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies[req.url]));
    }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(() => origin.close());
  const redirect = t.mock.method(https, 'request', (options, callback) =>
    http.request({ ...options, hostname: '127.0.0.1', port: origin.address().port }, callback));
  syncBuiltinESMExports();
  t.after(() => { redirect.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(console, 'info', () => {});
  const proxy = createGateway(readConfig({ OPENAI_API_KEY: 'mock-gpt', ANTHROPIC_API_KEY: 'mock-claude',
    PROXY_TOKENS: 'local-vision-test', REQUESTS_PER_MINUTE: String(rpm) }));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const base = 'http://127.0.0.1:' + proxy.address().port;
  async function post(path, payload, contentType = 'application/json') {
    const body = typeof payload === 'string' ? payload : JSON.stringify({ model, ...payload });
    const res = await fetch(base + path, { method: 'POST', headers: { ...headers, 'content-type': contentType }, body });
    const media = res.headers.get('content-type');
    return { status: res.status, body: media?.includes('json') ? await res.json() : await res.text() };
  }
  const report = async () => (await (await fetch(base + '/v1/usage/models', { headers })).json()).data;
  return { sent, post, report };
}

test('image-only input is rejected locally on every generation and count route without charging the user', async t => {
  const { post, sent, report } = await gateway(t, 1);
  for (const [path, prefix, payload] of [
    [chat, '/openai', { messages: history([{ type: 'image_url', image_url: { url: imageUrl } }]) }],
    [responses, '/openai', { input: history([responseImage]) }],
    [openaiCount, '/openai', { input: history([responseImage]) }],
    [messages, '/anthropic', { messages: history([claudeImage]) }],
    [claudeCount, '/anthropic', { messages: history([claudeImage]) }],
  ]) {
    for (const route of [path, prefix + path]) {
      for (const stream of (path === openaiCount || path === claudeCount ? [undefined] : [false, true])) {
        const res = await post(route, { ...payload, stream });
        assert.equal(res.status, 400, route);
        assert.equal(res.body.error.type, 'invalid_request_error', route);
        if (prefix === '/anthropic') assert.equal(res.body.type, 'error', route);
      }
    }
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(await report(), []);
  const text = { messages: history('What is a PNG?') };
  assert.equal((await post(chat, text)).status, 200);
  assert.equal((await post(chat, text)).status, 429);
  assert.deepEqual(sent.map(req => req.path), [chat]);
  assert.equal((await report())[0].requests, 1);
});

test('mixed image and text inputs reach every compact, native, streaming and count route with only the original text', async t => {
  const { post, sent } = await gateway(t);
  for (const [path, prefix, field, textType, image, countPath] of [
    [chat, '/openai', 'messages', 'text', { type: 'image_url', image_url: { url: imageUrl } }],
    [responses, '/openai', 'input', 'input_text', responseImage, openaiCount],
    [openaiCount, '/openai', 'input', 'input_text', responseImage],
    [messages, '/anthropic', 'messages', 'text', claudeImage, claudeCount],
    [claudeCount, '/anthropic', 'messages', 'text', claudeImage],
  ]) {
    const a = { type: textType, text: ' first \n' };
    const b = { type: textType, text: '두 번째' };
    const body = { [field]: history([image, a, image, b]) };
    const expected = history([a, b]);
    for (const route of [path, prefix + path]) {
      const streams = path === openaiCount || path === claudeCount ? [undefined] : [false, true];
      for (const stream of streams) {
        const before = sent.length;
        const res = await post(route, { ...body, stream });
        assert.equal(res.status, 200, route);
        const outbound = sent.slice(before);
        assert.deepEqual(outbound.map(req => req.path), countPath ? [countPath, path] : [path]);
        for (const req of outbound) {
          assert.deepEqual(JSON.parse(req.body)[field], expected, req.path);
          assert.doesNotMatch(req.body, /example\.invalid|AAAA/);
        }
      }
    }
  }
});

test('image-only tool outputs, video and uninspectable stored inputs do not reach providers', async t => {
  const { post, sent } = await gateway(t);
  const pdf = claudeDocument({ type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' });
  const docWithImage = claudeDocument({ type: 'content', content: [claudeImage] });
  for (const input of [
    history([{ type: 'input_image', file_id: 'file-picture', detail: 'low' }]),
    history([{ type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERg==' }]),
    history([{ type: 'input_file', file_id: 'file-unknown' }]),
    history([{ type: 'input_video', file_id: 'file-video' }]),
    [{ type: 'function_call_output', call_id: 'call_123', output: [responseImage] }],
    [{ type: 'computer_call_output', call_id: 'call_123', output: { type: 'computer_screenshot', image_url: imageData } }],
    [{ type: 'item_reference', id: 'msg_123' }],
  ]) {
    assert.equal((await post(responses, { input })).status, 400, JSON.stringify(input));
  }
  for (const ref of [{ previous_response_id: 'resp_saved' }, { conversation: 'conv_saved' }, { prompt: { id: 'pmpt_saved' } }]) {
    assert.equal((await post(openaiCount, ref)).status, 400);
  }
  for (const block of [
    { type: 'image', source: { type: 'url', url: imageUrl } },
    { type: 'image', source: { type: 'file', file_id: 'file_picture' } },
    pdf, docWithImage, claudeDocument({ type: 'file', file_id: 'file_unknown' }),
    { type: 'tool_result', tool_use_id: 'tool_123', content: [docWithImage] },
  ]) {
    assert.equal((await post(claudeCount, { messages: history([block]) })).status, 400, block.type);
  }
  assert.equal((await post(chat, { messages: history([{ type: 'file', file: { file_id: 'file-unknown' } }]) })).status, 400);
  assert.deepEqual(sent, []);
});

test('nested tool results, document sources and stored references keep local text and drop inaccessible content', async t => {
  const { post, sent } = await gateway(t);
  const text = { type: 'text', text: 'nested answer' };
  const doc = blocks => claudeDocument({ type: 'content', content: blocks });
  const tool = content => ({ type: 'tool_result', tool_use_id: 'tool_123', content });
  const opaque = claudeDocument({ type: 'file', file_id: 'file_visual' });
  const claude = await post('/anthropic' + messages, { messages: history([tool([doc([claudeImage, text]), opaque])]) });
  assert.equal(claude.status, 200);
  assert.deepEqual(sent.map(req => JSON.parse(req.body).messages), [history([tool([doc([text])])]), history([tool([doc([text])])])]);

  const local = { type: 'input_text', text: 'original text' };
  const functionOutput = output => ({ type: 'function_call_output', call_id: 'call_123', output });
  const openai = await post(responses, {
    previous_response_id: 'resp_saved', conversation: 'conv_saved', prompt: { id: 'pmpt_saved' },
    input: [{ type: 'item_reference', id: 'msg_saved' }, functionOutput([responseImage, local]),
      ...history([{ type: 'input_file', file_id: 'file_opaque' }, local])],
  });
  assert.equal(openai.status, 200);
  for (const req of sent.slice(2)) {
    const parsed = JSON.parse(req.body);
    assert.deepEqual(parsed.input, [functionOutput([local]), ...history([local])]);
    assert.ok(!Object.hasOwn(parsed, 'previous_response_id') && !Object.hasOwn(parsed, 'conversation') && !Object.hasOwn(parsed, 'prompt'));
    assert.doesNotMatch(req.body, /AAAA|file_opaque|msg_saved|resp_saved|conv_saved|pmpt_saved/);
  }
});

test('image-only final user turns do not resubmit an older text turn', async t => {
  const { post, sent } = await gateway(t);
  for (const [route, field, image] of [
    [chat, 'messages', { type: 'image_url', image_url: { url: imageUrl } }],
    [responses, 'input', responseImage], [claudeCount, 'messages', claudeImage],
  ]) {
    const body = { [field]: [...history('Previous question'), { role: 'assistant', content: 'Previous answer' }, ...history([image])] };
    assert.equal((await post(route, body)).status, 400, route);
  }
  assert.deepEqual(sent, []);
});

test('large count payloads, malformed count bodies and duplicate keys cannot forward unseen images', async t => {
  const { post, sent } = await gateway(t);
  // The optional model-name inspector used to skip standalone estimates over 2 MiB.
  const padding = 's'.repeat(2 * 1024 * 1024 + 1);
  assert.equal((await post('/openai' + openaiCount, { input: history([{ type: 'input_text', text: padding }, responseImage]) })).status, 200);
  assert.equal((await post('/anthropic' + claudeCount, { messages: history([claudeImage, { type: 'text', text: padding }]) })).status, 200);
  assert.equal(JSON.parse(sent[0].body).input[0].content[0].text.length, padding.length);
  assert.equal(JSON.parse(sent[1].body).messages[0].content[0].text.length, padding.length);
  assert(sent.every(req => !req.body.includes('AAAA')));
  sent.length = 0;
  for (const path of [openaiCount, claudeCount]) {
    assert.equal((await post(path, '{broken')).status, 400);
    assert.equal((await post(path, '[]')).status, 400);
    assert.equal((await post(path, 'binary', 'application/octet-stream')).status, 415);
  }
  assert.equal((await post(openaiCount, { input: responseImage })).status, 400);
  assert.equal((await post(claudeCount, { messages: claudeImage })).status, 400);
  const picture = JSON.stringify(history([responseImage]));
  assert.equal((await post(openaiCount, '{"model":"test","input":"hello","input":' + picture + '}')).status, 400);
  assert.deepEqual(sent, []);
  const textLast = await post(openaiCount, '{"model":"test","input":' + picture + ',"input":"hello"}');
  if (textLast.status === 200) {
    assert.deepEqual(sent.map(req => JSON.parse(req.body).input), ['hello']);
    assert.doesNotMatch(sent[0].body, /input_image|image_url/);
  } else {
    assert.equal(textLast.status, 400);
    assert.deepEqual(sent, []);
  }
});

test('verified inline text files are sent as text and unavailable file references are dropped', async t => {
  const { post, sent } = await gateway(t);
  const text = '문서 내용\nsecond line';
  const file_data = 'data:text/plain;base64,' + Buffer.from(text, 'utf8').toString('base64');
  const inline = { filename: 'notes.txt', file_data };
  for (const [path, field, parts, cleanPart] of [
    [responses, 'input', [{ type: 'input_file', file_id: 'file_opaque' }, { type: 'input_file', ...inline }], { type: 'input_text', text }],
    [chat, 'messages', [{ type: 'file', file: { file_id: 'file_opaque' } }, { type: 'file', file: inline }], { type: 'text', text }],
  ]) {
    const before = sent.length;
    assert.equal((await post(path, { [field]: history(parts) })).status, 200, path);
    const forwarded = sent.slice(before);
    assert.deepEqual(forwarded.map(req => req.path), path === responses ? [openaiCount, responses] : [chat]);
    for (const req of forwarded) {
      assert.deepEqual(JSON.parse(req.body)[field], history([cleanPart]));
      assert.doesNotMatch(req.body, /base64|file_opaque|notes\.txt/);
    }
  }
});

test('stored message references are dropped while actionable tool results survive a historical image-only user turn', async t => {
  const { post, sent } = await gateway(t);
  const localUser = history('new text question');
  assert.equal((await post(responses, { input: [{ type: 'message', id: 'msg_stored' }, ...localUser] })).status, 200);
  for (const req of sent) {
    assert.deepEqual(JSON.parse(req.body).input, localUser);
    assert.doesNotMatch(req.body, /msg_stored/);
  }
  const call = { type: 'function_call', call_id: 'call123', name: 'lookup', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'call123', output: 'current tool answer' };
  const before = sent.length;
  assert.equal((await post(responses, { input: [...history([responseImage]), call, result] })).status, 200);
  assert.deepEqual(sent.slice(before).map(req => JSON.parse(req.body).input), [[call, result], [call, result]]);
});

test('text, plaintext Claude documents and application-defined JSON stay usable with the same models', async t => {
  const { post, sent } = await gateway(t);
  const caption = 'Markdown ![example](https://example.invalid/photo.png) and literal data:image/png;base64,AAAA';
  const inputs = { type: 'image', image_url: imageUrl };
  const schema = { type: 'object', properties: { image_url: { type: 'string' } } };
  const tool = { type: 'tool_use', id: 'tool_123', name: 'describe_url', input: inputs };
  const historyWithTool = [
    ...history([claudeDocument({ type: 'text', media_type: 'text/plain', data: caption }),
      claudeDocument({ type: 'content', content: [{ type: 'text', text: caption }] })]),
    { role: 'assistant', content: [tool] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: caption }] },
  ];
  for (const [path, body] of [
    [chat, { messages: history(caption), response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } }],
    [responses, { input: history([{ type: 'input_text', text: caption }]) }],
    [openaiCount, { input: [{ type: 'function_call_output', call_id: 'call_123', output: JSON.stringify(inputs) }] }],
    [messages, { messages: historyWithTool, tools: [{ name: 'describe_url', input_schema: schema }] }],
    [claudeCount, { messages: historyWithTool }],
  ]) {
    assert.equal((await post(path, body)).status, 200, path);
  }
  assert.deepEqual(sent.map(req => req.path), [chat, openaiCount, responses, openaiCount, claudeCount, messages, claudeCount]);
});

test('filtering an image preserves exact numeric tool-schema defaults for admission and inference', async t => {
  const { post, sent } = await gateway(t);
  const literal = '12345678901234567890123456789';
  const tools = [{ name: 'size', input_schema: { type: 'object', properties: {
    pixels: { type: 'integer', default: JSON.rawJSON(literal) },
  } } }];
  assert.equal((await post(messages, { tools, messages: history([claudeImage, { type: 'text', text: 'size?' }]) })).status, 200);
  assert.deepEqual(sent.map(req => req.path), [claudeCount, messages]);
  assert(sent.every(req => req.body.includes(literal) && !req.body.includes('AAAA')));
});

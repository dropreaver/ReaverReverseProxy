import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { observeEncodedBody } from '../src/encoded-observer.ts';
import { observeNativeJson } from '../src/native-json.ts';
import { observeNativeStream } from '../src/compact-stream.ts';

test('encoded native replies preserve wire bytes and distinguish usage from errors', async () => {
  const codecs = [
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync], ['zstd', zstdCompressSync],
    ['gzip, br', buffer => brotliCompressSync(gzipSync(buffer))],
  ];
  for (const [encoding, compress] of codecs) {
    for (const [stream, failure, used] of [[false, false, true], [false, true, false], [false, true, true],
      [true, false, true], [true, true, false], [true, true, true]]) {
      const payload = failure ? { error: { message: 'provider offline' } } : { choices: [] };
      if (used) payload.usage = { prompt_tokens: 3 };
      const content = JSON.stringify(payload);
      const wire = compress(Buffer.from(stream ? 'data: ' + content + '\n\ndata: [DONE]\n\n' : content));
      async function* chunks() {
        for (let i = 0; i < wire.length; i += 7) yield wire.subarray(i, i + 7);
      }
      let failed = false;
      let metered = false;
      const onError = () => { failed = true; };
      const onUsage = () => { metered = true; };
      const inspect = decoded => stream
        ? observeNativeStream(decoded, '/v1/chat/completions', onError, onUsage)
        : observeNativeJson(decoded, onError, undefined, onUsage);
      const forwarded = [];
      for await (const chunk of observeEncodedBody(chunks(), encoding, inspect, onError, wire.length)) {
        forwarded.push(chunk);
        if (Buffer.concat(forwarded).length === wire.length) {
          assert.equal(failed, failure, encoding);
          assert.equal(metered, used, encoding);
        }
      }
      assert.deepEqual(Buffer.concat(forwarded), wire, encoding);
    }
  }
});

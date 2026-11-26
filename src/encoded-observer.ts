import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";

const decoders = new Map<string, () => Duplex>([
  ["gzip", createGunzip], ["x-gzip", createGunzip], ["deflate", createInflate],
  ["br", createBrotliDecompress], ["zstd", createZstdDecompress],
]);

export async function* observeEncodedBody(
  source: AsyncIterable<Uint8Array>, encoding: string,
  inspect: (decoded: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>,
  onError?: () => void, expectedLength?: number,
): AsyncGenerator<Uint8Array> {
  const codings = encoding.toLowerCase().split(",").map(value => value.trim()).filter(value => value !== "identity");
  if (!codings.length) { yield* inspect(source); return; }
  // An unknown coding is opaque. Preserve the provider's HTTP outcome.
  if (!codings.every(coding => decoders.has(coding))) { yield* source; return; }

  const chain = codings.reverse().map(coding => decoders.get(coding)!());
  const input = chain[0];
  let closing = false;
  let failed = false;
  function inspectionFailed() {
    if (!closing && !failed) onError?.();
    failed = true;
  }
  async function drain(decoded: AsyncIterable<Uint8Array>) {
    for await (const _chunk of inspect(decoded)) { /* Only quota needs the decoded representation. */ }
  }
  const inspected = pipeline([...chain, drain]).catch(inspectionFailed);
  let size = 0;
  let ended = false;
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (!failed && !ended) {
        if (size === expectedLength) {
          // Content-Length completes the client's HTTP body as soon as this chunk is sent.
          input.end(chunk);
          ended = true;
          await inspected;
        } else if (!input.destroyed) {
          await new Promise<void>(resolve => {
            // A decoder can close on corrupt bytes without completing the write.
            function settled(error?: Error | null) {
              input.off("close", settled);
              if (error) inspectionFailed();
              resolve();
            }
            input.once("close", settled);
            input.write(chunk, settled);
          });
        }
      }
      yield chunk;
    }
    if (!ended && !failed) input.end();
    await inspected;
  } catch (error) {

    inspectionFailed();
    throw error;
  } finally {
    closing = true;
    input.destroy();
    await inspected;
  }
}

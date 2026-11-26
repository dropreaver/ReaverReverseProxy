import type { Provider } from './routes.ts';
import type { ProviderKeys } from './provider-keys.ts';
import { keyLimitedUntil } from './key-limits.ts';

type Availability = 'fresh' | 'stale' | 'unavailable';

interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  provider: Provider;
}

interface CacheEntry {
  models?: Model[];
  fetchedAt: number;
  retryAt: number;
  limited?: boolean;
  pending?: Promise<void>;
}

const freshForMs = 60_000;
const staleForMs = 15 * 60_000;
const retryDelayMs = 5_000;
const fetchTimeoutMs = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModel(value: unknown, provider: Provider): Model {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('Invalid model entry');
  }
  const timestamp = typeof value.created_at === 'string' ? Date.parse(value.created_at) / 1000 : 0;
  const created = typeof value.created === 'number' ? value.created : timestamp;
  return {
    id: value.id,
    object: 'model',
    created: Number.isFinite(created) ? Math.floor(created) : 0,
    owned_by: typeof value.owned_by === 'string' ? value.owned_by : provider,
    provider,
  };
}

// A permanent HTTP failure (for example a revoked credential) invalidates the old list.
class PermanentCatalogError extends Error {}
class CatalogKeyLimit extends Error {}

async function readCatalogError(response: Response): Promise<unknown> {
  const maxBytes = 16_384;
  if (!response.body) return;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      size += value.length;
      if (size > maxBytes) return;
      chunks.push(value);
    }
  } catch {
    // A non-JSON or interrupted error still has an HTTP status and headers.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchModels(provider: Provider, key: string, keys: ProviderKeys): Promise<Model[]> {
  const anthropic = provider === 'anthropic';
  const url = new URL(anthropic ? 'https://api.anthropic.com/v1/models' : 'https://api.openai.com/v1/models');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2026-10-21';
    url.searchParams.set('limit', '1000');
  } else {
    headers.authorization = `Bearer ${key}`;
  }

  const signal = AbortSignal.timeout(fetchTimeoutMs);
  const models = new Map<string, Model>();
  const cursors = new Set<string>();
  for (;;) {
    const response = await fetch(url, { headers, redirect: 'error', signal });
    const receivedAt = Date.now();
    function observeLimit(payload?: unknown): boolean {
      const until = keyLimitedUntil(provider, response.status, response.headers, payload, receivedAt);
      if (until === undefined) return false;
      keys.suppress(provider, key, until);
      return true;
    }
    const limited = observeLimit();
    if (!response.ok) {
      if (observeLimit(await readCatalogError(response)) || limited) throw new CatalogKeyLimit();
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        throw new PermanentCatalogError();
      }
      throw new Error('Provider catalog unavailable');
    }
    const page: unknown = await response.json();
    if (!isRecord(page) || !Array.isArray(page.data)) {
      if (observeLimit(page)) throw new CatalogKeyLimit();
      throw new Error('Invalid catalog');
    }
    let lastModelId: string | undefined;
    for (const value of page.data) {
      const model = normalizeModel(value, provider);
      models.set(model.id, model);
      lastModelId = model.id;
    }
    if (page.has_more !== true) return [...models.values()];
    // A refresh pins one key. An exhausted page cannot be continued with another key.
    if (limited) throw new CatalogKeyLimit();
    const cursor = typeof page.last_id === 'string' ? page.last_id : lastModelId;
    if (!cursor || cursors.has(cursor)) throw new Error('Invalid pagination cursor');
    cursors.add(cursor);
    url.searchParams.set(anthropic ? 'after_id' : 'after', cursor);
  }
}

async function refresh(provider: Provider, keys: ProviderKeys, entry: CacheEntry): Promise<void> {
  try {
    const selection = keys.select(provider);
    if (selection.status === 'exhausted') throw new CatalogKeyLimit();
    if (selection.status === 'unconfigured') throw new PermanentCatalogError();
    entry.models = await fetchModels(provider, selection.key, keys);
    entry.limited = false;
    entry.fetchedAt = Date.now();
    entry.retryAt = entry.fetchedAt + freshForMs;
  } catch (error) {
    if (error instanceof PermanentCatalogError) entry.models = undefined;
    entry.limited = error instanceof CatalogKeyLimit;
    // Another configured key can serve the very next reader. The pool tracks
    // reset times and avoids upstream calls when all keys are unavailable.
    entry.retryAt = entry.limited ? 0 : Date.now() + retryDelayMs;
  }
}

async function providerCatalog(provider: Provider, entry: CacheEntry, keys: ProviderKeys) {
  if (Date.now() >= entry.retryAt) {
    entry.pending ??= refresh(provider, keys, entry).finally(() => { entry.pending = undefined; });
    await entry.pending;
  }
  const age = Date.now() - entry.fetchedAt;
  let availability: Availability = 'unavailable';
  if (entry.models && age < staleForMs) availability = age < freshForMs ? 'fresh' : 'stale';
  return { provider, availability, limited: entry.limited, models: availability === 'unavailable' ? [] : entry.models! };
}

// Other callers can still be waiting for the same bounded refresh.
async function waitForCatalog<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createCatalog(configured: readonly Provider[], keys: ProviderKeys) {
  const cache = new Map<Provider, CacheEntry>(configured.map(provider => [provider, { fetchedAt: 0, retryAt: 0 }]));
  return async function getCatalog(signal?: AbortSignal): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
    signal?.throwIfAborted();
    if (!cache.size) {
      return { status: 503, body: { error: { message: 'No model providers are configured.' } } };
    }
    const pending = Promise.all(Array.from(cache, ([provider, entry]) => providerCatalog(provider, entry, keys)));
    const results = await waitForCatalog(pending, signal);
    const states = Object.fromEntries(results.map(r => [r.provider, r.availability]));
    if (results.every(r => r.availability === 'unavailable')) {
      if (results.every(r => r.limited)) {
        const selections = results.map(r => keys.peek(r.provider));
        const retry = Math.min(...selections.map(s => s.status === 'exhausted' ? s.retryAfterSeconds ?? Infinity : 0));
        return { status: 429, retryAfterSeconds: retry > 0 && Number.isFinite(retry) ? retry : undefined,
          body: { error: { type: 'rate_limit_error', message: 'Provider model catalogs are quota limited.' }, providers: states } };
      }
      return { status: 502, body: { error: { message: 'Provider model catalogs are unavailable.' }, providers: states } };
    }
    return {
      status: 200,
      body: {
        object: 'list',
        data: results.flatMap(r => r.models),
        partial: results.some(r => r.availability !== 'fresh'),
        providers: states,
      },
    };
  };
}

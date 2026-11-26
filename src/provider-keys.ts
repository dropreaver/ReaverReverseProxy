import type { Provider } from './routes.ts';

export type KeySelection =
  | { status: 'ready'; key: string }
  | { status: 'unconfigured' }
  | { status: 'exhausted'; retryAfterSeconds?: number };

function keyPool(keys: readonly string[]) {
  const availableAt = new Map<string, number>(keys.map(key => [key, 0]));
  return { keys: [...availableAt.keys()], availableAt, nextIndex: 0 };
}

export class ProviderKeys {
  #pools: Record<Provider, ReturnType<typeof keyPool>>;

  constructor(keys: Record<Provider, readonly string[]>) {
    this.#pools = { openai: keyPool(keys.openai), anthropic: keyPool(keys.anthropic) };
  }

  select(provider: Provider): KeySelection {
    return this.#lookup(provider, true);
  }

  peek(provider: Provider): KeySelection {
    return this.#lookup(provider, false);
  }

  #lookup(provider: Provider, advance: boolean): KeySelection {
    const pool = this.#pools[provider];
    if (!pool.keys.length) return { status: 'unconfigured' };

    const now = Date.now();
    let earliest = Infinity;
    for (let offset = 0; offset < pool.keys.length; offset++) {
      const index = (pool.nextIndex + offset) % pool.keys.length;
      const key = pool.keys[index];
      const availableAt = pool.availableAt.get(key)!;
      if (availableAt <= now) {
        if (advance) pool.nextIndex = (index + 1) % pool.keys.length;
        return { status: 'ready', key };
      }
      earliest = Math.min(earliest, availableAt);
    }
    if (earliest === Infinity) return { status: 'exhausted' };
    return { status: 'exhausted', retryAfterSeconds: Math.ceil((earliest - now) / 1000) };
  }

  // A late response from an in-flight call can extend a deadline but never shorten it.
  suppress(provider: Provider, key: string, until: number) {
    const deadlines = this.#pools[provider].availableAt;
    const previous = deadlines.get(key);
    if (previous !== undefined && until > previous) deadlines.set(key, until);
  }
}

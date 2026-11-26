import type { Provider } from './routes.ts';
import type { compactUsage } from './token-usage.ts';

type TokenCounts = ReturnType<typeof compactUsage>;
type ModelRow = TokenCounts & {
  provider: Provider;
  model: string;
  requests: number;
  incomplete_requests: number;
};

const tokenFields = ['input_tokens', 'output_tokens', 'total_tokens'] as const;

export class ModelUsage {
  #since = new Date().toISOString();
  #accounts = new Map<number, Map<string, ModelRow>>();

  record(account: number, provider: Provider, model: string, usage: TokenCounts & { complete: boolean }) {
    let models = this.#accounts.get(account);
    if (!models) {
      models = new Map();
      this.#accounts.set(account, models);
    }
    const key = provider + '/' + model;
    let row = models.get(key);
    if (!row) {
      row = { provider, model, requests: 0, incomplete_requests: 0,
        input_tokens: null, output_tokens: null, total_tokens: null };
      models.set(key, row);
    }
    row.requests++;
    if (!usage.complete) row.incomplete_requests++;
    for (const field of tokenFields) {
      const value = usage[field];
      if (value !== null) row[field] = (row[field] ?? 0) + value;
    }
  }

  report(account: number) {
    const data = Array.from(this.#accounts.get(account)?.values() ?? [], row => ({ ...row }));
    data.sort((a, b) => a.provider.localeCompare(b.provider, 'en') || a.model.localeCompare(b.model, 'en'));
    return { since: this.#since, data };
  }
}

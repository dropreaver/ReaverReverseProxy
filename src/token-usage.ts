type Fields = Record<string, unknown>;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sum(...values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return count(total);
}

export function compactUsage(path: string, raw: unknown) {
  const usage: Fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Fields : {};
  const chat = path === '/v1/chat/completions';
  let input = count(chat ? usage.prompt_tokens : usage.input_tokens);
  const output = count(chat ? usage.completion_tokens : usage.output_tokens);
  if (path === '/v1/messages') {
    // Anthropic's three buckets are disjoint. The nested TTL breakdown is already included.
    input = sum(input, count(usage.cache_creation_input_tokens ?? 0), count(usage.cache_read_input_tokens ?? 0));
  }
  return { input_tokens: input, output_tokens: output, total_tokens: count(usage.total_tokens) ?? sum(input, output) };
}

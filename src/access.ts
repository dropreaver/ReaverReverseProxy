import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { isIP, SocketAddress } from 'node:net';

function values(value?: string): string[] {
  return [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function providerLimits(env: NodeJS.ProcessEnv, prefix: 'OPENAI' | 'ANTHROPIC') {
  function limit(name: string, fallback: number) {
    const override = `${prefix}_${name}`;
    return positiveInt(env, env[override]?.trim() ? override : name, fallback);
  }
  return {
    maxInputTokens: limit('MAX_INPUT_TOKENS', 100_000),
    maxOutputTokens: limit('MAX_OUTPUT_TOKENS', 10_000),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function readConfig(env: NodeJS.ProcessEnv) {
  const keys = { openai: values(env.OPENAI_API_KEY), anthropic: values(env.ANTHROPIC_API_KEY) };
  if (env.PROVIDER_KEYS_FILE && (!keys.openai.length || !keys.anthropic.length)) {
    const lines = readFileSync(env.PROVIDER_KEYS_FILE, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const pool = /^sk-ant-[A-Za-z0-9_-]+$/.test(line) ? keys.anthropic
        : /^sk-[A-Za-z0-9_-]+$/.test(line) ? keys.openai : undefined;
      if (!pool) throw new Error('PROVIDER_KEYS_FILE expects one unquoted provider key per line.');
      if (!pool.length) pool.push(line);
    }
  }
  if (!keys.openai.length && !keys.anthropic.length) throw new Error('Configure OPENAI_API_KEY or ANTHROPIC_API_KEY.');
  const tokens = values(env.PROXY_TOKENS);
  const providerKeys = new Set([...keys.openai, ...keys.anthropic]);
  if (!tokens.length || tokens.some(token => providerKeys.has(token))) {
    throw new Error('Configure PROXY_TOKENS with credentials separate from provider API keys.');
  }
  const origins = new Set(values([env.ALLOWED_ORIGINS, env.ADDITIONAL_ALLOWED_ORIGINS].join(',')).map(value => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Invalid URL in the browser origin allowlist.'); }
    if (!['http:', 'https:'].includes(url.protocol) || value.replace(/\/$/, '') !== url.origin || url.hostname.includes('*')) {
      throw new Error('The browser origin allowlist requires exact HTTP(S) origins.');
    }
    return url.origin;
  }));
  const port = positiveInt(env, 'PORT', 3000);
  if (port > 65535) throw new Error('PORT must be at most 65535.');
  return {
    port, keys, origins, tokenHashes: tokens.map(digest),
    renderIngress: env.RENDER === 'true',
    maxActive: positiveInt(env, env.MAX_ACTIVE_PER_USER?.trim() ? 'MAX_ACTIVE_PER_USER' : 'MAX_ACTIVE_PER_TOKEN', 8),
    requestsPerMinute: positiveInt(env, 'REQUESTS_PER_MINUTE', 3),
    maxBodyBytes: positiveInt(env, 'MAX_BODY_BYTES', 32 * 1024 * 1024),
    tokenLimits: { openai: providerLimits(env, 'OPENAI'), anthropic: providerLimits(env, 'ANTHROPIC') },
  };
}

export type Config = ReturnType<typeof readConfig>;

const minute = 60_000;
type GenerationSlot = { startedAt: number };
type ClientUsage = { active: number; started: GenerationSlot[] };

function clientAddress(req: IncomingMessage, renderIngress: boolean): string {
  // The public Render edge overwrites this field. A direct server uses its TCP peer.
  const source = renderIngress ? req.headers['cf-connecting-ip'] : req.socket.remoteAddress;
  if (typeof source === 'string') {
    const address = source.trim();
    if (isIP(address) === 4) return address;
    if (!address.includes('%') && isIP(address) === 6) {
      const canonical = new SocketAddress({ family: 'ipv6', address }).address;
      return canonical.replace(/^::ffff:(?=\d+\.)/, '');
    }
  }
  // Unidentified requests on one credential share a single quota.
  return 'unknown';
}

export class AccessGate {
  readonly config: Config;
  readonly clients: Map<string, ClientUsage>[];
  readonly cleanup: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;
    this.clients = config.tokenHashes.map(() => new Map());
    this.cleanup = setInterval(() => {
      const cutoff = Date.now() - minute;
      for (const users of this.clients) {
        for (const [ip, state] of users) {
          if (!state.active && (state.started.at(-1)?.startedAt ?? -Infinity) <= cutoff) users.delete(ip);
        }
      }
    }, minute).unref();
  }

  close() {
    clearInterval(this.cleanup);
  }

  authenticate(headers: IncomingHttpHeaders, protocolToken?: string): number {
    const bearer = headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    const key = headers['x-api-key'];
    if (Array.isArray(key) || (headers.authorization && !bearer)) return -1;
    const credentials = new Set([bearer, key, protocolToken].filter(Boolean));
    if (credentials.size !== 1) return -1;
    const actual = digest([...credentials][0]!);
    return this.config.tokenHashes.findIndex(hash => timingSafeEqual(hash, actual));
  }

  admit(index: number, req: IncomingMessage, countRequest: boolean):
    { release: (chargeGeneration: boolean) => void } | { waitSeconds: number } {
    const users = this.clients[index];
    const ip = clientAddress(req, this.config.renderIngress);
    const state: ClientUsage = users.get(ip) ?? { active: 0, started: [] };
    const now = Date.now();
    state.started = state.started.filter(slot => slot.startedAt > now - minute);
    if (countRequest && state.started.length >= this.config.requestsPerMinute) {
      return { waitSeconds: Math.max(1, Math.ceil((state.started[0].startedAt + minute - now) / 1000)) };
    }
    if (state.active >= this.config.maxActive) return { waitSeconds: 1 };
    // Two requests admitted in the same millisecond must be refundable independently.
    const reservation = countRequest ? { startedAt: now } : undefined;
    if (reservation) state.started.push(reservation);
    state.active++;
    users.set(ip, state);
    let released = false;
    return {
      release(chargeGeneration: boolean) {
        if (released) return;
        released = true;
        if (reservation && !chargeGeneration) {
          const position = state.started.indexOf(reservation);
          if (position !== -1) state.started.splice(position, 1);
        }
        state.active--;
        if (!state.active && !state.started.length) users.delete(ip);
      },
    };
  }
}

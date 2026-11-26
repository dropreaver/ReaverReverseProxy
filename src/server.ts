import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccessGate, readConfig } from './access.ts';
import type { Config } from './access.ts';
import { createCatalog } from './catalog.ts';
import { ProviderKeys } from './provider-keys.ts';
import { GenerationMeter } from './model-meter.ts';
import { ModelUsage } from './model-usage.ts';
import { budgetFields, tokenCountPaths } from './routes.ts';
import { RelayError, relay, resolveRoute } from './upstream.ts';
import { rejectVoiceUpgrade } from './voice.ts';

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function failure(res: ServerResponse, status: number, message: string, claude = false) {
  const names: Record<number, string> = {
    400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
    404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error',
  };
  const error = { type: names[status] ?? 'api_error', message };
  json(res, status, claude ? { type: 'error', error } : { error });
}

function cors(req: IncomingMessage, res: ServerResponse, config: Config): boolean {
  const origin = req.headers.origin;
  res.setHeader('vary', 'Origin');
  if (!origin) return true;
  if (!config.origins.has(origin)) { failure(res, 403, 'Browser origin is not configured.'); return false; }
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-expose-headers', 'retry-after, request-id, x-request-id, x-proxy-request-id');
  if (req.method === 'OPTIONS') {
    res.setHeader('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    // Origins are operator-approved. The relay independently selects safe upstream headers.
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? 'content-type, authorization, x-api-key');
    res.setHeader('access-control-max-age', '600');
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('access-control-allow-private-network', 'true');
  }
  return true;
}

function pathname(req: IncomingMessage): string | undefined {
  const target = req.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return;
  try { return new URL(target, 'http://localhost').pathname; } catch { return; }
}

export function createGateway(config: Config) {
  const gate = new AccessGate(config);
  const keys = new ProviderKeys(config.keys);
  const modelUsage = new ModelUsage();
  const providers = (['openai', 'anthropic'] as const).filter(provider => config.keys[provider].length > 0);
  const getCatalog = createCatalog(providers, keys);
  const server = createServer(async (req, res) => {
    const path = pathname(req);
    if (!path) return failure(res, 400, 'Invalid request path.');
    if (!cors(req, res, config)) return;
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });

    const method = req.method === 'OPTIONS' ? String(req.headers['access-control-request-method'] ?? 'GET') : req.method!;
    const combined = method === 'GET' && path === '/v1/models';
    const usageReport = method === 'GET' && path === '/v1/usage/models';
    const route = resolveRoute(method, path);
    if (!combined && !usageReport && !route) return failure(res, 404, 'Unknown inference route.');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const claude = !combined && route?.provider === 'anthropic';
    const account = gate.authenticate(req.headers);
    if (account < 0) return failure(res, 401, 'A valid proxy token is required.', claude);
    if (usageReport) return json(res, 200, modelUsage.report(account));
    const generation = route !== undefined && budgetFields[route.path] !== undefined;
    if (method === 'POST' && route && !generation && !tokenCountPaths.has(route.path)) {
      return failure(res, 403, 'This endpoint cannot enforce the proxy input and output token limits.', claude);
    }
    const slot = gate.admit(account, req, generation);
    if ('waitSeconds' in slot) {
      res.setHeader('retry-after', slot.waitSeconds);
      return failure(res, 429, 'Proxy request limit reached.', claude);
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    const id = randomUUID();
    res.setHeader('x-proxy-request-id', id);
    const started = Date.now();
    let model: string | undefined;
    let usageObserved = false;
    const meter = generation && route ? new GenerationMeter(route.path) : undefined;
    try {
      if (combined) {
        const page = await getCatalog(controller.signal);
        if (page.retryAfterSeconds !== undefined) res.setHeader('retry-after', page.retryAfterSeconds);
        json(res, page.status, page.body);
      } else if (route) {
        const selected = keys.select(route.provider);
        if (selected.status === 'unconfigured') return failure(res, 503, 'This provider is not configured.', claude);
        if (selected.status === 'exhausted') {
          if (selected.retryAfterSeconds !== undefined) res.setHeader('retry-after', selected.retryAfterSeconds);
          return failure(res, 429, 'All configured keys for this provider have reached a usage limit.', claude);
        }
        await relay(req, res, route, selected.key, controller.signal, config, {
          onUsage() { usageObserved = true; },
          onModel(name) { model = name; },
          onMeter: meter && ((payload, partial) => meter.observe(payload, partial)),
          onKeyLimited(until) { keys.suppress(route.provider, selected.key, until); },
        });
      }
    } catch (err) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof RelayError) failure(res, err.status, err.message, claude);
      else failure(res, 502, 'Unable to complete the provider request.', claude);
    } finally {
      slot.release(usageObserved);
      const measured = usageObserved && meter ? meter.snapshot() : undefined;
      let tokenUsage;
      if (measured && route) {
        model = measured.model ?? model ?? 'unknown';
        const { input_tokens, output_tokens, total_tokens, complete } = measured;
        tokenUsage = { input_tokens, output_tokens, total_tokens, complete };
        modelUsage.record(account, route.provider, model, tokenUsage);
      }
      console.info(JSON.stringify({ id, provider: combined ? 'catalog' : route?.provider, model,
        generation_counted: generation ? usageObserved : undefined,
        token_usage: tokenUsage,
        status: controller.signal.aborted ? 499 : res.statusCode, elapsed_ms: Date.now() - started }));
    }
  });
  server.on('upgrade', (req, socket) => {
    if (!pathname(req)) { socket.destroy(); return; }
    rejectVoiceUpgrade(req, socket, gate);
  });
  server.headersTimeout = 30_000;
  server.once('close', () => gate.close());
  return server;
}

if (import.meta.main) {
  const config = readConfig(process.env);
  const host = process.env.HOST || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
  const server = createGateway(config);
  server.listen(config.port, host, () => console.info(JSON.stringify({
    event: 'gateway_ready', host, port: config.port, provider_token_limits: config.tokenLimits,
    provider_key_counts: { openai: config.keys.openai.length, anthropic: config.keys.anthropic.length },
    requests_per_minute: config.requestsPerMinute,
    rate_limit_identity: config.renderIngress ? 'proxy_token_and_render_client_ip' : 'proxy_token_and_socket_ip',
  })));
  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ModelUsage } from '../src/model-usage.ts';
import { safeModelId } from '../src/model-meter.ts';

const week = 7 * 24 * 60 * 60 * 1000;
const fields = ['input_tokens', 'output_tokens', 'total_tokens'];
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
class ReportError extends Error {}

function parseOptions(args) {
  try {
    const { values } = parseArgs({ args, options: {
      stdin: { type: 'boolean' }, render: { type: 'boolean' }, service: { type: 'string' },
    } });
    if (!(values.stdin && (values.render || values.service))) return values;
  } catch { /* Keep unexpectedly supplied arguments out of the error message. */ }
  throw new ReportError('Usage: node scripts/model-usage.mjs [--render [--service ID] | --stdin]');
}

class LogReport {
  ledger = new ModelUsage();
  seen = new Set();
  skipped = 0;

  add(line) {
    if (!line.includes('"token_usage"')) return;
    let event;
    try {
      // The Dashboard can prefix an application's single-line JSON with a timestamp and instance.
      event = JSON.parse(line.slice(line.indexOf('{')));
    } catch {
      this.skipped++;
      return;
    }
    if (event?.generation_counted !== true) return;
    const { id, provider, token_usage: usage } = event;
    const model = safeModelId(event.model);
    if (typeof id !== 'string' || !uuid.test(id) || !['openai', 'anthropic'].includes(provider) ||
        !model || typeof usage?.complete !== 'boolean' ||
        !fields.every(field => usage[field] === null || (Number.isSafeInteger(usage[field]) && usage[field] >= 0)) ||
        (usage.complete && fields.some(field => usage[field] === null))) {
      this.skipped++;
      return;
    }
    if (this.seen.has(id)) return;
    this.seen.add(id);
    // The service operator can report across all proxy tokens using the same aggregation as the live view.
    this.ledger.record(0, provider, model, usage);
  }

  output(source, since, until) {
    return { source, since, until, skipped_usage_lines: this.skipped, data: this.ledger.report(0).data };
  }
}

async function getJson(url, apiKey, fetchImpl) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ReportError('Could not reach the Render API.');
    }
    if (response.ok) {
      try { return await response.json(); }
      catch { throw new ReportError('Render returned an invalid JSON response.'); }
    }
    await response.body?.cancel();
    if (response.status !== 429 || attempt >= 2) throw new ReportError('Render API returned HTTP ' + response.status + '.');
    const retry = response.headers.get('retry-after');
    const reset = Number(response.headers.get('ratelimit-reset')) * 1000 - Date.now();
    const wait = retry !== null && /^\d+$/.test(retry) ? Number(retry) * 1000 : reset > 0 ? reset : 60_000;
    // Log queries have a one-minute rate-limit window. Surface longer limits for an operator to retry.
    if (wait > 65_000) throw new ReportError('Render rate-limited this report. Retry after the current rate-limit window.');
    await delay(wait);
  }
}

export async function usageReport(args, { env = process.env, input = process.stdin, fetchImpl = fetch, now = Date.now() } = {}) {
  const options = parseOptions(args);
  const report = new LogReport();
  if (options.stdin) {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) report.add(line);
    return report.output('stdin', null, null);
  }
  const apiKey = env.RENDER_API_KEY?.trim();
  if (!apiKey) throw new ReportError('Set RENDER_API_KEY locally or supply log lines with --stdin.');
  const service = (options.service ?? env.RENDER_SERVICE_ID)?.trim();
  if (!service) throw new ReportError('Pass --service ID or set RENDER_SERVICE_ID.');
  if (!/^srv-[a-z0-9]+$/i.test(service)) throw new ReportError('Expected a Render service ID beginning with srv-.');
  let owner = env.RENDER_OWNER_ID;
  if (!owner) {
    const metadata = await getJson(new URL('https://api.render.com/v1/services/' + service), apiKey, fetchImpl);
    owner = metadata?.ownerId;
    if (typeof owner !== 'string' || !owner) throw new ReportError('The Render service response did not include its ownerId.');
  }
  const since = new Date(now - week).toISOString();
  const until = new Date(now).toISOString();
  const url = new URL('https://api.render.com/v1/logs');
  url.search = new URLSearchParams({ ownerId: owner, resource: service, type: 'app', text: 'token_usage',
    direction: 'forward', limit: '100', startTime: since, endTime: until });
  const cursors = new Set();
  while (!cursors.has(url.search)) {
    cursors.add(url.search);
    const page = await getJson(url, apiKey, fetchImpl);
    if (!Array.isArray(page?.logs) || typeof page.hasMore !== 'boolean') {
      throw new ReportError('Render returned an invalid log page.');
    }
    for (const entry of page.logs) {
      if (typeof entry?.message !== 'string') throw new ReportError('Render returned an invalid log entry.');
      report.add(entry.message);
    }
    if (!page.hasMore) return report.output('render_logs', since, until);
    if (![page.nextStartTime, page.nextEndTime].every(time => typeof time === 'string' && Number.isFinite(Date.parse(time)))) {
      throw new ReportError('Render did not provide the next log page.');
    }
    // Keep the original precision of Render's timestamps even on runtimes that parse only milliseconds.
    url.searchParams.set('startTime', page.nextStartTime);
    url.searchParams.set('endTime', page.nextEndTime);
  }
  throw new ReportError('Render returned a repeated log page cursor.');
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await usageReport(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(error instanceof ReportError ? error.message : 'Could not read the usage report.');
    process.exitCode = 1;
  }
}

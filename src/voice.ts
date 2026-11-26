import type { IncomingMessage } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AccessGate } from './access.ts';

function reject(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

// A realtime session can run multiple generations outside the HTTP token and request budgets.
export function rejectVoiceUpgrade(req: IncomingMessage, client: Duplex, gate: AccessGate) {
  client.on('error', () => client.destroy());
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/^\/openai\//, '/');
  if (req.method !== 'GET' || !['/v1/realtime', '/v1/realtime/translations', '/v1/live/sessions'].includes(path)) return reject(client, 404);
  const allowedQuery = path === '/v1/realtime' ? ['model', 'intent']
    : path === '/v1/realtime/translations' ? ['model'] : [];
  if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key))) return reject(client, 400);
  if (req.headers.origin && !gate.config.origins.has(req.headers.origin)) return reject(client, 403);
  const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
  const protocolAuth = protocols.filter(item => item.startsWith('openai-insecure-api-key.'));
  if (protocolAuth.length > 1) return reject(client, 400);
  const index = gate.authenticate(req.headers, protocolAuth[0]?.slice('openai-insecure-api-key.'.length));
  if (index < 0) return reject(client, 401);
  reject(client, 403);
}

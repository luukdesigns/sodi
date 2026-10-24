import { type Server, createServer } from 'node:http';

import type { SessionIssuer } from './issuer.js';

const MAX_BODY = 4 * 1024;

/**
 *   GET  /health     liveness
 *   POST /status     signed by an agent -> kill switch, limits, what's left
 *   POST /sessions   signed by an agent -> funds the agent's session address
 *   POST /precommitment  signed by an agent -> a new deposit of the owner's to recycle a session into
 *
 * Listens on localhost by default. Put it behind HTTPS if the agent runs on another machine;
 * requests are signed and carry only public data, but TLS keeps the timing of sessions private.
 */
export function startServer(issuer: SessionIssuer, port: number, host = '127.0.0.1', opts: { requestsPerMinute?: number } = {}): Server {
  const perMinute = opts.requestsPerMinute ?? 30;
  const hits = new Map<string, number[]>();
  const limited = (ip: string) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length > perMinute;
  };

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || !['/sessions', '/status', '/precommitment'].includes(path)) return send(404, { error: 'not found' });
    if (limited(req.socket.remoteAddress ?? 'unknown')) return send(429, { error: 'too many requests' });

    let raw = '';
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return send(413, { error: 'request too large' });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: 'invalid JSON', reason: 'bad-request' });
      }
      const reply = await issuer.handle(path, body);
      send(reply.status, reply.body);
    });
  });
  // Funding waits for a proof and a transaction; don't cut it off.
  server.requestTimeout = 600_000;
  server.listen(port, host);
  return server;
}

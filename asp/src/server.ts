import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import type { ServiceState } from './state.js';

/**
 * Read-only HTTP API. Wallets and the rx402 SDK fetch the approved labels from here to build the
 * ASP inclusion proof a private withdrawal needs.
 *
 *   GET /health                 service status
 *   GET /association-set        the latest published set (root, cid, labels)
 *   GET /association-set/:cid   a specific published set
 *   GET /deposits/:label        screening status of one deposit
 */
export function startServer(port: number, getState: () => ServiceState, setsDir: string, host?: string): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });

    const state = getState();
    const path = (req.url ?? '/').split('?')[0]!;
    const latest = state.published.at(-1);

    if (path === '/health') {
      return send(200, {
        ok: true,
        chainId: state.chainId,
        entrypoint: state.entrypoint,
        lastScannedBlock: state.lastScannedBlock,
        deposits: state.deposits.length,
        latestRoot: latest?.root ?? null,
      });
    }

    const setMatch = path.match(/^\/association-set(?:\/([a-z0-9]+))?$/);
    if (setMatch) {
      const cid = setMatch[1] ?? latest?.cid;
      if (!cid) return send(404, { error: 'no association set published yet' });
      const file = join(setsDir, `${cid}.json`);
      if (!/^[a-z0-9]+$/.test(cid) || !existsSync(file)) return send(404, { error: 'unknown cid' });
      return send(200, { cid, ...JSON.parse(readFileSync(file, 'utf8')) });
    }

    const depMatch = path.match(/^\/deposits\/(\d+)$/);
    if (depMatch) {
      const d = state.deposits.find((x) => x.label === depMatch[1]);
      if (!d) return send(404, { error: 'unknown label' });
      return send(200, { label: d.label, status: d.status, reason: d.reason ?? null, timestamp: d.timestamp });
    }

    return send(404, { error: 'not found' });
  });
  server.listen(port, host);
  return server;
}

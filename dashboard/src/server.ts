/**
 * The dashboard's HTTP server. It runs on the owner's machine next to the agent and listens on
 * localhost only.
 *
 *   GET  /                 the app
 *   GET  /api/state        needs the owner or the read-only token
 *   PUT  /api/controls     needs the owner token
 *
 * Tokens travel in the Authorization header, never in cookies, so other websites open in the same
 * browser can't act as the owner. Requests whose Host isn't localhost are refused, which stops DNS
 * rebinding.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';

import { type DashboardSources, buildState, parseControls } from './state.js';

export interface DashboardOptions {
  port: number;
  sources: DashboardSources;
  /** Saves controls; the agent re-reads them before every payment. */
  saveControls: (c: ReturnType<typeof parseControls>) => void;
  ownerToken?: string;
  /** Token for a read-only view (for an accountant on this machine); omit to disable. */
  viewerToken?: string;
  log?: (m: string) => void;
}

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export const newToken = () => randomBytes(24).toString('base64url');

function same(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startDashboard(opts: DashboardOptions): { server: Server; ownerToken: string; viewerToken?: string } {
  const ownerToken = opts.ownerToken ?? newToken();
  const log = opts.log ?? (() => {});

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...(type.startsWith('text/html')
          ? { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" }
          : {}),
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (!LOCAL_HOSTS.test(req.headers.host ?? '')) return send(421, { error: 'dashboard only answers on localhost' });
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/') return send(200, page, 'text/html; charset=utf-8');

      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const isOwner = same(ownerToken, token);
      const isViewer = !isOwner && opts.viewerToken !== undefined && same(opts.viewerToken, token);

      if (path === '/api/state' && req.method === 'GET') {
        if (!isOwner && !isViewer) return send(401, { error: 'missing or wrong token' });
        return send(200, { role: isOwner ? 'owner' : 'viewer', ...(await buildState(opts.sources)) });
      }
      if (path === '/api/controls' && req.method === 'PUT') {
        if (!isOwner) return send(isViewer ? 403 : 401, { error: isViewer ? 'read-only access' : 'missing or wrong token' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10_000) return send(413, { error: 'too large' });
        }
        let controls;
        try {
          controls = parseControls(JSON.parse(raw));
        } catch (err) {
          return send(400, { error: (err as Error).message });
        }
        opts.saveControls(controls);
        log(`controls updated: ${JSON.stringify(controls)}`);
        return send(200, { ok: true, controls: opts.sources.controls.load() });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      return send(500, { error: 'internal error' });
    }
  });
  server.listen(opts.port, '127.0.0.1');
  return { server, ownerToken, viewerToken: opts.viewerToken };
}

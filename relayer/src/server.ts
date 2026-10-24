import { createServer, type Server } from 'node:http';

import { RelayError, type RelaySubmitter, type RelayerSettings, checkFundTerms, checkRecycleTerms, checkTerms, parseFundRequest, parseRecycleRequest, parseRelayRequest } from './relay.js';

const MAX_BODY = 16 * 1024;

/**
 *   GET  /health   status
 *   GET  /quote    fee terms; clients bake these into the withdrawal they prove
 *   POST /relay    { withdrawal, proof, scope } -> { txHash }
 *   POST /recycle  a signed SodiRecycler authorization -> { txHash }   (when a recycler is configured)
 *   POST /fund     { withdrawal, proof } for the yield pool's SessionFunder -> { txHash }   (when a funder is configured)
 */
export function startServer(
  port: number,
  chainId: number,
  settings: RelayerSettings,
  submitter: RelaySubmitter,
  log: (m: string) => void = () => {},
  opts: { host?: string; requestsPerMinute?: number } = {},
): Server {
  // Per-IP rate limit on /relay: each request costs the relayer a simulation.
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
  const quote = {
    chainId,
    entrypoint: settings.entrypoint,
    feeRecipient: settings.feeRecipient,
    relayFeeBPS: settings.relayFeeBPS.toString(),
    minWithdrawal: settings.minWithdrawal.toString(),
    minFee: (settings.minFee ?? 0n).toString(),
    ...(settings.recycler ? { recycler: settings.recycler, recycleFee: (settings.recycleFee ?? 0n).toString() } : {}),
    ...(settings.funder ? { funder: settings.funder } : {}),
  };

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/health') return send(200, { ok: true, chainId });
    if (req.method === 'GET' && path === '/quote') return send(200, quote);
    if (req.method !== 'POST' || !['/relay', '/recycle', '/fund'].includes(path)) return send(404, { error: 'not found' });
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
      try {
        if (path === '/fund') {
          const parsed = parseFundRequest(JSON.parse(raw));
          const { session, amount } = checkFundTerms(parsed, settings);
          const txHash = await submitter.submitFund(parsed);
          log(`funded a ${amount} session at ${session} in ${txHash}`);
          return send(200, { txHash });
        }
        if (path === '/recycle') {
          const parsed = parseRecycleRequest(JSON.parse(raw));
          checkRecycleTerms(parsed, settings);
          const txHash = await submitter.submitRecycle(parsed);
          log(`recycled ${parsed.authorization.value} from ${parsed.authorization.from} in ${txHash}`);
          return send(200, { txHash });
        }
        const parsed = parseRelayRequest(JSON.parse(raw));
        const { recipient, withdrawn } = checkTerms(parsed, settings);
        const txHash = await submitter.submit(parsed);
        log(`relayed ${withdrawn} to ${recipient} in ${txHash}`);
        send(200, { txHash });
      } catch (err) {
        const status = err instanceof RelayError ? err.status : err instanceof SyntaxError ? 400 : 500;
        const message = err instanceof Error ? err.message : String(err);
        log(`rejected ${path} (${status}): ${message}`);
        send(status, { error: status === 500 ? 'internal error' : message });
      }
    });
  });
  server.listen(port, opts.host);
  return server;
}

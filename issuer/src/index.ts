/**
 * Session issuer. Holds the pool mnemonic and funds agent sessions within the owner's limits.
 *
 *   RX402_MNEMONIC        pool secret (the only place it should live)
 *   AGENTS                comma-separated agent addresses allowed to ask for sessions
 *   MAX_SESSION_BUDGET    largest single session, in USDG (default 1)
 *   DAILY_LIMIT           session funding per rolling 24 hours, in USDG (optional; also settable
 *                         as dailyLimit in the controls file, the tighter one applies)
 *   ISSUER_CONTROLS       controls file: paused stops all funding (default ~/.sodi/issuer-controls.json)
 *   ISSUER_STORE          pool notes and grants (default ~/.sodi/issuer.json)
 *   RELAYER_URL, ASP_URL, RPC_URL, DEPLOYMENT_FILE, RELAYER_FEE_RECIPIENT, RELAYER_MAX_FEE_BPS
 *   HOST, PORT            default 127.0.0.1:8404
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FileControls } from '@sodi/rx402';
import { type Address, isAddress, parseUnits } from 'viem';

import { SessionIssuer } from './issuer.js';
import { startServer } from './server.js';
import { env, lockStore, poolFromEnv } from './setup.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const usdg = (s: string) => parseUnits(s, 6);

const agents = env('AGENTS')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);
for (const a of agents) if (!isAddress(a, { strict: false })) throw new Error(`AGENTS: ${a} is not an address`);

const { wallet, store, storePath, chainId } = await poolFromEnv({ withRelayer: true });
const release = lockStore(storePath);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    release();
    // The prover's worker threads keep Node alive; exit explicitly.
    process.exit(0);
  });
}
await wallet.sync();

const issuer = new SessionIssuer({
  pool: wallet,
  store,
  chainId,
  agents: agents as Address[],
  controls: new FileControls(env('ISSUER_CONTROLS', join(homedir(), '.sodi', 'issuer-controls.json'))),
  maxSessionBudget: usdg(env('MAX_SESSION_BUDGET', '1')),
  dailyLimit: process.env.DAILY_LIMIT ? usdg(process.env.DAILY_LIMIT) : undefined,
  log,
});
const port = Number(env('PORT', '8404'));
const host = env('HOST', '127.0.0.1');
startServer(issuer, port, host);
const s = issuer.status();
log(`session issuer on ${host}:${port} for ${agents.length} agent(s); pool ${s.poolBalance}, max session ${s.maxSessionBudget}, daily limit ${s.dailyLimit ?? 'none'}${s.paused ? ', PAUSED' : ''}`);

# Sodi Session Issuer

**Keeps the pool secret off the agent's machine.**

An rx402 agent that holds the pool mnemonic can withdraw the whole pool. Its spending caps are enforced in its own code, so whoever takes over the machine it runs on ignores them. The session issuer moves the mnemonic, and the limits that matter, somewhere else.

- **The agent holds only an agent key.** It signs requests and derives its own session keys. It can't make a withdrawal proof.
- **The issuer holds the mnemonic** and funds sessions on request, within the owner's limits: a kill switch, a maximum per session, and a cap per rolling 24 hours.
- **Nothing secret crosses the wire.** The agent picks the next session address from its own key and asks the issuer to fund it. Requests and responses carry only public data.

If the agent's machine is compromised, the most it can take is what the issuer still agrees to fund before the owner hits pause.

> Experimental and unaudited.

## How it works

1. The agent derives the next session address from its agent key, and sends the issuer a signed request: fund this address with this budget.
2. The issuer checks the signature against its list of agents, the timestamp, its kill switch and its limits. Each address is funded once, so a replayed request does nothing.
3. It records the grant (which counts against the 24-hour limit from that moment), then proves and relays a zero-knowledge withdrawal to the address, exactly as rx402 does on its own.
4. The agent checks the funds arrived on-chain, then pays merchants from the session as usual.

Recycling a finished session works too: the agent asks the issuer for a fresh deposit of the owner's (`POST /precommitment`), signs the session's funds over to the recycler, and the issuer finds the new deposit on its next sync. It's allowed while funding is paused, since it only adds to the pool.

The agent recovers a session the issuer funded while it was down: session keys come from the agent key, so it finds them on-chain. A withdrawal that fails keeps counting against the limit, because the relayer may still land it later.

## Run it

On the owner's machine, or a server the agent can't reach into:

```sh
RX402_MNEMONIC="…" AGENTS=0xAgentAddress DAILY_LIMIT=5 MAX_SESSION_BUDGET=1 \
RELAYER_URL=http://localhost:8403 ASP_URL=http://localhost:8402 \
npm start --workspace issuer
```

Fund the pool from the issuer's side. Stop the issuer first, since both write the same store:

```sh
OWNER_PRIVATE_KEY=0x… RX402_MNEMONIC="…" npm run deposit --workspace issuer -- 10
```

Then point the agent at it. The [MCP server](../packages/mcp) takes `RX402_ISSUER_URL` and `RX402_AGENT_KEY` instead of a mnemonic. In code:

```ts
import { IssuerSessions, Rx402Client } from '@sodi/rx402';

const client = new Rx402Client({
  publicClient,
  asset: USDG,
  store,
  policy,
  sessions: new IssuerSessions({ url: 'https://issuer.example', agentKey, publicClient, asset: USDG, store }),
});
```

`new IssuerSessions(...).agentAddress` is the address to put in `AGENTS`.

| Variable | Default | |
| --- | --- | --- |
| `RX402_MNEMONIC` | required | The pool secret |
| `AGENTS` | required | Comma-separated agent addresses |
| `MAX_SESSION_BUDGET` | `1` | USDG per session at most |
| `DAILY_LIMIT` | unset | USDG of session funding per rolling 24 hours |
| `ISSUER_CONTROLS` | `~/.sodi/issuer-controls.json` | `paused` stops all funding; `dailyLimit` (base units) tightens the daily limit. The [dashboard](../dashboard) can edit it. |
| `ISSUER_STORE` | `~/.sodi/issuer.json` | Pool notes and every grant |
| `RELAYER_URL`, `ASP_URL` | localhost | |
| `RELAYER_FEE_RECIPIENT`, `RELAYER_MAX_FEE_BPS` | unset, `100` | Pin the relayer's terms |
| `HOST`, `PORT` | `127.0.0.1`, `8404` | Put it behind HTTPS if the agent is on another machine |
| `RPC_URL`, `DEPLOYMENT_FILE` | testnet | |

## What it protects, and what it doesn't

- **Protected:** the pool. A compromised agent can't withdraw, can't raise its own limits, and can't pass the issuer's caps.
- **Not protected:** the current session's balance, and whatever the issuer funds until the owner pauses it. Keep sessions small and the daily limit close to what the agent really needs.
- **The issuer learns every session address.** It's the owner's own service, so that's expected; don't share one issuer between owners who shouldn't see each other's sessions.
- **The agent's own caps still apply** (per payment, allowed hosts, the owner controls file). They now limit a healthy agent; the issuer limits a compromised one.

## Tests

- `npm test --workspace issuer`: a real agent client against a real issuer server, with the pool and chain faked. Unknown agents, tampered and stale requests, replays, the kill switch, per-session and 24-hour limits (including failed withdrawals and parallel requests), an issuer that reports funding the chain doesn't show, and an agent that crashed while waiting.
- `test/e2e/run-fork.sh`: on a testnet fork with the deployed pool and real proofs. The owner deposits, the approval service approves, an agent with only an agent key pays a merchant from a session the issuer funded, and the 24-hour limit stops the next session without touching the pool.

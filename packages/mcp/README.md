# @sodi/mcp

MCP server that gives AI agents a private wallet for x402 APIs. When a tool call hits `402 Payment Required`, it pays in USDG from an rx402 session address that can't be linked to the owner.

## Tools

| Tool | What it does |
| --- | --- |
| `rx402_fetch` | Fetches a URL. If it costs money (x402), pays privately and returns the response. Optional `max_price_usdg` caps the price for that request. |
| `rx402_status` | Private balance in the pool, current session, and spending limits. |
| `rx402_open_session` | Pre-funds a new session ahead of a burst of paid requests (normally automatic). |
| `rx402_deposit` | Moves the owner's USDG into the pool. Only offered when `OWNER_PRIVATE_KEY` is set. This step is public. |

## Spending limits

An agent can never spend more than:

- `RX402_MAX_PER_REQUEST` on a single request (default 0.10 USDG). A per-call `max_price_usdg` can only lower this.
- `RX402_MAX_TOTAL_SPEND` while the server runs (default 5 USDG).
- Hosts in `RX402_ALLOWED_HOSTS`, if set.

## Use with Claude

The server needs a running [relayer](../../relayer) and [approval service](../../asp).

```json
{
  "mcpServers": {
    "sodi": {
      "command": "npx",
      "args": ["tsx", "/path/to/sodi/packages/mcp/src/index.ts"],
      "env": {
        "RX402_MNEMONIC": "twelve words …",
        "RELAYER_URL": "http://localhost:8403",
        "ASP_URL": "http://localhost:8402",
        "RX402_MAX_PER_REQUEST": "0.10",
        "RX402_MAX_TOTAL_SPEND": "5"
      }
    }
  }
}
```

For Claude Code: `claude mcp add sodi -- npx tsx /path/to/sodi/packages/mcp/src/index.ts`, with the same variables in the environment.

| Variable | Default | |
| --- | --- | --- |
| `RX402_MNEMONIC` | required | Seed for pool secrets. Treat it like a wallet seed. |
| `RELAYER_URL` | `http://localhost:8403` | |
| `ASP_URL` | `http://localhost:8402` | |
| `RPC_URL` | Robinhood Chain testnet | |
| `DEPLOYMENT_FILE` | `contracts/deployments/46630.json` | |
| `RX402_STORE` | `~/.sodi/rx402.json` | Notes and session keys; keep private |
| `RX402_SESSION_BUDGET` | `1` | USDG per session |
| `RX402_CONTROLS` | `~/.sodi/controls.json` | Owner controls (kill switch, caps, allowed hosts), re-read before every payment; set from the [dashboard](../../dashboard) |
| `RX402_STEALTH` | `true` | Pay merchants that offer a stealth address at a one-time address; `false` always pays `payTo` |
| `RX402_MAX_PAYMENTS_PER_SESSION` | `20` | |
| `RX402_MAX_SESSION_AGE` | `3600` | seconds |
| `OWNER_PRIVATE_KEY` | unset | Enables `rx402_deposit` |

## Verified

`test/e2e/run-fork.sh` runs the whole stack on a local fork of Robinhood Chain testnet. An MCP client deposits through the tool, the approval service approves it, and the agent pays an x402 v1 and a v2 API. The session is funded through the HTTP relayer, which takes its 0.5% fee. A per-call price cap and the run spending limit both block payments they should.

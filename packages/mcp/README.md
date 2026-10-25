# @sodi/rx402-mcp

MCP server that gives AI agents a private wallet for x402 APIs, and private pay-per-request inference. When a tool call hits `402 Payment Required`, it pays in USDG from an rx402 session address that can't be linked to the owner.

```sh
claude mcp add sodi -e RX402_ISSUER_URL=https://issuer.example -e RX402_AGENT_KEY=0x… -- npx -y @sodi/rx402-mcp
```

The agent holds only its own key. The pool secret and the hard limits stay with your [session issuer](../../issuer), on another machine, so a compromised agent can spend at most what the issuer agrees to fund. Runs on Robinhood Chain testnet by default. It needs Node 20.11 or later.

## Tools

| Tool | What it does |
| --- | --- |
| `rx402_fetch` | Fetches a URL. If it costs money (x402), pays privately and returns the response. Optional `max_price_usdg` caps the price for that request. |
| `ask_model` | Asks another model through the Sodi [inference gateway](../inference-gateway), paying each request from a private session. Scans the gateway's 402 quote for prompt injection ([wormhole-x402](https://www.npmjs.com/package/wormhole-x402) quote-text scan, offline) before anything is signed or shown to the model, and checks the delivery digest. The model provider sees the prompt, under the gateway operator's account. |
| `rx402_status` | Private balance in the pool, current session, and spending limits. |
| `rx402_open_session` | Pre-funds a new session ahead of a burst of paid requests (normally automatic). |
| `rx402_recycle` | Moves what's left in finished sessions back into the pool, through the relayer and the [recycler](../../contracts/README.md#sodirecycler), so nothing is stranded at old addresses. Leaves the current session and any with recently signed payments alone. Offered when a recycler is deployed (it is on testnet). |
| `rx402_deposit` | Moves the owner's USDG into the pool. Only offered when `OWNER_PRIVATE_KEY` is set. This step is public. |

## Claude Code with no API key

The package also installs `rx402-proxy`, a local paying proxy. Claude Code talks to it as if it were the Anthropic API. The proxy forwards each request to the [inference gateway](../inference-gateway), pays the gateway's 402 from a private session, and streams the answer back:

```sh
RX402_ISSUER_URL=https://issuer.example RX402_AGENT_KEY=0x… npx -y -p @sodi/rx402-mcp rx402-proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8411 ANTHROPIC_API_KEY=unused claude
```

You need no Anthropic key or account. No request can be linked to you or to any other request, not even by the gateway.

- Requests for a model the gateway doesn't serve, including Claude Code's own `claude-*` defaults, go to `RX402_PROXY_MODEL` (by default the gateway default, DeepSeek V4.1 Flash). Set `ANTHROPIC_MODEL` to a gateway model id to choose one directly.
- `max_tokens` is lowered to `RX402_PROXY_MAX_TOKENS` (default 8192), and a thinking budget is lowered with it.
- The client's API key and headers never leave your machine. Only the request body goes to the gateway.
- `count_tokens` is answered locally, for free.
- The same limits apply as for the MCP tools: `RX402_MAX_PER_REQUEST`, `RX402_MAX_TOTAL_SPEND` for the proxy's run, and the owner controls. Each request's gateway quote is scanned the same way `ask_model` scans it, and each answer's delivery digest is checked. The log line has the model, price, session and digest result, and never the prompt.
- The proxy listens on 127.0.0.1 only, since anything that can reach the port can spend from the wallet. The port is set with `RX402_PROXY_PORT`.

Claude Code is built for Claude models; with open models on the other end, some features may work less well.

## Spending limits

An agent can never spend more than:

- `RX402_MAX_PER_REQUEST` on a single request (default 0.10 USDG). A per-call `max_price_usdg` can only lower this.
- `RX402_MAX_TOTAL_SPEND` while the server runs (default 5 USDG).
- Hosts in `RX402_ALLOWED_HOSTS`, if set.

### With a session issuer

With `RX402_MNEMONIC`, the MCP server's machine holds the whole pool, and these limits are enforced by the server itself. For an agent that runs unattended, run a [session issuer](../../issuer) on another machine and give the MCP server `RX402_ISSUER_URL` and `RX402_AGENT_KEY` instead. The issuer's kill switch and 24-hour limit then hold even if the agent's machine is compromised. `rx402_deposit` isn't offered in this mode; deposits are made on the issuer's side.

## Use with Claude

**With a session issuer (recommended).** The agent's machine never holds the pool secret:

```sh
claude mcp add sodi -e RX402_ISSUER_URL=https://issuer.example -e RX402_AGENT_KEY=0x… -- npx -y @sodi/rx402-mcp
```

**With the mnemonic: testnet and local only.** The MCP server holds the whole pool, and the mnemonic sits in plain text in your MCP config. Anyone who can read that file or control the agent's machine controls the pool:

```sh
claude mcp add sodi -e RX402_MNEMONIC="twelve words …" -- npx -y @sodi/rx402-mcp
```

Claude Desktop and other MCP clients:

```json
{
  "mcpServers": {
    "sodi": {
      "command": "npx",
      "args": ["-y", "@sodi/rx402-mcp"],
      "env": { "RX402_ISSUER_URL": "https://issuer.example", "RX402_AGENT_KEY": "0x…", "RX402_MAX_PER_REQUEST": "0.10", "RX402_MAX_TOTAL_SPEND": "5" }
    }
  }
}
```

By default it uses Sodi's hosted [relayer](../../relayer), [approval service](../../asp) and [inference gateway](../inference-gateway); point `RELAYER_URL`, `ASP_URL` and `RX402_GATEWAY_URL` at your own to run without them. The package ships the Privacy Pools withdrawal circuit, checked against its pinned hashes at startup, and the testnet deployment. From a checkout, `npm start` runs the same server from source.

| Variable | Default | |
| --- | --- | --- |
| `RX402_MNEMONIC` | required without an issuer | Seed for pool secrets. Treat it like a wallet seed. |
| `RX402_ISSUER_URL` | unset | Get sessions from a [session issuer](../../issuer) instead; the agent then holds no pool secret. Set this or `RX402_MNEMONIC`, not both. |
| `RX402_AGENT_KEY` | with an issuer | The agent's own key: signs requests to the issuer and derives session keys. |
| `RELAYER_URL` | `https://relayer.sodi.network` | |
| `ASP_URL` | `https://sodi-asp.onrender.com` | |
| `RPC_URL` | Robinhood Chain testnet | |
| `DEPLOYMENT_FILE` | the testnet deployment | Shipped in the package; `contracts/deployments/46630.json` from a checkout |
| `RX402_CIRCUITS_DIR` | shipped in the package | Withdrawal circuit (`withdraw.wasm`, `.zkey`, `.vkey`); checked against pinned hashes |
| `RX402_STORE` | `~/.sodi/rx402.json` | Notes and session keys; keep private |
| `RX402_SESSION_BUDGET` | `1` | USDG per session |
| `RELAYER_FEE_RECIPIENT` | unset | Pin the relayer's fee address; the client refuses a relayer that quotes another (a relayer could otherwise tag your sessions) |
| `RELAYER_MAX_FEE_BPS` | `100` | Refuse relayers that charge more |
| `RX402_CONTROLS` | `~/.sodi/controls.json` | Owner controls (kill switch, caps, allowed hosts), re-read before every payment; set from the [dashboard](../../dashboard) |
| `RX402_STEALTH` | `true` | Pay merchants that offer a stealth address at a one-time address; `false` always pays `payTo` |
| `RX402_MAX_PAYMENTS_PER_SESSION` | `20` | |
| `RX402_MAX_SESSION_AGE` | `3600` | seconds |
| `OWNER_PRIVATE_KEY` | unset | Enables `rx402_deposit` |
| `RX402_RECYCLER` | from the deployment file | SodiRecycler for `rx402_recycle`; recycles are submitted by the relayer at `RELAYER_URL`, also with a session issuer |
| `RX402_MAX_RECYCLE_FEE` | `0.001` | USDG; refuse relayers that charge more per recycle |
| `RX402_GATEWAY_URL` | `https://inference.sodi.network` | Inference gateway for `ask_model`; `off` removes the tool |
| `RX402_GATEWAY_MODEL` | `deepseek/deepseek-v4.1-flash` | Default model for `ask_model` |
| `RX402_GATEWAY_MAX_TOKENS` | `1024` | Default answer cap; the price assumes all of it is used |

## Verified

`test/e2e/run-fork.sh` runs the whole stack on a local fork of Robinhood Chain testnet. An MCP client deposits through the tool, the approval service approves it, and the agent pays an x402 v1 and a v2 API. The session is funded through the HTTP relayer, which takes its 0.5% fee. A per-call price cap and the run spending limit both block payments they should. After a rotation, `rx402_recycle` leaves the old session alone while its payments could still be settled, then returns what's left to the pool through the relayer.

`ask_model` and `rx402-proxy` are tested in the [inference gateway's](../inference-gateway) fork suite. The proxy runs the real Claude Code CLI, with no Anthropic credentials in its environment, against a gateway paid from an rx402 session. `ask_model` pays the gateway from the agent's own session and returns the answer with a verified digest. Given a hostile 402, whose description tells the model to send funds, it refuses with only the rule codes, and nothing is signed.

# @sodi/inference-gateway

Private pay-per-request inference. An x402 server in front of [OpenRouter](https://openrouter.ai): an agent pays each request in USDG from an [rx402](../rx402) session, and the gateway forwards the request upstream on the operator's key. No account, no API key, and nothing ties one request to the next.

## Trust model

OpenRouter and the model provider see the prompt under Sodi's account, not yours. The gateway sees the prompt and a one-time payment, never who you are. Run your own if you don't want to trust ours.

This is not a privacy claim about the model. A closed model's provider reads the prompt like any other request; what it can't learn is which agent or owner sent it.

## Endpoints

| | |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI format. Streaming with `"stream": true`. |
| `POST /v1/messages` | Anthropic Messages format. Streaming with `"stream": true`. |
| `GET /v1/models` | The allowlisted models, with OpenRouter's per-token prices and the gateway's margin. |
| `GET /health` | Whether the gateway is quoting new requests. |

A request without payment gets a `402` with its price. The same request, paid (x402 v2 `PAYMENT-SIGNATURE`, or v1 `X-PAYMENT`), gets the answer.

With the rx402 client, that's one call:

```ts
const { response } = await rx402.fetch('https://inference.sodi.network/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 200 }),
});
```

The OpenAI and Anthropic SDKs take a custom `fetch`, so either can point at the gateway with `fetch: (url, init) => rx402.fetch(url, init).then((r) => r.response)`. Claude Code works through [`rx402-proxy`](../mcp#claude-code-with-no-api-key), a local proxy that pays each request. Agents on the [Sodi MCP server](../mcp) get the `ask_model` tool, which does all of this and scans the quote first.

## Pricing

The price is fixed before anything is sent upstream:

```
price = (input tokens × prompt price + max_tokens × completion price + per-request price) × (1 + margin)
```

- **Prices are a ceiling over providers.** One model's providers on OpenRouter can differ in price 30-fold, and which one serves a request isn't known in advance. Each model is quoted at the most expensive of its five cheapest providers (from `/api/v1/models/{id}/endpoints`, refreshed every 10 minutes), and requests are routed with that ceiling as `max_price`, cheapest qualifying provider first. The upstream can't charge more than the quote. Models listed with a variable price (routers such as `openrouter/auto`) can't be quoted and are refused.
- Input tokens are estimated from the prompt's size: one token per three bytes, plus a few per message. Tokenizers average closer to four bytes a token on English, so the estimate runs high. Images are counted by their encoded size, which overstates them.
- `max_tokens` is enforced upstream. Every request carries one (`DEFAULT_MAX_TOKENS` if the client didn't set one), and requests above `MAX_TOKENS` are refused, not cut. The price assumes every one of them is used.
- **Change becomes credit.** A quote is a worst case, paid up front in one signature. After a request, the gateway reads what the upstream actually charged (OpenRouter's `usage.cost`), adds the margin, and credits the rest to the paying session. A client that names its session on the unpaid request (`Sodi-Payer: 0x…`) gets that credit taken off the quote; it's only honoured if the payment then comes from that address, so spending a session's credit takes its key. The remaining credit is returned in a `Sodi-Credit` header (or, for streams, a `: sodi-credit <units>` comment before the digest). Over a session's life an agent pays about the real cost plus margin.
- **What credit doesn't cover.** The last request of a session overpays, and its change is lost when the session rotates. Credit is held in memory for 24 hours, so a gateway restart forfeits it. Each payment is at least 1 unit, since the payment is what proves who is paying. Set `CREDITS=false` to turn it off, and overpayment is plain margin.

Only fields we can price are forwarded. `n` above 1, `models` fallbacks, `plugins`, `user`, `metadata` and the client's own `provider` are dropped or refused.

## What is forwarded, and what isn't

- **Routing:** every request goes upstream with `provider: { data_collection: "deny", require_parameters: true }`, so only providers that don't store or train on prompts are used, and only ones that honour `max_tokens`. `ZDR=true` adds `zdr: true`. When no provider qualifies, OpenRouter fails rather than falling back; the gateway answers `503` and the payment is not settled.
- **Headers:** none of the client's. The upstream request is built from scratch with our key and a content type, so no IP, user agent, cookie or SDK header reaches it.
- **Logging:** none, of any kind, including on error. There is no request logger. The error handler returns a fixed message. Upstream error bodies, which can quote the prompt, are never passed on or printed. The only things the process prints are its startup line and, if the keeper fails, the keeper's error.

## Payment and delivery

1. Check the payment: signature, amount, expiry, and that the paying address holds the funds (net of its other in-flight payments).
2. Rate-limit the paying address (`RATE_LIMIT` per `RATE_WINDOW_SECONDS`), then run the abuse hook on the prompt.
3. Send upstream.
4. Once the upstream accepts, settle on-chain, then deliver.

A refusal at any of steps 1 to 3 leaves the payment unsettled, so it costs the agent nothing. The settlement transaction is returned in the `PAYMENT-RESPONSE` header.

**Stealth by default.** The 402 offers a [stealth address](../../stealth): each payment lands at a fresh one-time address that only the operator can find and spend, so the gateway's revenue can't be totalled from the chain. The gateway holds only the viewing key, so it can settle payments but never move them. Clients that don't know the extension pay `PAY_TO`.

**Delivery receipt:** `Sodi-Delivery-Digest: sha256=<hex>` over the response body. A stream's headers leave before its body exists, so for streams the digest of every byte streamed comes last as an SSE comment, `: sodi-delivery-digest sha256=<hex>`. SSE parsers ignore comment lines, so SDKs are unaffected. Streams are hashed over their raw bytes rather than the text deltas, so the receipt covers tool calls and stop reasons too. `checkDelivery(body, header)` checks either form.

## Keeping the key alive

- **Rate limit** per paying address.
- **Abuse hook:** `AbuseHook.check({ request, prompt })` runs before forwarding. The default lets everything through. `GuardModelClassifier` is an example that asks Llama Guard through the same no-retention routing; turn it on with `ABUSE_GUARD_MODEL`. It costs one small upstream call per request and fails closed.
- **Credit keeper:** reads the balance (`GET /api/v1/credits`, management key), asks a `TopUp` for more below `CREDIT_THRESHOLD_USD`, and stops quoting below `CREDIT_FLOOR_USD`, so no agent pays for a request we can't serve. OpenRouter removed its programmatic crypto top-up (`POST /api/v1/credits/coinbase` now returns `410 Gone`), so the shipped `TopUp` posts `{ event, remainingUsd, requestedUsd }` to `TOPUP_WEBHOOK_URL` for the operator to act on. Anything that can buy credits plugs into the same interface.

## Sweeping revenue

Payments land at stealth addresses that only the operator's spending key can move. `npm run sweep` (run where the operator's wallet is, not on the gateway) finds them from the chain and moves each balance with a gasless EIP-3009 transfer.

With `FEE_SINK` set, a share of the margin goes there first. A request is charged its upstream cost plus `MARGIN_BPS`, so the margin is `MARGIN_BPS / (10,000 + MARGIN_BPS)` of revenue. `MARGIN_SHARE_BPS` of that goes to the sink: half of a 10% margin is 454 bps of each payment. Without `FEE_SINK`, nothing is split off.

Sweeping many addresses to one destination at once links them back together, so sweep into a privacy pool deposit, or at different times.

## Running it

```sh
OPENROUTER_API_KEY=sk-or-... MODELS=moonshotai/kimi-k3,z-ai/glm-5.3,deepseek/deepseek-v4.1-flash,qwen/qwen3.8-2.4t-a95b \
PAY_TO=0x... FACILITATOR_PRIVATE_KEY=0x... \
STEALTH_META_ADDRESS=st:eth:0x... STEALTH_VIEWING_KEY=0x... \
npm start -w @sodi/inference-gateway
```

Derive the stealth keys from the operator wallet with `deriveStealthKeys` in [@sodi/stealth](../../stealth); give the gateway the meta-address and the viewing key only.

| Variable | Default | |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | Inference key |
| `MODELS` | required | Comma-separated allowlist of OpenRouter model ids |
| `PAY_TO` | required | Paid by clients that don't take the stealth offer |
| `FACILITATOR_PRIVATE_KEY` | required | Pays settlement gas; its address is on every settlement, so share it with other merchants if you can |
| `STEALTH_META_ADDRESS`, `STEALTH_VIEWING_KEY` | required unless `STEALTH=false` | |
| `STEALTH_SETTLER` | from the deployment | |
| `STEALTH_DEPLOYMENT_FILE` | `stealth/deployments/46630.json` | Chain, settler and USDG address |
| `RPC_URL` | Robinhood Chain testnet | |
| `UPSTREAM_URL` | `https://openrouter.ai/api/v1` | |
| `MARGIN_BPS` | `1000` | 10% on top of the upstream price |
| `DEFAULT_MAX_TOKENS` / `MAX_TOKENS` | `1024` / `8192` | |
| `ZDR` | `false` | Also require zero-data-retention endpoints |
| `RATE_LIMIT` / `RATE_WINDOW_SECONDS` | `30` / `60` | Per paying address |
| `ABUSE_GUARD_MODEL` | unset | e.g. `meta-llama/llama-guard-4-12b` |
| `OPENROUTER_MANAGEMENT_KEY`, `TOPUP_WEBHOOK_URL` | unset | Both set: the keeper runs |
| `CREDIT_THRESHOLD_USD` / `CREDIT_TOPUP_USD` / `CREDIT_FLOOR_USD` | `20` / `50` / `2` | |
| `CREDITS` / `CREDIT_TTL_HOURS` | `true` / `24` | Credit change from overpaid requests to the paying session |
| `MAX_BODY_BYTES` | `1000000` | |
| `PUBLIC_URL` | unset | Base URL for the `resource` in 402s, behind a proxy |
| `PORT` / `HOST` | `8410` / `127.0.0.1` | |

Put it behind a reverse proxy with access logging off for these paths; the gateway can't vouch for what sits in front of it.

## Not in v1

- No privacy claim about closed models; see the trust model.
- No hosted dashboard, or anything else that would link sessions to accounts.

## Verified

- `npm test`: pricing, request sanitizing, digests, the rate limit and the keeper, plus the HTTP behaviour against a mock OpenRouter. That covers: no client header reaches the upstream, refused requests aren't charged, upstream errors that quote the prompt are never passed on, and nothing is printed.
- `test/e2e/run-fork.sh` runs against a fork of Robinhood Chain testnet with a mock OpenRouter. An rx402 agent pays real requests from a private session: real pool, real proofs, real USDG, the deployed stealth settler. The suite covers:
  - the quoted price;
  - the full 402 round trip, with the payment at a one-time address the operator then finds from the chain;
  - streaming in both formats, with digests;
  - refusal without charge when no no-retention provider is available;
  - the rate limit;
  - the keeper's top-up (mocked) and floor;
  - `ask_model` through the MCP server, including a hostile quote refused before anything is signed;
  - `rx402-proxy`, including the real Claude Code CLI run with no Anthropic credentials.
- `demo/live-testnet.ts` ran the payment path live on Robinhood Chain testnet ([transactions](../../contracts/deployments/46630.json), under `inferenceGateway`). The owner deposited into the yield pool, and the approval service approved the deposit against its real depositor. An agent session was funded through the relayer and paid the gateway, and so did the real Claude Code CLI through `rx402-proxy`. Both payments landed at one-time addresses, which the operator then found from the chain. The upstream was the mock, so no model was called.

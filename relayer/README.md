# relayer

Submits rx402 session withdrawals to the pool, so the fresh session address never needs gas and never sends a transaction of its own. The relayer pays gas and takes a small fee, set in basis points, from the withdrawn amount.

The relayer cannot steal or redirect funds. The recipient, fee recipient and fee are baked into the withdrawal that the zero-knowledge proof commits to, so changing any of them makes the proof invalid.

## API

| Endpoint | |
| --- | --- |
| `GET /quote` | `{ chainId, entrypoint, feeRecipient, relayFeeBPS, minWithdrawal }`. Clients build their withdrawal with these terms. |
| `POST /relay` | `{ withdrawal, proof, scope }` → `{ txHash }` |
| `POST /recycle` | A signed [SodiRecycler](../contracts/README.md#sodirecycler) authorization → `{ txHash }`. Offered when a recycler is configured; `/quote` then includes `recycler` and `recycleFee`. |
| `GET /health` | |

## Checks before relaying

1. The request is well-formed: addresses, hex data, a 2/2x2/2 proof and 8 public signals.
2. The withdrawal is processed by the Entrypoint, for a pool this relayer serves.
3. The fee recipient is this relayer, and the fee is at least `RELAY_FEE_BPS`. On startup it also checks the fee fits each pool's maximum.
4. The amount is at least `MIN_WITHDRAWAL`, and the fee at least `MIN_FEE`, so it doesn't pay gas for dust.
5. The transaction is **simulated** first, so invalid proofs cost no gas. Transactions are sent one at a time to avoid nonce races.

Recycles get the same treatment: the fee recipient must be this relayer, the fee at least `RECYCLE_FEE`, and the transaction is simulated before it is sent.

The `rx402` SDK talks to it with `HttpRelayer.connect(url)`, and `relayer.recycleSubmitter({ recycler })` for recycles.

## Running

```bash
RELAYER_PRIVATE_KEY=0x... npm start
```

| Variable | Default |
| --- | --- |
| `RELAYER_PRIVATE_KEY` | required; needs ETH for gas |
| `RPC_URL` | Robinhood Chain testnet |
| `DEPLOYMENT_FILE` | `../contracts/deployments/46630.json` |
| `RELAY_FEE_BPS` | `0` |
| `FEE_RECIPIENT` | the relayer's address |
| `MIN_WITHDRAWAL` | `100000` (0.1 USDG) |
| `MIN_FEE` | `0` | Smallest fee, in base units; set it to cover gas before running a public relayer |
| `RATE_LIMIT_PER_MINUTE` | `30` | Requests per IP per minute |
| `RECYCLER` | from the deployment file | SodiRecycler address; recycles are refused without one |
| `RECYCLE_FEE` | `MIN_FEE` | Fee per recycle, in base units, taken out of the recycled amount |
| `HOST` | all interfaces | e.g. `127.0.0.1` behind a reverse proxy |
| `PORT` | `8403` |

## Not done yet

- Checking that the fee covers gas at current prices; `MIN_FEE` and `RECYCLE_FEE` are set by hand.
- Multiple signer keys for throughput.

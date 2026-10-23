# asp: Sodi approval service

Screens deposits into Sodi's pool and publishes the **approved-deposit set** (the Privacy Pools *association set*) on-chain. A private withdrawal must prove its deposit is in the latest published set, so without this service deposits can go in but can only leave through a public ragequit.

## How it works

Each cycle (every 15 s by default):

1. **Scan.** Reads `Deposited` events from the pool, starting at the deployment block.
2. **Screen.** Each deposit is `pending`, `approved` or `denied`:
   - denied if the depositor is in `blocklist.json` `addresses`, or its label is in `labels`;
   - pending until the vetting delay has passed (30 minutes by default), so an operator can deny it first;
   - otherwise approved.
   Every deposit is re-screened every cycle, so adding an address to the block list later revokes its approval.
3. **Build.** Approved labels, in on-chain order, go into a LeanIMT hashed with Poseidon(2), the same structure the withdrawal circuit verifies.
4. **Publish.** If the root differs from the Entrypoint's `latestRoot`, it writes the set to `data/sets/<cid>.json` and calls `updateRoot(root, cid)`. The CID is the IPFS CIDv1 of that file.

Publishing only happens when the approved set changes, because the pool accepts proofs against the latest root only: each new root invalidates withdrawal proofs built against the previous one.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /health` | Status, last scanned block, latest root |
| `GET /association-set` | Latest published set: root, CID and labels, which clients need to build the inclusion proof |
| `GET /association-set/:cid` | A specific published set |
| `GET /deposits/:label` | Screening status of one deposit |

## Running

```bash
npm install
cp ../.env.example ../.env   # fill in POSTMAN_PRIVATE_KEY
npm run once -- --dry-run    # one cycle, never sends a transaction
npm start                    # loop + API on :8402
npm test
```

| Variable | Default | |
| --- | --- | --- |
| `POSTMAN_PRIVATE_KEY` | required unless `--dry-run` | Must hold `ASP_POSTMAN` on the Entrypoint |
| `RPC_URL` | Robinhood Chain testnet | |
| `DEPLOYMENT_FILE` | `../contracts/deployments/46630.json` | Entrypoint, pools and start block |
| `VETTING_DELAY_SECONDS` | `1800` | Window to deny a deposit before approval |
| `POLL_INTERVAL_SECONDS` | `15` | |
| `PORT` | `8402` | |
| `STATE_FILE`, `SETS_DIR`, `BLOCKLIST_FILE` | `data/…`, `blocklist.json` | |

If Node can't reach the RPC behind a corporate proxy, set `NODE_USE_ENV_PROXY=1`.

## Verified

- Unit tests for the tree, CID and screening rules (`npm test`).
- End to end on a local fork of Robinhood Chain testnet: three real USDG deposits into the deployed pool, one from a blocked address. The service approved two, denied one, and published a root that matched on-chain; a second run did not republish; blocking a previously approved depositor revoked it and published a new root.
- The TypeScript Poseidon/LeanIMT produces exactly the same root as the pool's on-chain Solidity tree for the same leaves.

## Not done yet

- **Sanctions data.** The block list is a local file. Production needs a live sanctions feed (OFAC SDN list or a provider such as Chainalysis).
- **IPFS pinning.** The CID is computed locally and the set is served by the API, but not yet pinned to IPFS.
- **Key handling.** The postman key is read from the environment. Mainnet needs a hardware or managed signer.
- **Single instance.** Run one copy per Entrypoint; two copies would race to publish.

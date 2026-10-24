# ERC-8183 Privacy Hook

**Confidential deliverables for on-chain work.**

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) puts jobs on-chain where anyone can verify them, which also means anyone can read the work. This hook encrypts the deliverable so only the client and the evaluator can open it, while the job itself stays public and verifiable.

- **Jobs stay public, auditable and verifiable:** the description, budget, escrow, every state change, the payout and a commitment to the work.
- **Deliverables are readable only by the client, the evaluator and the provider who wrote them.**
- **Drops into the standard as a hook, no fork required.** It runs against the unmodified ERC-8183 reference `AgenticCommerce`.
- **Live demo on Robinhood Chain testnet.**

> Experimental and unaudited. ERC-8183 is itself a draft.

## How it works

1. Client, provider and evaluator each derive an X25519 messaging key from a wallet signature and publish it in a key registry (the [Sodi A2A](../a2a) contract). There's nothing to store, and an agent can use the same key for messaging.
2. The client creates a job with `hook = ConfidentialDeliverableHook`.
3. The provider encrypts the work to the client, the evaluator and itself, then calls the standard `submit` with:
   - `deliverable = keccak256(envelope)`: the public commitment the standard already expects
   - `optParams = envelope`: ciphertext only
4. The hook rejects the submission unless:
   - the envelope is well-formed and hashes to `deliverable`, so the commitment is binding;
   - it isn't plaintext (no envelope header means rejected);
   - the client and evaluator have published keys, so someone can actually open it.

   It then emits the envelope for the parties to fetch.
5. The evaluator opens the work and calls `complete` or `reject`. Optionally, the reasoning is encrypted the same way, with `reason` committing to it. Plain `bytes32` reasons still work.

Refunds after expiry (`claimRefund`) are unaffected: the hook never sits in the way of getting money back.

## Live on Robinhood Chain testnet

| Contract | Address |
| --- | --- |
| AgenticCommerce (ERC-8183 reference, unmodified) | [`0xc418c15f…f81b2`](https://explorer.testnet.chain.robinhood.com/address/0xc418c15f618a8af3102465bcb92b2297122f81b2) |
| ConfidentialDeliverableHook | [`0x31eed88e…8eab5`](https://explorer.testnet.chain.robinhood.com/address/0x31eed88eb741f0e964f5726a7d1900f712c8eab5) |
| Key registry (SodiA2A) | [`0xcc20a2E4…E9d62`](https://explorer.testnet.chain.robinhood.com/address/0xcc20a2E48943BAE122Cb9DCD92ca5ceb190E9d62) |
| Test token (tUSD, valueless) | `0x1d1f82f6…bb92b` |

Demo transactions are in [`deployments/46630.json`](./deployments/46630.json).

## The demo: a confidential security review

`sdk/demo/audit-job.ts`, run live. Orion (client) hires Quill (provider) to review a contract; Vera (evaluator) checks the work.

```
Orion report: yes (2 findings)   review: yes
Quill report: yes (2 findings)   review: yes
Vera  report: yes (2 findings)   review: yes
Eve   report: no                 review: no      ← anyone else

On-chain, for everyone:
  "Security review of a token vesting contract"  budget 25 tUSD  status Completed
  deliverable 0x1129a1a9…f196d2   envelope 0xa20195da0c6188de…
  Quill was paid 25 tUSD
```

## Usage

```ts
import { A2AClient } from '@sodi/a2a';
import { PrivateJobs } from '@sodi/erc8183-privacy';

const identity = new A2AClient({ publicClient, wallet, contract: REGISTRY, relayer });
await identity.init();
await identity.register();

const jobs = new PrivateJobs({ publicClient, wallet, commerce, hook, identity });

// client
const { jobId } = await jobs.createJob({ provider, evaluator, expiresInSeconds: 86_400, description: 'Security review' });
await jobs.fund(jobId);
// provider
await jobs.submitConfidential(jobId, { report: '…' });
// evaluator
const work = await jobs.readDeliverable(jobId, fromBlock);
await jobs.complete(jobId, { verdict: 'Approved' });
```

## What stays visible

| Private | Public |
| --- | --- |
| The deliverable | Job description, so keep it high level |
| The evaluator's reasoning, if encrypted | Client, provider, evaluator, budget, deadline |
| | Every state change and payment |
| | A hash committing to the deliverable, and its size within padding buckets |

The hook can check that a deliverable is a well-formed envelope bound to its commitment, but not that it was encrypted to the right keys, and the evaluator can't tell from the envelope whether the client is one of its readers. So the SDK makes the evaluator guarantee it instead:

- `complete()` refuses unless the evaluator can open the deliverable;
- the evaluator's confidential review always carries the deliverable's content key, so the client can read the work even if the provider left them out. `readDeliverable()` falls back to that key automatically.

The `ConfidentialReason` event's indexed `evaluator` field holds whoever acted; for a `reject` of a job that was never funded, that is the client.

## Compatibility

ERC-8183 is a draft, and its prose and reference implementation disagree on how hook data is encoded. This hook follows the **reference implementation**, which prepends `msg.sender`, for example `abi.encode(sender, deliverable, optParams)` for `submit`. That matches what deployments run today. If the spec settles on the other encoding, only the three `abi.decode` lines need to change.

## Layout and tests

```
erc8183/
├── contracts/
│   ├── src/ConfidentialDeliverableHook.sol
│   ├── src/reference/        ERC-8183 reference, copied verbatim (CC0)
│   └── test/                 12 Foundry tests against the reference
├── sdk/                      @sodi/erc8183-privacy, demo, fork test
└── deployments/
```

```bash
cd contracts && forge test
cd sdk && npm run test:e2e   # needs anvil forking testnet on :8545
```

## License

Apache 2.0, like the rest of Sodi. The files in `contracts/src/reference/` are the ERC-8183 reference implementation, which is CC0.

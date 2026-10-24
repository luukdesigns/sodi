# @sodi/rx402

Private x402 payments for AI agents.

An agent's owner deposits USDG into Sodi's Privacy Pool once. When the agent hits an x402 paywall, rx402 withdraws a small budget to a **brand-new session address** using a zero-knowledge proof, then pays the merchant from that address with a standard EIP-3009 signature. Merchants see an ordinary x402 payment from an address with no history. Nothing on-chain links it to the owner, or to the agent's other sessions.

## Usage

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FileStore, Rx402Client, WalletRelayer, WithdrawalProver, aspAssociationSet,
} from '@sodi/rx402';
import deployment from '../../contracts/deployments/46630.json';

const client = new Rx402Client({
  publicClient,
  ownerWallet,                         // only used for deposits
  mnemonic: process.env.RX402_MNEMONIC!,
  entrypoint: deployment.contracts.Entrypoint,
  pool: deployment.pools.USDG.pool,
  asset: deployment.pools.USDG.asset,
  poolDeploymentBlock: BigInt(deployment.deploymentBlock),
  relayer: new WalletRelayer(relayerWallet, publicClient, deployment.contracts.Entrypoint),
  prover: new WithdrawalProver(),
  associationSet: aspAssociationSet('http://localhost:8402'),   // Sodi approval service
  store: new FileStore('.rx402/wallet.json'),
  policy: {
    budget: 1_000_000n,          // 1 USDG per session
    maxPayments: 20,             // rotate after 20 payments...
    maxAgeSeconds: 3600,         // ...or after an hour
    maxPaymentAmount: 100_000n,  // never pay more than 0.10 USDG per request
  },
});

await client.deposit(10_000_000n);   // public: 10 USDG into the pool
// wait for the approval service to approve the deposit, then:
const { response, payment } = await client.fetch('https://api.example.com/paid-data');
```

### Without the pool secret on the agent

Whoever holds the mnemonic can withdraw the whole pool, and the client's caps run on the agent's own machine. For an agent that runs unattended, give it only an agent key and let a [session issuer](../../issuer) hold the mnemonic and enforce the limits:

```ts
import { IssuerSessions, Rx402Client } from '@sodi/rx402';

const client = new Rx402Client({
  publicClient,
  asset: deployment.pools.USDG.asset,
  store: new FileStore('.rx402/wallet.json'),
  policy,
  sessions: new IssuerSessions({ url: 'https://issuer.example', agentKey, publicClient, asset: deployment.pools.USDG.asset, store }),
});
```

Payments work exactly the same. Session keys are derived from the agent key, and the issuer funds each new session address with a zero-knowledge withdrawal.

`client.fetch` behaves like `fetch`. On a `402 Payment Required` it picks the USDG option on this chain, opens or rotates a session if needed, signs the payment and retries.

If the merchant offers a [stealth address](../../stealth), the payment goes to a fresh one-time address instead of its public `payTo`, so the merchant's side is private too. Pass `stealth: false` to turn this off.

### Recycling leftover funds

After rotation, what's left in an old session can go back into the pool:

```ts
const relayer = await HttpRelayer.connect('https://relayer.example');
const outcomes = await client.recycleSessions({
  submitter: relayer.recycleSubmitter({ recycler: deployment.contracts.SodiRecycler }),
});
// [{ session, amount, status: 'recycled' | 'too-small' | 'empty' | 'failed', tx? }]
```

Each finished session signs a transfer to the [SodiRecycler](../../contracts/README.md#sodirecycler), which deposits it into the pool as a new deposit of the owner's. The relayer submits it, so the session never needs gas. With a [session issuer](../../issuer), the issuer supplies the deposit, and the agent still holds no pool secret.

- **It waits.** The current session, and any session that signed a payment in the last 10 minutes, is left alone: a merchant may still settle a signed payment, and the funds must be there when it does.
- **It's public, like any deposit.** Anyone can see that this session put this amount back into the pool; once it's there, its later withdrawals are as private as any other.
- **Small amounts can't go back.** The pool has a minimum deposit (0.1 USDG on testnet). Sessions holding less, after the relayer's fee, are reported as `too-small`.
- **Merchants can do the same** with stealth payments: `poolWallet.recycle(privateKeyToAccount(merchant.keyFor(p.ephemeralPublicKey)), submitter)` puts one stealth address's balance into the merchant's own pool. Recycle them one at a time, not in one batch, or the batch links them.

## How a payment works

1. **Deposit (public).** The owner deposits into the pool. Secrets are derived from the mnemonic, exactly as in the 0xbow Privacy Pools SDK, so the same mnemonic recovers the deposit in any compatible wallet.
2. **Approval.** The [approval service](../../asp) screens the deposit and adds its label to the association set.
3. **Open a session (private).** rx402 proves in zero knowledge that it owns an approved, unspent commitment, and withdraws `budget` to a fresh address. A relayer submits the transaction, so the session address never needs gas. The rest of the deposit stays in the pool as a new commitment.
4. **Pay.** The session signs an EIP-3009 `transferWithAuthorization` for the merchant. Any x402 facilitator settles it. Both x402 v1 (`X-PAYMENT`) and v2 (`PAYMENT-SIGNATURE`) are supported.
5. **Rotate.** After `maxPayments`, `maxAgeSeconds`, or when the budget runs out, the next payment opens a new session from the remaining balance. What's left in the old one can be [recycled](#recycling-leftover-funds).

## What is private

| Hidden | Visible |
| --- | --- |
| Which deposit a session was funded from | That the pool paid some amount to a session address |
| The link between the owner and any session | Payments within one session (same address) |
| The link between one session and the next | Amounts and timing |

Privacy grows with the number of users in the pool. Round budgets (for example always 1 USDG) and a delay between deposit and first session make sessions harder to correlate.

## Verified

- **Unit tests** (`npm test`): key derivation, commitments, withdrawal context and Merkle proofs match the 0xbow SDK source exactly; the EIP-712 domain matches USDG's on-chain `DOMAIN_SEPARATOR`; x402 v1 and v2 parsing, selection and headers.
- **End to end** (`test/e2e/run-fork.sh`): on a local fork of Robinhood Chain testnet, against the deployed Sodi pool. A deposit is approved by the approval service, real Groth16 proofs are accepted by the deployed verifier, a v1 and a v2 merchant are paid from a session address, and a policy-driven rotation funds a second session from the first withdrawal's change.

Circuit artifacts are loaded from the pinned Privacy Pools submodule and checked against the SHA-256 hashes 0xbow publishes; mismatching files are refused.

## Not done yet

- **The mnemonic is the whole pool.** With it in the agent process, a compromised machine can withdraw everything. Use a [session issuer](../../issuer) for agents that run unattended.
- **The store file holds session private keys.** Keep it as secure as a wallet; each key only controls one session's budget.
- **Recovery from mnemonic alone** (scanning the chain for past deposits) is not implemented; the store is needed.
- **Relayer:** `WalletRelayer` relays from a wallet you run. A hosted relayer with fees is the next component.
- **Proof time:** a few seconds per session on a laptop, so the first payment in each session is slower than the rest.

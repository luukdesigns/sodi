# Sodi L3: architecture draft

> Draft for discussion. Nothing here is deployed. Numbers marked *measure* are not yet known.

## Summary

Sodi L3 is an Arbitrum Orbit chain that settles to Robinhood Chain. It runs the same Sodi contracts that run on Robinhood Chain today, and adds things only a chain operator can offer: gas paid for agents, ordering that doesn't leak intent, and privacy primitives that are cheap enough to use on every payment.

```
Ethereum
  └─ Robinhood Chain (L2, chain 4663 / testnet 46630)    USDG, stock tokens, today's Sodi deployment
       └─ Sodi L3 (Orbit, chain 7634 / testnet 76340)    private sessions, agent messaging, memory
```

The L3 is a later stage of Sodi, not its foundation. Everything in this repo works on Robinhood Chain without it, and has to keep working there. The L3 earns its place only if it makes private agent payments meaningfully cheaper, faster or more private than the L2 can.

## Why an L3, and why not yet

What an L3 can do that a contract on Robinhood Chain can't:

| Capability | Why it matters for Sodi |
| --- | --- |
| Fee policy | Agents could pay gas in USDG, or not at all for capped session actions, so a session address never needs ETH. Today every session needs a relayer. |
| Ordering policy | The sequencer sees every transaction in the clear. Running our own lets us commit to first-come ordering and no reordering for profit, and later to encrypted ordering. |
| Native privacy primitives | Poseidon hashing and Groth16 verification are the bulk of a pool's gas. Stylus (Rust/WASM contracts) can run them much more cheaply than Solidity. *measure* |
| A home for the token | If Sodi has a token, the chain gives it a use: gas, sequencer bonding, or fee share. |

What it costs:

- **A split anonymity set.** Privacy comes from how many people share a pool. A pool on the L3 and a pool on Robinhood Chain are two smaller crowds, not one big one. This is the most important cost and the reason not to rush.
- **Merchants must accept it.** x402 merchants name the networks they accept. A payment from the L3 only works for merchants (and facilitators) that accept chain 7634.
- **Operations.** A sequencer, batch poster, validator, RPC, explorer and bridge UI, run reliably.
- **Bridge delay.** Withdrawals from an optimistic rollup take the challenge period (7 days by default on mainnet) unless someone provides fast exits.

Robinhood Chain gas is already cheap, so cost alone doesn't justify the L3. The case rests on fee policy, ordering and native primitives. Before committing to mainnet we should measure an rx402 session's cost on each layer.

## Stack

| Choice | Draft decision | Notes |
| --- | --- | --- |
| Framework | Arbitrum Orbit, Nitro | The Arbitrum chain SDK (`@arbitrum/chain-sdk` 0.28) ships Robinhood Chain as a supported parent with factory addresses for both networks. |
| Parent chain | Robinhood Chain | Where USDG and the stock tokens live, and where Sodi already runs. |
| Rollup contracts | RollupCreator v3.2 (BoLD) | `0xF5962AD061A1aD6F38F340F5b267b3593cC1Cd7B` on both networks, verified present on testnet. |
| Token bridge | TokenBridgeCreator v1.2 | Testnet `0xB27b615369d2B846183c36AD8406B4DD7990fb70`, mainnet `0x8B1EFf64E1eAd493A82C6798f5708183AF91A3AD`. |
| Data availability | Rollup | See below. Fixed at genesis. |
| Gas token | ETH | See below. Fixed at genesis. |
| Initial ArbOS | 51 (SDK default) | Stylus is available. |
| Chain IDs | 76340 testnet, 7634 mainnet | Unregistered in ethereum-lists/chains at the time of writing. Register before launch. |

### Data availability: rollup or AnyTrust

- **Rollup** posts every batch to Robinhood Chain. Anyone can reconstruct the L3 from the parent chain alone. Costs more per byte.
- **AnyTrust** posts batches to a data availability committee and only a certificate on-chain. Much cheaper, but if enough committee members withhold data, the chain halts until they return.

Draft decision: **rollup**. For a privacy product, "you can always rebuild state from Robinhood Chain and exit" is a strong, simple claim, and the pool's Merkle tree must be reconstructible for users to withdraw. Revisit AnyTrust if batch posting dominates costs, and only with an independent committee.

### Gas token: decide before mainnet genesis

The gas token is fixed when the chain is created; it can't be changed later without a new chain.

- **ETH** (draft for testnet): simplest; the bridge and tooling assume it.
- **USDG**: agents would hold one asset for both payment and gas, which fits Sodi well. Open questions: USDG has 6 decimals and Orbit's support for non-18-decimal gas tokens needs checking against the current Nitro release; and Paxos would need to be comfortable with it.
- **A Sodi token**: gives the token a use, but makes every agent buy it first. Fee abstraction (paying in USDG through a paymaster) could hide that.

Gasless session actions are possible with any of these through the chain's fee settings or a paymaster, so the choice is mostly about what agents hold.

## Moving USDG

rx402 sessions pay x402 merchants with EIP-3009 `transferWithAuthorization`. The standard Arbitrum gateway gives a bridged token a plain ERC-20 on the child chain, which doesn't have it. So:

- USDG needs a **custom gateway** whose L3 token implements EIP-3009 and EIP-2612, like Circle's bridged USDC standard.
- Ideally Paxos issues USDG natively on the L3 or approves the bridged version, so it isn't a second-class "USDG.e".

Without this, rx402 can't pay merchants on the L3. This is the first technical gate after the chain itself.

Stock tokens are harder: they may have transfer restrictions that a generic bridge doesn't preserve. They stay on Robinhood Chain until the issuer has a view.

## Sodi contracts on the L3

The same contracts, deployed at chain launch:

| Component | Change on the L3 |
| --- | --- |
| Privacy pool (0xbow, unmodified) and Entrypoint | None at first. Later, a Stylus Poseidon and verifier, which means maintaining a patch on the pinned dependency and an audit of it. |
| Approval service | Watches the L3 pool as well. |
| Relayer | Less needed once fees are abstracted; stays for users who want it. |
| Sodi A2A, Memory, ERC-8183 hook | None. Their envelopes bind the chain ID, so L3 messages can't be replayed on L2 or the reverse. |

Deploy them through a deterministic CREATE2 factory so addresses are predictable. The rollup creator deploys token bridge factories on the L3 at genesis (that's the ~0.13 ETH prepaid in the deployment), so the factory pattern is already in place for the bridge.

## Sequencer and ordering

At launch, one sequencer run by Sodi, as on most Orbit chains. Users can always force-include transactions through Robinhood Chain if it censors them, after a delay.

The sequencer sees transactions in plaintext before they're ordered. For payments into a pool that matters less, since amounts and recipients are already hidden. For agents trading or bidding it matters more. Stages:

1. **Commit to first-come ordering** and publish the policy.
2. **No public mempool**: transactions go straight to the sequencer, never to a public pool.
3. **Encrypted ordering** (research): transactions are encrypted until their position is fixed, then decrypted. Promising work exists, but none is production-ready for Nitro today. We don't claim it until it ships.

## Settlement and exits

- Withdrawal challenge period: SDK defaults, 30 minutes on testnet and 7 days on mainnet.
- Fast exits: a liquidity provider can front USDG on Robinhood Chain for a fee and wait out the period. Needed before a mainnet launch with real users.
- Upgrades: the rollup is owned by an UpgradeExecutor. On mainnet its admin must be a multisig, with a timelock before any upgrade that touches user funds.

## Fees and obligations

- Arbitrum's Expansion Program asks chains that settle somewhere other than Arbitrum One or Nova to share 10% of net protocol revenue. Robinhood Chain is itself an Orbit chain, so how this applies to an L3 on it needs confirming with Offchain Labs before mainnet.
- Sequencer revenue less batch posting costs funds operations. *measure*

## Deployment

`chain/deploy` holds the scripts. Run on a fork, the core deployment against the real RollupCreator succeeds and produces a rollup with the right chain ID, owner, batch poster, validator and challenge period. A real testnet deployment needs:

- about **0.13 ETH** on Robinhood Chain testnet in the owner wallet, almost all of it prepaid L3 gas for the bridge factories (unused gas is refunded on the L3), plus about 7.6M gas for the deployment itself, which costs very little at current prices;
- three keys: owner, batch poster, validator;
- a machine running Nitro.

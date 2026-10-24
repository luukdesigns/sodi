# Yield pool: design

**Status:** prototype, proven on a fork of mainnet (see [results](#prototype-results)). Nothing here is deployed or committed to. This document says what we'd build, why, and what the prototype showed.

## The idea

Today the Sodi pool holds plain USDG, which earns nothing, and the only people in it are agent owners funding their agents. The yield pool holds a yield-bearing version of USDG instead, so:

- **Owners' idle balances earn** while they wait to be spent.
- **Savers join** who only want the yield and never open a session.

The second point is the real reason to build it. A zero-knowledge withdrawal hides which deposit it came from among every approved deposit large enough to cover it. A pool full of savers' balances hides a 1 USDG agent session in a far bigger crowd than a pool of agents' funding alone. Owners make the pool worth having; savers make it private.

## What it's built on

All verified on Robinhood Chain mainnet (chain 4663) on 2026-10-24:

| | |
| --- | --- |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| Steakhouse USDG (steakUSDG) | `0xbeeff033f34c046626b8d0a041844c5d1a5409dd`, a Morpho **Vault V2**, the vault behind Robinhood Earn |
| Size | about 543M USDG; share price about 1.011 USDG; about 3.9% APY over the last month ([Trading Strategy](https://tradingstrategy.ai/vaults/steakhouse-usdg)) |
| Gates | none: anyone may hold, send and receive shares and assets |
| Fees | 0% performance, 0% management |
| Liquidity | about 3.8M USDG idle in the vault, plus a liquidity adapter that pulls from a Morpho market |

Robinhood's Earn product runs on this vault ([Morpho](https://morpho.org/blog/robinhood-chooses-morpho-to-power-new-earn-product)). Morpho on Robinhood Chain **testnet** is not confirmed, so the prototype runs on a fork of mainnet.

## Design

```
 deposit (public)                      session (private)
 ────────────────                      ─────────────────
 USDG ─► SodiYieldVault ─► shares      proof ─► SessionFunder ─► pool.withdraw ─► shares
          │ invests all                          │ redeems shares for USDG
          ▼                                      ├─► protocol fee: donated to SodiYieldVault
        steakUSDG (Morpho)                       ├─► relayer fee
 shares ─► Entrypoint ─► yield pool              └─► session address: plain USDG for x402
```

### SodiYieldVault (new)

An ERC-4626 vault over USDG that puts everything into steakUSDG. Its share is the yield pool's asset.

- `totalAssets` = what its steakUSDG would redeem for, plus any USDG it holds. Interest raises its share price with no transaction.
- **Fees raise its share price, and only its own.** USDG sent to it (the protocol fee from each session) counts towards `totalAssets` at once, so it goes to the vault's holders, which is the pool. Donating to steakUSDG directly would instead go mostly to Robinhood Earn's 540M of deposits.
- Defended against the usual ERC-4626 donation and inflation attacks: virtual shares (a decimals offset) and a seed deposit at deployment.

**Why a wrapper and not steakUSDG shares directly:** the fee mechanism above; a place to add a liquidity buffer later; and freedom to change the underlying vault without moving the pool.

### The pool (unchanged)

A new instance of the audited Privacy Pools contract, registered in the existing Entrypoint, with SodiYieldVault shares as its asset. Commitments are in shares. Nothing in the pool changes: deposits, approval, ragequit and the state tree all work as now.

### SessionFunder (new)

Turns a withdrawal of shares into a USDG session in one transaction. Privacy Pools lets a contract process a withdrawal directly (`processooor`): the proof commits to the processooor and its data, and the pool still checks the latest approval root. So:

1. The agent (or issuer) proves a withdrawal of `n` shares with processooor = SessionFunder and data = (session address, relayer fee recipient, relayer fee, minimum USDG).
2. The relayer calls `SessionFunder.fund(withdrawal, proof)`. The pool checks the proof and sends `n` shares to the funder.
3. The funder redeems them for USDG, sends the protocol fee to SodiYieldVault, pays the relayer, and sends the rest to the session. If the session would get less than the minimum (a loss in the Morpho vault, say), it reverts.

The session holds plain USDG, so merchants see exactly what they see today. The relayer still submits the transaction, so the session never needs gas.

### Deposits

- **Savers and owners:** USDG into SodiYieldVault, then shares into the pool. Two transactions from the depositor's own wallet, so ragequit keeps working as it does today.
- **Recycling:** the recycler gains a variant that wraps before depositing.
- A one-transaction deposit router is possible, but the pool would record the router as depositor, which needs the same ragequit forwarding as the recycler. Later.

### Fees

- **Relayer fee:** in USDG, set in each withdrawal's data, as today.
- **Protocol fee:** a fixed share of each session's USDG, set when the funder is deployed, donated to SodiYieldVault. It shows up as a higher rate for every depositor. Nobody claims anything, and nothing is distributed.

### No token boost

The brainstorm suggested a $SODI lock that boosts a depositor's fee share, keyed to their public deposit. **We won't build it.** A reward for a deposit only makes sense while the deposit is still in the pool, so its owner would have to keep proving "still unspent". Whenever those proofs stop is when the deposit was withdrawn, and that timing is exactly what the pool hides. Any reward tied to a deposit's lifetime leaks it. A token also brings securities questions the project doesn't need.

## Privacy

| | |
| --- | --- |
| Interest | Accrues to every share equally; adds nothing to the chain. |
| Anonymity set | Every approved commitment large enough to cover a withdrawal. Savers make it much larger. |
| Withdrawal amounts | In shares, so the USDG a session receives depends on the share price at that moment: amounts like 1.000137 USDG. Amounts were already public; this doesn't link them to a deposit. Agents should still aim for round USDG budgets. |
| Fee donations | Public transfers from the funder; they say a session was funded, which the withdrawal already says. |
| Deposits | Public, as today. A saver's deposit looks like an owner's. |

## Risks

These go on a risks page in plain words.

- **Morpho and curator risk.** The pool's value now depends on steakUSDG. Bad debt in its markets lowers the share price, and every commitment loses value in proportion.
- **Liquidity.** If the vault's markets are heavily borrowed, redemptions can fail until liquidity returns. Sessions would fail with them; the relayer's simulation catches this before any gas is spent. A USDG buffer in the funder is the fallback if this turns out to happen in practice.
- **Variable rate.** The rate moves with borrowing demand and can fall.
- **Gas.** Redeeming costs a little more per session than a plain withdrawal.
- **Compliance and regulation.** A privacy pool that pays yield will get more scrutiny than one that doesn't, and paying yield to savers is a different regulatory question from agent payments. The approval service and selective disclosure have to be front and centre. Take legal advice before offering this to the public.

## How we talk about it

Say what it is: a savings account that is also privacy infrastructure. Every deposit is screened by a published approval service before it can be withdrawn privately, and depositors can prove their own history to an auditor. Don't describe savers as providing "cover" or being "paid to hide" agents. It's inaccurate, and it's the line a regulator would quote back.

## Open questions

1. **Who may hold SodiYieldVault shares?** If anyone can, someone can deposit just before a fee donation and leave just after, capturing fees without ever being in the pool. Options: shares that move only between the vault, the pool, the funder and approved routers; or a fee stream rather than one-off donations.
2. **Protocol fee level**, and whether it should change with the session size.
3. **Moving existing deposits** from the USDG pool, or running both pools side by side.
4. **Session sizes in a share-denominated pool:** whether the SDK should round the USDG a session receives (by sizing withdrawals with headroom) or accept the small odd amounts.

## What the prototype has to show

Against a fork of Robinhood Chain mainnet with the real steakUSDG vault:

1. SodiYieldVault deposits into and redeems from steakUSDG correctly; interest accrued by Morpho raises its share price; a donation raises it for its holders.
2. The audited pool accepts SodiYieldVault shares as its asset, unchanged.
3. A **real** zero-knowledge withdrawal processed by SessionFunder funds a session with USDG in one transaction, with the right fees, and respects the minimum.
4. The approval root is still enforced, and the withdrawal data can't be changed by whoever submits it.

## Prototype results

Run on 2026-10-24 against a fork of Robinhood Chain mainnet, with the real USDG and steakUSDG. Code: [`SodiYieldVault`](../contracts/src/yield/SodiYieldVault.sol), [`SodiSessionFunder`](../contracts/src/yield/SodiSessionFunder.sol), [Foundry tests](../contracts/test/YieldPool.fork.t.sol) (`FORK_TESTS=true forge test --isolate --match-contract YieldPoolForkTest`), and the [real-proof test](../packages/rx402/test/e2e-mainnet/yield-pool.test.ts) (`packages/rx402/test/e2e-mainnet/run-fork.sh`).

**All four things the prototype had to show, it showed.**

1. **The vault works over Morpho.** Deposits go straight into steakUSDG, with nothing left idle. 1,000 USDG was worth **1,002.95 USDG after 30 days**, about 3.6% a year, matching steakUSDG's own rate. A 10 USDG donation raised the price for the vault's holders by exactly their share of it, and left steakUSDG's price untouched. An attacker who got in first and donated 10,000 USDG to inflate the price cost a later depositor of 1,000 USDG less than 0.02 USDG, and lost most of the donation.
2. **The audited pool takes the vault's shares unchanged.** The same deployment script and pool contract we use for USDG, with syUSDG as the asset.
3. **A real proof funds a USDG session in one transaction.** With real Groth16 proofs and the real verifier: a withdrawal of 10.04 shares, submitted by the relayer to SessionFunder, put **10.000002 USDG** at a fresh address that never held gas. The relayer got its fee, the protocol fee raised the share price for everyone left in the pool, and the change stayed in the pool as a share commitment that funded a second session.
4. **The rules still hold.** A newer approval root makes a pending proof fail. Changing the session, the fee or the fee recipient breaks the proof's context. Nobody but the funder can process a withdrawal made out to it, the funder won't process anyone else's, and it refuses to pay a session less than the proof's minimum.

**Cost:** about 905k gas per session, against about 541k for a session through today's relay. The extra is the Morpho redemption. Cheap on Robinhood Chain, but it should be in the relayer's fee.

**Learned along the way**

- **Morpho Vault V2 freezes its total assets for the rest of a transaction once it is touched**, as a defence against manipulation within one transaction. Our vault inherits this, which is what we want. It also means a Foundry test, which runs as one transaction, never sees time-based interest unless run with `--isolate`.
- **The vault's previews round down**, so the first shares are minted a hair above 1:1 (0.0001%). Harmless, but the SDK should size withdrawals from `previewWithdraw`, as the test does, and not assume 1:1.
- **The public mainnet RPC keeps only recent state and rate-limits**, so fork tests start at the latest block, and the anvil runner throttles itself.

**Not yet shown**

- A real ragequit from the share pool. The audited pool and circuits are unchanged, so it should behave as it does today, but it hasn't been run.
- The relayer endpoint for SessionFunder, issuer support, and share-based session sizing in `Rx402Client`. The test drives `PoolWallet.withdrawVia` directly.
- The recycler variant that wraps before depositing.
- Open question 1 (who may hold syUSDG shares), which decides whether fee donations can be sandwiched.
- How sessions behave when the Morpho markets are fully borrowed. Simulation should catch it before any gas is spent, but it hasn't been forced on a fork.

**Recommendation:** the mechanism works and the audited pool doesn't have to change. Before building it out: settle open question 1, get a view on the regulatory side of paying yield to savers, and decide whether this replaces the USDG pool or runs beside it. The contracts above are a prototype; they need a proper design review and an audit before holding anything real.

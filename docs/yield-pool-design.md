# Yield pool: design

**Status:** prototype, proven on a fork of mainnet (see [results](#prototype-results)). Not deployed. The two big decisions are made (see [Decisions](#decisions)): the yield pool replaces the plain USDG pool, and its shares exist only inside the pool, with fees streamed into the price.

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
| Steakhouse USDG (steakUSDG) | `0xBeEff033F34C046626B8D0A041844C5d1A5409dd`, a Morpho **Vault V2**, the vault behind Robinhood Earn |
| Size | about 543M USDG; share price about 1.011 USDG; about 3.9% APY over the last month ([Trading Strategy](https://tradingstrategy.ai/vaults/steakhouse-usdg)) |
| Gates | none: anyone may hold, send and receive shares and assets |
| Fees | 0% performance, 0% management |
| Liquidity | about 3.8M USDG idle in the vault, plus a liquidity adapter that pulls from a Morpho market |

Robinhood's Earn product runs on this vault ([Morpho](https://morpho.org/blog/robinhood-chooses-morpho-to-power-new-earn-product)). Morpho is **not** deployed on Robinhood Chain testnet ([Morpho's vault listings](https://curator.morpho.org/vaults/4663/0xBeEff033F34C046626B8D0A041844C5d1A5409dd/allocation) show mainnet only), so the prototype runs on a fork of mainnet; see [Testnet](#testnet).

## Decisions

1. **Shares exist only inside the pool, and fees stream.** The vault only mints shares through the deposit router, which puts them straight into the pool, so the vault isn't a yield product anyone can use from outside. That alone doesn't stop someone depositing into the pool just before a fee lands and ragequitting just after, so fees don't land at once: they're released into the share price linearly over seven days, as Yearn's locked profit and Morpho's own vaults smooth gains. Whatever a short stay captures is proportional to how short it was, so there's no moment worth timing. The prototype measured it: 10,000 USDG deposited just before a 100 USDG fee and pulled out an hour later earned 0.58 USDG, against about 91 if the fee had been released at once.

   **Rejected:** any rule based on how long a deposit has been in the pool, checked at withdrawal. It would need a timestamp in the proof, which changes the circuit, and it would tell observers something about when a withdrawn note was deposited. Streaming gets the same economic result without touching the private side.

2. **Replace the USDG pool; don't run both.** Two pools for the same asset split the anonymity set in two, and a smaller crowd makes every session less private. Depositors who won't take Morpho risk are few enough that their own pool would mostly hurt them. Since nothing is on mainnet yet, the yield pool simply *is* the USDG pool at mainnet launch. The plain pool's contracts and deploy script stay in the repo as the [fallback](#fallback-the-plain-pool).

## Design

```
 deposit (public)                                    session (private)
 ────────────────                                    ─────────────────
 USDG ─► SodiYieldDepositor ─► SodiYieldVault         proof ─► SessionFunder ─► pool.withdraw ─► shares
           (router)              │ mints shares               │ redeems shares for USDG
                                 │ invests in steakUSDG        ├─► protocol fee ─► vault.donate (streams over 7 days)
           shares ─► Entrypoint ─► yield pool                  ├─► relayer fee
                                                               └─► session address: plain USDG for x402
```

### SodiYieldVault

An ERC-4626 vault over USDG that puts its USDG into steakUSDG. Its share (syUSDG, 6 decimals) is the pool's asset.

- **Shares only exist inside the pool.** Only the router mints; only the router and the funder redeem; only the pool, the Entrypoint, the router and the funder may hold shares. These are set once (`wire`) and can't be changed.
- **Interest** raises the share price continuously, with no transaction.
- **Fees stream.** The funder pays the protocol fee through `donate`, and it's released into the price linearly over seven days. A new fee adds to whatever is still streaming and restarts the window. Fees stay as plain USDG until the next deposit invests everything; sessions redeem from them first, which keeps sessions cheaper.
- **Donation attacks:** OpenZeppelin's virtual share plus a seed deposit at wiring, held by a dead address.
- **Exit controls:** see [Morpho exit procedure](#morpho-exit-procedure).

### SodiYieldDepositor (the router)

The only way in. It takes USDG, mints shares and deposits them into the pool in one transaction:

- `deposit(assets, precommitment)` from a wallet that approved it;
- `recycle(...)`: gasless, from an EIP-3009 authorization whose nonce commits to the precommitment and the submitter's fee. Same interface as the SodiRecycler, so the rx402 SDK recycles into the yield pool unchanged.

The pool records the router as depositor, so the router forwards ragequits: it redeems the shares and sends the USDG back to the address that deposited, never anywhere else.

### The pool (unchanged)

An instance of the audited Privacy Pools contract with syUSDG as its asset. Commitments are in shares. Deposits, approval, ragequit and the state tree all work as now. Withdrawals relayed the usual way can't work, since the shares can't be sent to an ordinary address; sessions go through the funder.

### SessionFunder

Turns a withdrawal of shares into a USDG session in one transaction. Privacy Pools lets a contract process a withdrawal directly (`processooor`): the proof commits to it and to its data, and the pool still requires the latest approval root.

1. The agent (or issuer) proves a withdrawal of `n` shares with processooor = SessionFunder and data = (session address, relayer fee recipient, relayer fee, minimum USDG).
2. The relayer calls `SessionFunder.fund(withdrawal, proof)`. The pool checks everything and sends the shares to the funder.
3. The funder redeems them, donates the protocol fee, pays the relayer, and sends the rest to the session, or reverts if that's below the minimum.

The session holds plain USDG, so merchants see what they see today, and the relayer still pays the gas.

### Fees

- **Relayer fee:** USDG, set in each withdrawal's data, capped at 1%.
- **Protocol fee:** a fixed share of each session's USDG, set when the funder is deployed (0.5% in the prototype), streamed to every depositor. Nobody claims anything and nothing is distributed.

### No token boost

The brainstorm suggested a $SODI lock that boosts a depositor's fee share, keyed to their public deposit. **We won't build it.** A reward for a deposit only makes sense while the deposit is still in the pool, so its owner would have to keep proving "still unspent", and whenever those proofs stop is when the deposit was withdrawn: exactly what the pool hides. A token also brings securities questions the project doesn't need.

## Morpho exit procedure

What happens if steakUSDG, its curator or Morpho has to be left in a hurry. This is the part diligence will ask about.

**Who**

| Role | Can | Can't |
| --- | --- | --- |
| **Guardian** (a separate multisig, or a key held by whoever is on call) | Move everything out of Morpho into plain USDG, at once. Cancel a pending vault change. | Put funds into any vault. Touch depositors' shares. |
| **Owner** (the project multisig) | Everything the guardian can, plus propose a vault to invest in, which takes effect only after **two days' notice on-chain**. | Skip the notice. Mint, move or redeem shares. Change who may hold shares. |

Leaving is immediate because it can only reduce risk. Entering, whether a new vault or the same one again, always takes two days, so depositors see it coming and can leave first.

**When.** The guardian exits when any of these happens: bad debt or a loss in steakUSDG's markets; its curator, owner or allocation changing in a way we didn't expect; Morpho announcing an incident; gates switched on (which could trap the vault's own shares); or redemptions failing for a sustained period.

**How.** `exitToIdle(shares)` redeems from steakUSDG into USDG held by the vault and stops further investing. If Morpho is short of liquidity it can be called repeatedly, in parts, as liquidity returns. New deposits stay in plain USDG until a vault is accepted again.

**Notice.** Both actions emit events (`ExitedToIdle`, `UnderlyingProposed`, `UnderlyingCancelled`, `UnderlyingAccepted`). The website and the owner dashboard show the vault's current state and any pending change with its activation time; we also announce it on X.

**What depositors see.** After an exit: their commitments are untouched and worth what they were; the share price stops rising; sessions keep working, funded from the vault's USDG; deposits and ragequits keep working. There is nothing they need to do. During a two-day notice: the same, plus time to leave through a session to a fresh address or a ragequit if they don't want the new vault.

**The trust assumption to state plainly:** the owner chooses which vault the money sits in. A malicious or compromised owner could propose a vault that steals, and the two-day notice and the guardian's veto are the defence. Hardening before mainnet: the owner and guardian as separate multisigs, and the vault limited to ones from Morpho's own Vault V2 factory.

### Fallback: the plain pool

If the yield vault itself had to be abandoned (a bug in it, not in Morpho), there's no upgrade path, by design. The plain USDG pool's contracts and deploy script stay in the repo for this:

1. The guardian exits to idle, so everything in the vault is plain USDG.
2. We deploy a plain USDG pool from the repo, get its approval service running, and announce it.
3. Depositors move: a withdrawal through the funder to a fresh address of their own (private), or a ragequit (public), then a deposit into the plain pool. Agent owners can let the SDK do it.

The move is visible as a wave of withdrawals and deposits, so it costs some privacy for its duration. That's the price of not having an upgradeable vault.

## Privacy

| | |
| --- | --- |
| Interest and fees | Accrue to every share equally and smoothly; add nothing to the chain. |
| Anonymity set | Every approved commitment large enough to cover a withdrawal. Savers make it much larger; one pool instead of two keeps it whole. |
| Withdrawal amounts | In shares, so the USDG a session receives depends on the price at that moment (10.000002 USDG, say). Amounts were already public; this doesn't link them to a deposit. |
| Fee donations | Public, from the funder; they say a session was funded, which the withdrawal already says. |
| Deposits | Public, as today, and all made by the router. A saver's deposit looks like an owner's. |

## Risks

These go on a risks page in plain words.

- **Morpho and curator risk.** The pool's value depends on steakUSDG. Bad debt in its markets lowers the share price, and every commitment loses value in proportion.
- **Liquidity.** If the vault's markets are heavily borrowed, redemptions can fail until liquidity returns, and sessions with them. The relayer's simulation catches this before any gas is spent. A USDG buffer is the fallback if it happens in practice.
- **Admin.** The owner chooses the vault, with two days' notice. See above.
- **Variable rate.** The rate moves with borrowing demand and can fall.
- **Gas.** About 970k per session against about 540k today.
- **Compliance and regulation.** A privacy pool that pays yield will get more scrutiny than one that doesn't, and paying yield to savers is a different regulatory question from agent payments. The approval service and selective disclosure have to be front and centre. Take legal advice before offering it to the public.

## How we talk about it

Say what it is: a savings account that is also privacy infrastructure. Every deposit is screened by a published approval service before it can be withdrawn privately, and depositors can prove their own history to an auditor. Don't describe savers as providing "cover" or being "paid to hide" agents. It's inaccurate, and it's the line a regulator would quote back.

## Testnet

Morpho isn't on Robinhood Chain testnet, so "deploy the new pool on testnet and move the demo agent to it" needs a stand-in for steakUSDG there. A plain ERC-4626 vault over testnet USDG would exercise every Sodi contract and the whole agent flow, everything except Morpho itself, which the mainnet fork tests cover. It earns nothing unless we add a simulated rate for the demo.

Before the demo agent can use the yield pool, the rest of the stack needs:

- the relayer: an endpoint that submits `SessionFunder.fund`;
- the SDK and issuer: sessions funded through the funder (`PoolWallet.withdrawVia` exists), with withdrawals sized in shares from a USDG budget;
- deposits through the router in the SDK, the issuer's deposit command and the MCP tool;
- the approval service and the demo agent pointed at the new pool.

## Open questions

1. **Protocol fee level**, and whether it should change with session size.
2. **Session amounts:** size withdrawals so sessions get round USDG amounts (the funder's minimum makes that possible), or accept small odd amounts.
3. **Liquidity buffer:** only if redemptions turn out to fail in practice.

## Prototype results

Run on 2026-10-24 against a fork of Robinhood Chain mainnet, with the real USDG and steakUSDG. Code: [`SodiYieldVault`](../contracts/src/yield/SodiYieldVault.sol), [`SodiYieldDepositor`](../contracts/src/yield/SodiYieldDepositor.sol), [`SodiSessionFunder`](../contracts/src/yield/SodiSessionFunder.sol); [16 Foundry tests](../contracts/test/YieldPool.fork.t.sol) (`FORK_TESTS=true forge test --isolate --match-contract YieldPoolForkTest`); and a [test with real proofs](../packages/rx402/test/e2e-mainnet/yield-pool.test.ts) (`packages/rx402/test/e2e-mainnet/run-fork.sh`).

1. **The vault works over Morpho.** Deposits go through the router into steakUSDG with nothing left idle. 1,000 USDG was worth **1,002.96 USDG after 30 days**, about 3.6% a year, matching steakUSDG. An attacker who got in first and donated 10,000 USDG to inflate the price cost a later depositor less than 0.02 USDG.
2. **Shares never leave the pool.** Outsiders can't mint or redeem; not even the pool can send shares to an ordinary address.
3. **Fees stream.** 70 USDG donated: nothing at once, about a seventh after a day, all of it after a week. Timing a fee doesn't pay: 0.58 USDG for an hour around a 100 USDG fee, against about 91 at once.
4. **The audited pool takes the shares unchanged**, with the same deployment script as the USDG pool.
5. **A real proof funds a USDG session in one transaction.** With real Groth16 proofs and the real verifier: a withdrawal of 10.04 shares, submitted by the relayer to the funder, put **10.000002 USDG** at a fresh address that never held gas. The relayer was paid, the fee streamed into the price, and the change funded a second session.
6. **The rules still hold.** A newer approval root fails a pending proof. Changing the session, the fee or the fee recipient breaks the proof. Only the funder processes withdrawals made out to it, and it refuses to pay below the minimum.
7. **Ragequits go back to the depositor** through the router, whoever submits them (with the ragequit verifier mocked).
8. **Recycling works unchanged.** The rx402 recycle code put a finished session's USDG into the yield pool through the router, gaslessly, with a real USDG authorization.
9. **Exit and notice work.** The guardian moved everything out of Morpho at once with no loss, and sessions kept being funded from plain USDG. Re-investing was refused before two days' notice and while funds were still in the old vault; the guardian could cancel a proposal.

**Cost:** about 972k gas per session, against about 541k through today's relay. The extra is the Morpho redemption, the fee streaming and the share restrictions. Cheap on Robinhood Chain, but it belongs in the relayer's fee.

**Learned along the way**

- **Morpho Vault V2 freezes its total assets for the rest of a transaction once touched**, a defence against manipulation within a transaction that our vault inherits. A Foundry test is one transaction, so fork tests run with `--isolate` to see time-based interest.
- **The vault's previews round down**, so the first shares are minted a hair above 1:1. The SDK should size withdrawals from `previewWithdraw`, not assume 1:1.
- **Reinvesting each fee as it arrives** added about 140k gas per session. Fees now wait as USDG for the next deposit.
- **The public mainnet RPC keeps only recent state and rate-limits**, so fork tests start at the latest block and the anvil runner throttles itself.

**Not yet shown:** a real ragequit proof (the pool and circuits are unchanged, so it should behave as today); sessions when the Morpho markets are fully borrowed; and the stack integration listed under [Testnet](#testnet). The contracts are a prototype and need a design review and an audit before holding anything real.

# Security review, October 2026

An internal review of the Sodi codebase, with every finding fixed or written down here. It is not an audit, and nothing in this repo should hold real funds yet.

## How it was done

Three reviewers worked independently, each with only the code and the documented guarantees, not the reasoning behind the implementation:

1. **Contracts:** SodiStealthSettler, SodiA2A, SodiMemory, and the ERC-8183 ConfidentialDeliverableHook.
2. **Payment stack:** the rx402 client, relayer, approval service, MCP server, dashboard and demo agent.
3. **Encryption SDKs:** A2A envelopes, stealth addresses, memory and disclosure.

Each finding above "low" came with a demonstration: a failing Foundry test, a vitest case or a script. After the fixes, the demonstrations were re-run. The attacks now fail, and regression tests were added to the repo.

## Summary

33 findings from the reviewers (5 high, 17 medium or low-medium, 11 low or informational), plus one non-security bug they noticed along the way (K14).

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| S1 | High | A relay error after broadcast loses the session key and wedges the wallet | Fixed |
| S2 | High | Concurrent payments overwrite each other's saved state | Fixed |
| S3 | High | A merchant that answers with an error after taking the signed payment escapes every spending limit | Fixed |
| S4 | High | Parallel payments all pass the limit checks before any is recorded | Fixed |
| K1 | High | The auditor accepts disclosures from any contract the owner names, so messages can be forged | Fixed |
| C1 / K9 | Medium | Stealth: a front-runner can settle a payment with junk announcement data, or bypass the settler, so the merchant can't find it | Fixed, settler redeployed |
| C2 | Medium | ERC-8183: a provider can be paid for work the client can't decrypt | Fixed in the SDK |
| S5 | Medium | A redirect from an allowed host makes the agent pay a different host | Fixed |
| S6 | Medium | The MCP `rx402_open_session` tool ignores the kill switch and caps | Fixed |
| S7 | Medium | The approval service can't revoke the last approved deposit | Fixed |
| S8 | Medium | A relayer can tag all of one client's sessions through the fee terms | Mitigated |
| S9 | Medium | The client believes any transaction hash a relayer reports | Fixed |
| S10 | Medium | Network-level links (RPC, approval service, dashboard polling) | Partly mitigated, documented |
| S11 | Medium | Anyone can stall the relayer's queue or drain its gas | Fixed |
| K2 | Medium | One A2A envelope can decrypt to different messages under different keys | Fixed |
| K3 | Medium | A pool disclosure can silently leave out later withdrawals | Fixed |
| K4 | Medium | Memory key rotation is undone by a restart | Fixed |
| K5 | Medium | Stealth keys may not be recoverable (non-deterministic signers, address case, signature encoding) | Fixed |
| K6 | Medium | Anyone can permanently break the auditor's grant intake | Fixed |
| K7 | Low-Medium | Standing-grant notices can be spoofed | Fixed |
| K8 | Low-Medium | Revocation fails if the address case differs | Fixed |
| C3 / K10 | Low | The settler can be made to announce fake payments with a fake token | Fixed |
| C4 | Low | One sequential relay nonce per signer in SodiMemory and SodiA2A | Open |
| S12 | Low | Authorizations stay valid as long as the merchant asks | Fixed |
| S13 | Low | One unapproved deposit blocks all new sessions | Fixed |
| S14 | Low | The demo exposes its relayer and approval service publicly | Fixed |
| S15 | Low | A reorg could make the approval service miss a deposit | Fixed |
| K11 | Low | The number of readers of an envelope is visible | Documented |
| K12 | Low | One agent with an invalid key blocks group messages | Mitigated |
| K13 | Low | A non-JSON message breaks the owner's message collection | Fixed |
| K14 | Low | Memory larger than ~12 KB can't be sealed, despite blob-store support | Fixed |
| C5 | Info | Docs: reader counts, an event field name, phishable key-derivation signatures | Documented |

## Details

### rx402 client and MCP server

**S1, S9: session loss and trusting the relayer.** Session keys are now derived from the mnemonic (`sessionPrivateKey(label, index)`), and nothing is recorded until the chain confirms the withdrawal. Before each new session, the client re-syncs every deposit from on-chain nullifiers and the `Withdrawn` events. That covers a relayer that errors after broadcasting, one that lies about a transaction, one that holds a proof and lands it later, and a crash at any point. Deposits reserve their index before sending, and a deposit whose note was never saved is recovered from the chain. Tests: `packages/rx402/test/unit/session-safety.test.ts`.

**S2, S3, S4: limits.** Payments and session opening run one at a time per client. A payment is recorded, and counts against the 24-hour limit, the session budget and the MCP run limit, as soon as it is signed, before the signed header is sent. Its status is updated afterwards (`accepted` or `refused`). The MCP server also serialises paid tool calls. The dashboard shows refused payments.

**S5: redirects.** Allowed hosts are checked against the server that actually answered 402, after redirects. The paid retry goes straight to that server with `redirect: 'error'`, so a signed payment is never forwarded.

**S6.** `openSession` honours the kill switch and a budget ceiling, and the MCP tool can't exceed the configured session budget. `rx402_deposit` remains available when an owner key is configured. It can only move the owner's funds into the owner's own pool, but it is a public on-chain action, so leave `OWNER_PRIVATE_KEY` unset unless you want the agent to have it.

**S8.** `HttpRelayer.connect` checks the relayer's chain and entrypoint, and can pin the expected fee recipient and a maximum fee (`RELAYER_FEE_RECIPIENT`, `RELAYER_MAX_FEE_BPS` in the MCP server). Without a pinned recipient, a relayer could still hand each client its own fee address. Use a relayer you trust, or pin its published terms.

**S10.** The dashboard caches balance and approval lookups for 5 minutes, and the demo services listen on localhost only. The RPC provider, the approval service and the relayer can still correlate a client's requests by IP and timing. That is the trust model for now: run your own RPC, or use separate endpoints or Tor, if they are adversaries for you.

**S12, S13.** Authorizations last at most 5 minutes. Sessions are only funded from approved deposits.

### Relayer and approval service

**S11.** Simulations run concurrently and only sending is serialised, so junk can't hold up honest requests. Requests in flight are capped (503 when full). There is a per-IP rate limit, and an optional minimum absolute fee (`MIN_FEE`) to cover gas. Tests in `relayer/test`.

**S7.** When no deposit is approved any more, the service publishes a set containing only a sentinel label that no real deposit can have, which replaces the old root. **S15:** each cycle re-scans a trailing window of 64 blocks. A restart now adopts the root already on-chain instead of serving nothing. Tests: `asp/test/service.test.ts`.

### Stealth payments

**C1, C3, K9, K10.** The settler now takes an EIP-3009 `ReceiveWithAuthorization` made out to itself, with a nonce that commits to the stealth address, the ephemeral key and the view tag. Only the settler can execute it, and only with that data, so the funds can't move without the announcement the payer signed, whoever submits the transaction. The settler accepts only tokens fixed at deployment (USDG and the demo token on testnet), so its announcements always describe real payments. The old settler is superseded; see `stealth/deployments/46630.json`. Tests: `stealth/contracts/test`.

**K5.** Key derivation uses the checksummed address, hashes a canonical encoding of the signature, and refuses wallets that sign non-deterministically.

### Encryption SDKs

**K2.** A2A envelopes (revision 1.1) start their plaintext with a 32-byte commitment to the content key and require zero padding. The reviewer's equivocation construction now fails for both readers. Envelopes from revision 1.0 (testnet only) no longer open.

**K4.** Memory finds its current key epoch from the agent's latest write on start-up, and refuses to write over a version it can't read.

**K12.** Sending to an agent whose registered key can't be encrypted to fails with a clear error naming that agent, so the sender can leave it out. The contract still accepts such keys (C4-style contract changes are deferred).

**K14.** Padding buckets of 64 KiB, 256 KiB and 1 MiB were added for memory stored off-chain. The contracts still cap on-chain envelopes at 16 KiB.

### Disclosure

**K1.** The auditor accepts items only from the Sodi contracts it trusts. Defaults for testnet are built in; pass your own list otherwise. Pools must be trusted too. **K3:** a pool disclosure is rejected unless its last disclosed commitment is still unspent, which also catches ragequits. **K6, K7, K8, K13:** malformed grants are skipped, notices can't override their sender, revocation compares addresses case-insensitively, and non-JSON messages are skipped. Tests: `disclosure/sdk/test/e2e`.

### ERC-8183 hook

**C2.** The hook can't check who an envelope is encrypted to, and the evaluator can't tell either. So the SDK's `complete()` refuses unless the evaluator can open the deliverable, and the evaluator's confidential review always carries the deliverable's content key, which `readDeliverable()` uses when the client wasn't a recipient. An evaluator who deliberately withholds the key could still leave the client without the work; the evaluator is already a trusted party in ERC-8183. Test: `erc8183/sdk/test/e2e/audit-job.test.ts`.

## Since the review

- **The pool secret on the agent's machine.** The review took the agent's host as trusted. An agent holding the mnemonic can withdraw the whole pool, and its caps are enforced in its own code. The new [session issuer](../issuer) holds the mnemonic and the hard limits elsewhere; the agent holds only a key that can ask for sessions. Tests: `issuer/test`.
- **Who really deposited, and ragequit after a partial withdrawal:** see findings N1 and N2 below.
- **Leftover funds.** The new [SodiRecycler](../contracts/README.md#sodirecycler) puts leftover session funds and stealth payments back into the pool. Its authorization binds the deposit and the fee, so a front-runner or the relayer can't redirect it, and a ragequit can only return funds to where they came from. The client won't recycle a session while a payment it signed could still be settled. Tests: `contracts/test/SodiRecycler.t.sol`, `issuer/test/e2e/recycle.test.ts`.

## Found after the review

Two bugs in code written after the review, both in the recycler deployed to testnet on 2026-10-24.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| N1 | High | The approval service screened the recycler, not the address it recycled for, so a blocklisted address could have been approved | Fixed |
| N2 | Medium | A recycled deposit couldn't be ragequit through the recycler after part of it was withdrawn | Fixed, recycler redeployed |

### N1: blocklist bypass through the recycler

**What.** The pool records whoever calls it as a deposit's depositor. For a deposit made through the recycler, that is the recycler contract, and the approval service screened the depositor the pool recorded. So any address, including one on the blocklist, could have put USDG into the pool through the recycler and had the deposit approved. The screening would have kept running and reporting results as if it were working.

**Timeline (2026-10-24, UTC).**

- 13:37: the first SodiRecycler, `0x2302…37AF`, deployed to testnet.
- 13:56: two of the live agent's own sessions recycled through it.
- About 15:50: raised in review of the yield-pool wiring plan (the yield router has the same shape), and confirmed against the code.
- 16:06: replacement recycler deployed (for N2).
- 16:08: approval-service fix pushed.

**Impact.** Live on testnet for about two and a half hours. The first recycler emitted exactly two `Recycled` events, both from the live agent's own session addresses (`0x1dc9…7C75`, `0x1f6A…70eE`). No outside address used it, and nothing was wrongly approved. Testnet only; nothing on mainnet.

**Fix.** The approval service treats the recycler and the yield router as trusted forwarders, listed in the deployment file. For a deposit they make, the depositor it screens is the address named in their own event for the same commitment, in the same transaction. If there is no such event, the deposit is denied. Every other depositor, contract or ordinary account, is screened as itself. As a guard against forwarders the service doesn't know about, a contract depositor that emits its own event about the deposit in the same transaction (which is what a forwarder does) is denied unless an operator allows it. Re-run against live testnet: the two recycled deposits now resolve to the sessions that made them.

**Tests.** `asp/test/service.test.ts`: a blocklisted depositor going through the router or the recycler is denied; a missing or mismatched forwarder event fails closed; a forwarder-like contract is denied; a Safe depositing directly is approved and a blocklisted Safe is denied; older records are re-classified. On a mainnet fork through the real yield router, a blocklisted depositor is denied (`packages/rx402/test/e2e-mainnet`).

### N2: ragequit through the recycler after a partial withdrawal

**What.** The recycler, the depositor the pool records, forwards ragequits back to the address the funds came from, and it recorded that address against the deposit's commitment. A withdrawal replaces a deposit's commitment with a new one; only its label stays the same. So once part of a recycled deposit had been withdrawn, a ragequit through the recycler failed with "unknown commitment". The yield router had the same code but was fixed before it was deployed.

**Impact.** One live deposit was affected: the one recycled from `0x1dc9…7C75`, partly withdrawn at 14:00 UTC. Its remaining 0.00465 USDG can't be ragequit through the first recycler. It can still be withdrawn privately, like any note, so nothing is lost. A ragequit is the exit that needs no relayer and no approval, so the bug would have bitten exactly when that exit mattered.

**Fix.** The recycler and the router record refunds by label. Recycler redeployed at 16:06 UTC (`0x9727…1055`). The first stays a trusted forwarder for the approval service, since deposits were made through it. The SDK gained a ragequit prover (`RagequitProver`, over the hash-checked commitment circuit) and handles ragequits when syncing.

**Tests.** Foundry: a ragequit of what's left after a partial withdrawal, through the recycler and through the router. Real proofs: a ragequit through the yield router on a mainnet fork, and live on testnet, where the router returned the owner's deposit (`0x7626…141a`).

## Open and accepted

- **C4: shared sequential nonce.** SodiMemory and SodiA2A use one relay nonce per signer. Concurrent relayed writes from two copies of one agent collide, a relayer can hold a signed write until its deadline, and a gasless agent can't cancel one. Fixing this means new contracts: unordered nonces with cancellation, or for memory, dropping the nonce in favour of the version check. Planned before mainnet.
- **Key-derivation signatures are spending and reading keys.** Anyone who gets a user to sign the exact derivation message gets those keys. The messages say so, but a wallet UI can't enforce it.
- **Metadata.** Envelope sizes are bucketed, and reader counts are visible. Who talks to whom on-chain, when, and how often is public. Each component's README lists what it hides and what it doesn't.

## Verification

- Unit tests across all workspaces and the five Foundry suites pass, and run in CI on every push.
- The fork end-to-end suites pass against Robinhood Chain testnet state: rx402, MCP, stealth (with real USDG), A2A, memory, ERC-8183 and disclosure.
- Live on testnet after the fixes: the hardened settler was deployed and the stealth demo re-run, and the demo agent paid with real USDG through it, opening a session with the new crash-safe flow.

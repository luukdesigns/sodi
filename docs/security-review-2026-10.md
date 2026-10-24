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
- **Who really deposited.** Deposits made through a forwarder (the recycler, and the yield router) were recorded with the forwarder as depositor, so the approval service screened the forwarder, and a blocklisted address could have recycled into the pool and been approved. The approval service now takes the real depositor from the forwarder's own event, fails closed when there isn't one, and denies other contract depositors unless allowed. Found before any outside deposit used the recycler. Tests: `asp/test`.
- **Ragequit after a partial withdrawal.** The first recycler recorded ragequit refunds by commitment, which changes when part of a deposit is withdrawn, so such a deposit couldn't be ragequit through it (it could still be withdrawn privately). Redeployed keyed by label. The SDK now has a ragequit prover, tested with real proofs through the yield router.
- **Leftover funds.** The new [SodiRecycler](../contracts/README.md#sodirecycler) puts leftover session funds and stealth payments back into the pool. Its authorization binds the deposit and the fee, so a front-runner or the relayer can't redirect it, and a ragequit can only return funds to where they came from. The client won't recycle a session while a payment it signed could still be settled. Tests: `contracts/test/SodiRecycler.t.sol`, `issuer/test/e2e/recycle.test.ts`.

## Open and accepted

- **C4: shared sequential nonce.** SodiMemory and SodiA2A use one relay nonce per signer. Concurrent relayed writes from two copies of one agent collide, a relayer can hold a signed write until its deadline, and a gasless agent can't cancel one. Fixing this means new contracts: unordered nonces with cancellation, or for memory, dropping the nonce in favour of the version check. Planned before mainnet.
- **Key-derivation signatures are spending and reading keys.** Anyone who gets a user to sign the exact derivation message gets those keys. The messages say so, but a wallet UI can't enforce it.
- **Metadata.** Envelope sizes are bucketed, and reader counts are visible. Who talks to whom on-chain, when, and how often is public. Each component's README lists what it hides and what it doesn't.

## Verification

- Unit tests across all workspaces and the five Foundry suites pass, and run in CI on every push.
- The fork end-to-end suites pass against Robinhood Chain testnet state: rx402, MCP, stealth (with real USDG), A2A, memory, ERC-8183 and disclosure.
- Live on testnet after the fixes: the hardened settler was deployed and the stealth demo re-run, and the demo agent paid with real USDG through it, opening a session with the new crash-safe flow.

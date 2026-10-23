# Sodi Disclosure

**Show an auditor exactly what you choose, and prove it's real.**

Everything in Sodi is private by default: payments, messages, job deliverables, memory. Businesses still need accountants, auditors and regulators to see some of it. Sodi Disclosure gives scoped, verifiable read access across all of it, with no new contract.

- **Pick exactly what to share.** One message thread, chosen versions of one memory slot, one job's deliverable and review, one deposit's history. Everything else stays private.
- **The auditor checks it against the chain.** They fetch every ciphertext from the chain themselves and open it under the context the chain records, so an owner can't substitute fake content or misattribute who wrote it.
- **Source of funds for rx402.** Reveal one deposit and the auditor verifies on-chain which sessions it funded, without seeing any other deposit.
- **Ongoing access, revocable going forward.** A standing grant adds the auditor as a reader of future writes, until it's revoked.

> Experimental and unaudited.

## How it works

Every Sodi envelope encrypts its content once with its own random key, then wraps that key for each recipient. An owner who can read an item can recover that one key and hand it over. It opens that item and nothing else.

| Source | What can be disclosed | What the auditor verifies |
| --- | --- | --- |
| A2A messages | Any messages the owner can read, filtered by channel, counterparty or type | Ciphertext and author come from the chain's `Posted` log |
| ERC-8183 jobs | The deliverable and the evaluator's confidential review | The envelope matches the job's public commitment |
| Memory | Chosen versions of a slot | The envelope matches the on-chain content hash, inline or from a blob store |
| rx402 pool | One deposit's chain of secrets | Each commitment and nullifier recomputes to what the pool recorded, and maps to the relayed session addresses |

Grants travel as an encrypted A2A message to the auditor. Grants claiming to come from someone other than their on-chain sender are ignored.

## Live on Robinhood Chain testnet

`sdk/demo/disclose.ts` ran live. Orion has a deal thread with Bob, a personal chat with Carol, two memory slots and ERC-8183 job #1 (from the privacy-hook demo). Orion discloses the Bob thread, the trade log and the job to an auditor, Ada:

```
a2a                  by 0xF4411EC2…  {"with":"bob","text":"Offer: 100 GPU-hours at 0.45 tUSD"}
a2a                  by 0x23dC8F3C…  {"with":"orion","text":"Accepted"}
memory               by 0xF4411EC2…  [{"id":1,"side":"buy","symbol":"NVDA","qty":10}]
memory               by 0xF4411EC2…  [… ,{"id":2,"side":"sell","symbol":"TSLA","qty":4}]
erc8183-deliverable  by 0x41db96BB…  {"work":{"title":"Vesting contract review", …
erc8183-review       by 0xE1F276aA…  {"review":{"verdict":"Findings reproduced; H-1 is real. Approved."}}
failures: 0; mentions Carol or the personal slot: no

Standing access to the trade log, then revoked: Ada can read v3 only.
```

Grant message: `0x304d62586d3948274a725b5fb1bff3c060bf3240ca4490033049afcfce620bf5`.

The rx402 source-of-funds check runs on a testnet fork in the test suite, since it needs testnet USDG.

## Usage

```ts
import { Auditor, Discloser, StandingGrants, disclosePoolNote, memoryScope } from '@sodi/disclosure';

// Owner
const d = new Discloser(publicClient, ownerIdentity);
const items = [
  ...(await d.collectMessages({ contract: A2A, channelId: 0n, fromBlock, filter: (m) => m.author === bob })),
  ...(await d.collectMemory(memory, MEMORY, 'trades')),
  ...(await d.collectJob({ hook: HOOK, jobId: 1n, fromBlock })),
];
const pool = [await disclosePoolNote({ publicClient, mnemonic, pool: POOL, entrypoint: ENTRYPOINT, note })];
await d.send({ auditor, note: 'Q4 review', items, pool });

// Auditor
const a = new Auditor(publicClient, auditorIdentity);
const [grant] = await a.grants(fromBlock);
const { records, failures } = await a.readGrant(grant);
const sessions = await a.verifyPool(grant, poolDeploymentBlock);

// Ongoing access
const standing = new StandingGrants(memory, ownerIdentity);
await standing.grant(auditor, memoryScope(memory.slotId('trades')), 'ongoing access');
await memory.set('trades', value, { shareWith: await standing.readersFor(scope) });
await standing.revoke(auditor, scope);
```

## Disclosure cannot be undone

- **Revoking stops future access only.** Anything the auditor has already been able to read, they can keep. A standing grant covers every version written while it was active.
- **A content key is permanent.** It opens its item forever; there's no expiry.
- **Pool disclosure reveals a whole deposit.** Sessions from the same deposit are chained, so disclosing it shows every session it funded up to the time of disclosure. Use separate deposits for activity you want to disclose separately.
- **Metadata is visible.** Anyone can see that the owner sent a message to the auditor, though not what it says.

## Tests

`sdk/test/e2e/disclosure.test.ts` runs on a testnet fork against real Sodi contracts and the deployed pool, and checks that:

- exactly the chosen thread, slot versions, job items and deposit are readable, with authors taken from the chain;
- a key reused on an item outside the grant fails;
- a forged grant from another account is ignored;
- a pool disclosure with someone else's secrets is rejected;
- standing access covers only versions written while granted.

The A2A crypto suite adds tests that a content key opens exactly one envelope, can't be recovered by non-recipients, and respects the envelope's context.

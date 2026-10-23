# Sodi Memory

**Encrypted, versioned memory for AI agents, anchored on-chain.**

Agents lose their memory when a process restarts or moves to another machine, and keeping it in a database means trusting whoever runs that database. Sodi Memory stores an agent's notes and state encrypted, with the chain as the source of truth for what the latest version is.

- **Nothing to store but the wallet.** The memory key is derived from a wallet signature. A restarted agent recovers everything from its wallet alone.
- **Only ciphertext leaves the agent.** The contract rejects plaintext. Slot names are hidden behind a per-agent salt, so nobody can tell which slot is `portfolio`.
- **Small or large.** Small memory goes inline on-chain, with no other infrastructure needed. Large memory goes to any blob store (disk, S3, IPFS), with only its hash and location on-chain.
- **Tamper-proof storage.** The on-chain hash pins every version, so a blob store can't alter or roll back what it serves.
- **Safe concurrent writes.** Writes are compare-and-swap on a version number, so two copies of one agent can't silently overwrite each other. `update()` retries automatically.
- **Shared memory.** A write can be made readable by teammates too, using their published messaging keys.
- **Key rotation.** Keys come in numbered epochs; rotating re-encrypts current memory under a new key.
- **Gasless.** Agents sign, and a relayer submits. The signature fixes the slot, version, content hash and location.

> Experimental and unaudited.

## Live on Robinhood Chain testnet

[`SodiMemory` at `0x5792659446E32eF320Dd19b42cc27a3737ac710e`](https://explorer.testnet.chain.robinhood.com/address/0x5792659446E32eF320Dd19b42cc27a3737ac710e). The demo's transactions are in [`deployments/46630.json`](./deployments/46630.json).

## The demo

`sdk/demo/memory.ts`, run live. Sage is a trading agent with no gas.

```
1. Writes two memories: a small one on-chain, a large one in a blob store
2. Restarts with nothing but its wallet, and recovers everything            recovered: yes
3. Two copies write at once: the stale one is stopped, then retries        both changes kept
4. The blob store is tampered with                                          detected
5. Hands a note to teammate Juno, readable by the two of them only          Juno reads it: yes
6. What anyone watching the chain sees:
     slot 0x1b14b960a6… v1  380-byte ciphertext
     slot 0x6f6280a867… v1  pointer file://0e3e25f5850…
     …
7. Rotates to a new key: current memory moves over, history stays readable
```

## Usage

```ts
import { AgentMemory, FileBlobStore, WalletMemoryRelayer } from '@sodi/memory';

const memory = new AgentMemory({
  publicClient, wallet,
  contract: '0x5792659446E32eF320Dd19b42cc27a3737ac710e',
  fromBlock: 141454229n,
  relayer,                        // optional: gasless writes
  blobs: new FileBlobStore('./blobs'),
});
await memory.init();

await memory.set('portfolio', { positions: [...] });
const { value, version } = await memory.get('portfolio');
await memory.update('portfolio', (p) => ({ ...p, cash: 120 }));   // retries on conflict
```

## Important: public data is permanent

Everything written to a chain stays there forever, encrypted or not. If a memory key ever leaks, every version written under it can be decrypted, and nothing can be deleted.

- **Rotation protects the future, not the past.** Old versions stay readable to whoever holds the old key.
- **Prefer a blob store for anything sensitive.** On-chain then holds only a hash, and you can delete the blob itself.
- **Don't store long-lived secrets** (API keys, seed phrases) in memory at all.

## What's visible on-chain

| Private | Visible |
| --- | --- |
| Contents | The agent's address, and when it writes |
| Slot names | Per-slot version numbers and write frequency |
| Who else can read a shared write | Approximate size (padded to buckets), or the blob location |

## Layout and tests

```
memory/
├── contracts/   SodiMemory.sol, 10 Foundry tests
├── sdk/         @sodi/memory, 7 unit tests, demo, fork test
└── deployments/
```

The SDK reuses the [Sodi A2A](../a2a) envelope format and crypto, with a separately derived key.

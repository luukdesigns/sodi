import { type KeyPair, open, seal } from '@sodi/a2a';
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  hexToBytes,
  keccak256,
  toBytes,
} from 'viem';

import { memoryCommittedEvent, sodiMemoryAbi } from './abi.js';
import type { BlobStore } from './blobs.js';
import { deriveMemoryKey, deriveNamespaceSalt, privateNamespace, publicNamespace } from './keys.js';

/** Submits signed commits for agents without gas. It can only submit or drop them, never alter them. */
export interface MemoryRelayer {
  commitFor(args: {
    agent: Address;
    namespace: Hex;
    expectedVersion: bigint;
    envelope: Hex;
    contentHash: Hex;
    location: string;
    deadline: bigint;
    signature: Hex;
  }): Promise<Hex>;
}

export class WalletMemoryRelayer implements MemoryRelayer {
  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly contract: Address,
  ) {}

  async commitFor(a: Parameters<MemoryRelayer['commitFor']>[0]): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contract,
      abi: sodiMemoryAbi,
      functionName: 'commitFor',
      args: [a.agent, a.namespace, a.expectedVersion, a.envelope, a.contentHash, a.location, a.deadline, a.signature],
      account: this.wallet.account!,
      chain: this.wallet.chain,
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`commitFor reverted: ${hash}`);
    return hash;
  }
}

export interface MemoryConfig {
  publicClient: PublicClient;
  wallet: WalletClient;
  contract: Address;
  /** Block the contract was deployed at; history is read from here. */
  fromBlock: bigint;
  relayer?: MemoryRelayer;
  /** Needed for envelopes larger than `inlineLimit`. */
  blobs?: BlobStore;
  /** Envelopes up to this size are stored on-chain; larger ones go to `blobs`. Default 4096. */
  inlineLimit?: number;
  /** Current key epoch (default 1). Older epochs are still tried when reading. */
  epoch?: number;
}

export interface Slot {
  /** Plain name, hidden on-chain behind a salted hash. */
  name?: string;
  /** Or an explicit slot id, e.g. one shared by name with `publicNamespace`. */
  id?: Hex;
}

export interface Entry<T> {
  value: T;
  version: bigint;
  epoch: number;
  writtenAt: number;
}

export class VersionConflictError extends Error {
  constructor(readonly current: bigint) {
    super(`memory slot changed underneath you (now at version ${current})`);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Encrypted, versioned key-value memory for one agent. Values are JSON. Only this agent can read them,
 * plus any agents it explicitly shares a write with.
 */
export class AgentMemory {
  private keys = new Map<number, KeyPair>();
  private salt?: Uint8Array;
  private chainId?: number;
  readonly epoch: number;

  constructor(private readonly c: MemoryConfig) {
    this.epoch = c.epoch ?? 1;
  }

  get address(): Address {
    return this.c.wallet.account!.address;
  }

  /** Derives the namespace salt and the current epoch key from wallet signatures. */
  async init(): Promise<void> {
    this.salt = await deriveNamespaceSalt(this.c.wallet);
    this.keys.set(this.epoch, await deriveMemoryKey(this.c.wallet, this.epoch));
    this.chainId = await this.c.publicClient.getChainId();
  }

  /** This agent's memory public key for the current epoch (to share with teammates, if wanted). */
  get publicKey(): Hex {
    return this.key(this.epoch).publicKey;
  }

  private key(epoch: number): KeyPair {
    const k = this.keys.get(epoch);
    if (!k) throw new Error('call init() first');
    return k;
  }

  slotId(slot: Slot | string): Hex {
    const s = typeof slot === 'string' ? { name: slot } : slot;
    if (s.id) return s.id;
    if (!this.salt) throw new Error('call init() first');
    return privateNamespace(this.salt, s.name!);
  }

  async head(slot: Slot | string, owner: Address = this.address) {
    const [version, contentHash] = await this.c.publicClient.readContract({
      address: this.c.contract,
      abi: sodiMemoryAbi,
      functionName: 'heads',
      args: [owner, this.slotId(slot)],
    });
    return { version: BigInt(version), contentHash };
  }

  // ------------------------------------------------------------------ write

  /**
   * Writes a new version. Pass `expectedVersion` to fail rather than overwrite a newer write from
   * another copy of this agent; by default the current head is used.
   * `shareWith` adds other X25519 public keys (e.g. teammates' messaging keys) as readers of this version.
   */
  async set<T>(
    slot: Slot | string,
    value: T,
    opts: { expectedVersion?: bigint; shareWith?: Hex[] } = {},
  ): Promise<{ version: bigint; tx: Hex; inline: boolean }> {
    const id = this.slotId(slot);
    const expected = opts.expectedVersion ?? (await this.head({ id })).version;
    const plaintext = enc.encode(JSON.stringify({ v: 1, epoch: this.epoch, t: Math.floor(Date.now() / 1000), value }));
    const envelope = seal(plaintext, [this.publicKey, ...(opts.shareWith ?? [])], this.context(id, this.address));
    const contentHash = keccak256(envelope);

    const inline = envelope.length <= (this.c.inlineLimit ?? 4096);
    let location = '';
    if (!inline) {
      if (!this.c.blobs) throw new Error('memory too large to store inline; configure a blob store');
      location = await this.c.blobs.put(envelope);
    }
    const envelopeHex: Hex = inline ? bytesToHex(envelope) : '0x';

    try {
      const tx = this.c.relayer
        ? await this.commitViaRelayer(id, expected, envelopeHex, contentHash, location)
        : await this.commitDirect(id, expected, envelopeHex, contentHash, location, inline);
      return { version: expected + 1n, tx, inline };
    } catch (err) {
      const conflict = versionConflict(err);
      if (conflict !== undefined) throw new VersionConflictError(conflict);
      throw err;
    }
  }

  /** Read-modify-write with automatic retry when another copy of the agent wrote in between. */
  async update<T>(slot: Slot | string, fn: (current: T | undefined) => T, retries = 3): Promise<Entry<T>> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.get<T>(slot);
      const next = fn(current?.value);
      try {
        const { version } = await this.set(slot, next, { expectedVersion: current?.version ?? 0n });
        return { value: next, version, epoch: this.epoch, writtenAt: Math.floor(Date.now() / 1000) };
      } catch (err) {
        if (!(err instanceof VersionConflictError) || attempt >= retries) throw err;
      }
    }
  }

  private async commitDirect(id: Hex, expected: bigint, envelope: Hex, contentHash: Hex, location: string, inline: boolean) {
    const { wallet, publicClient, contract } = this.c;
    const hash = inline
      ? await wallet.writeContract({
          address: contract,
          abi: sodiMemoryAbi,
          functionName: 'commitInline',
          args: [id, expected, envelope],
          account: wallet.account!,
          chain: wallet.chain,
        })
      : await wallet.writeContract({
          address: contract,
          abi: sodiMemoryAbi,
          functionName: 'commitPointer',
          args: [id, expected, contentHash, location],
          account: wallet.account!,
          chain: wallet.chain,
        });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`commit reverted: ${hash}`);
    return hash;
  }

  private async commitViaRelayer(id: Hex, expected: bigint, envelope: Hex, contentHash: Hex, location: string) {
    const { wallet, publicClient, contract } = this.c;
    // Check for a conflict up front: the relayer would only report a generic failure.
    const head = await this.head({ id });
    if (head.version !== expected) throw new VersionConflictError(head.version);
    const [nonce, block] = await Promise.all([
      publicClient.readContract({ address: contract, abi: sodiMemoryAbi, functionName: 'nonces', args: [this.address] }),
      publicClient.getBlock(),
    ]);
    const deadline = block.timestamp + 600n;
    const signature = await wallet.signTypedData({
      account: wallet.account!,
      domain: { name: 'SodiMemory', version: '1', chainId: this.chainId!, verifyingContract: contract },
      types: {
        Commit: [
          { name: 'agent', type: 'address' },
          { name: 'namespace', type: 'bytes32' },
          { name: 'expectedVersion', type: 'uint64' },
          { name: 'contentHash', type: 'bytes32' },
          { name: 'locationHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Commit',
      message: {
        agent: this.address,
        namespace: id,
        expectedVersion: expected,
        contentHash,
        locationHash: keccak256(toBytes(location)),
        nonce,
        deadline,
      },
    });
    return this.c.relayer!.commitFor({
      agent: this.address,
      namespace: id,
      expectedVersion: expected,
      envelope,
      contentHash: envelope === '0x' ? contentHash : `0x${'0'.repeat(64)}`,
      location,
      deadline,
      signature,
    });
  }

  // ------------------------------------------------------------------ read

  /** Latest value, or undefined if the slot is empty. */
  async get<T>(slot: Slot | string): Promise<Entry<T> | undefined> {
    const all = await this.history<T>(slot, { latestOnly: true });
    return all.at(-1);
  }

  /** Every version this agent can still decrypt, oldest first. */
  async history<T>(slot: Slot | string, opts: { latestOnly?: boolean; owner?: Address } = {}): Promise<Entry<T>[]> {
    const id = this.slotId(slot);
    const owner = opts.owner ?? this.address;
    const head = await this.head({ id }, owner);
    if (head.version === 0n) return [];

    const logs = await this.c.publicClient.getLogs({
      address: this.c.contract,
      event: memoryCommittedEvent,
      args: { agent: owner, namespace: id },
      fromBlock: this.c.fromBlock,
    });
    const chosen = opts.latestOnly ? logs.filter((l) => l.args.version === head.version) : logs;
    if (opts.latestOnly && chosen.length === 0) throw new Error('head version not found in logs; check fromBlock');

    const out: Entry<T>[] = [];
    for (const log of chosen) {
      const envelope = await this.fetchEnvelope(log.args.envelope!, log.args.location!);
      // The on-chain hash pins the content: a blob store cannot alter or roll back what it serves.
      if (keccak256(envelope) !== log.args.contentHash) throw new Error(`memory version ${log.args.version} failed its integrity check`);
      const plain = await this.decrypt(envelope, id, owner);
      if (!plain) continue;
      out.push({ value: plain.value as T, version: BigInt(log.args.version!), epoch: plain.epoch, writtenAt: plain.t });
    }
    return out;
  }

  private async fetchEnvelope(inline: Hex, location: string): Promise<Uint8Array> {
    if (inline !== '0x') return hexToBytes(inline);
    if (!this.c.blobs) throw new Error(`memory stored at ${location}; configure a blob store to read it`);
    return this.c.blobs.get(location);
  }

  private async decrypt(envelope: Uint8Array, id: Hex, owner: Address) {
    const ctx = this.context(id, owner);
    // Current epoch first, then older ones (deriving them on demand).
    for (let e = this.epoch; e >= 1; e--) {
      if (!this.keys.has(e)) this.keys.set(e, await deriveMemoryKey(this.c.wallet, e));
      const plain = open(envelope, this.keys.get(e)!, ctx);
      if (plain) return JSON.parse(dec.decode(plain)) as { value: unknown; epoch: number; t: number };
    }
    return null;
  }

  /** Reads a slot another agent shared with `reader` (e.g. this agent's messaging key pair). */
  async readShared<T>(owner: Address, id: Hex, reader: KeyPair): Promise<Entry<T> | undefined> {
    const head = await this.head({ id }, owner);
    if (head.version === 0n) return undefined;
    const logs = await this.c.publicClient.getLogs({
      address: this.c.contract,
      event: memoryCommittedEvent,
      args: { agent: owner, namespace: id },
      fromBlock: this.c.fromBlock,
    });
    const log = logs.find((l) => l.args.version === head.version);
    if (!log) return undefined;
    const envelope = await this.fetchEnvelope(log.args.envelope!, log.args.location!);
    if (keccak256(envelope) !== log.args.contentHash) throw new Error('shared memory failed its integrity check');
    const plain = open(envelope, reader, this.context(id, owner));
    if (!plain) return undefined;
    const p = JSON.parse(dec.decode(plain));
    return { value: p.value as T, version: head.version, epoch: p.epoch, writtenAt: p.t };
  }

  /**
   * Moves to a new key epoch: re-encrypts the latest version of each slot under the new key.
   * Older versions stay encrypted under the old key and remain on-chain; rotation protects the future,
   * not the past.
   */
  async rotate(slots: (Slot | string)[], toEpoch: number): Promise<AgentMemory> {
    const next = new AgentMemory({ ...this.c, epoch: toEpoch });
    await next.init();
    for (const s of slots) {
      const current = await this.get(s);
      if (current) await next.set(s, current.value, { expectedVersion: current.version });
    }
    return next;
  }

  private context(id: Hex, owner: Address) {
    return { chainId: this.chainId!, contract: this.c.contract, channelId: BigInt(id), author: owner };
  }
}

function versionConflict(err: unknown): bigint | undefined {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'VersionConflict') {
      return BigInt(revert.data.args![0] as bigint);
    }
  }
  return undefined;
}

export { publicNamespace };

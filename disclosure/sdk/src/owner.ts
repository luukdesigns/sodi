import { type A2AClient, unwrapContentKey } from '@sodi/a2a';
import type { AgentMemory, Slot } from '@sodi/memory';
import {
  type Address,
  type Hex,
  type PublicClient,
  bytesToHex,
  hexToBytes,
  keccak256,
  parseAbiItem,
  toHex,
} from 'viem';

import type { DisclosedItem, Grant, PoolDisclosure, StandingGrant } from './types.js';

const postedEvent = parseAbiItem('event Posted(uint256 indexed channelId, address indexed author, bytes envelope)');
const deliverableEvent = parseAbiItem(
  'event ConfidentialDeliverable(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bytes envelope)',
);
const reasonEvent = parseAbiItem(
  'event ConfidentialReason(uint256 indexed jobId, address indexed evaluator, bytes4 indexed action, bytes32 reason, bytes envelope)',
);

const MAX_ITEMS_PER_MESSAGE = 25; // keeps each grant message inside the largest envelope bucket

/**
 * The owner's side of disclosure: pick exactly which items an auditor may read, and deliver the keys.
 * Only items the owner can already decrypt can be disclosed.
 */
export class Discloser {
  private chainId?: number;

  constructor(
    private readonly publicClient: PublicClient,
    /** The owner's messaging identity (initialized). Used to unwrap A2A and ERC-8183 envelopes and to send grants. */
    private readonly identity: A2AClient,
  ) {}

  get owner(): Address {
    return this.identity.address;
  }

  private async getChainId() {
    this.chainId ??= await this.publicClient.getChainId();
    return this.chainId;
  }

  /**
   * A2A messages on the given channel the owner can read. `filter` sees the decrypted message, e.g. to
   * share only one counterparty's thread or one message type.
   */
  async collectMessages(opts: {
    contract: Address;
    channelId: bigint;
    fromBlock: bigint;
    filter?: (m: { author: Address; type: string; body: unknown }) => boolean;
  }): Promise<DisclosedItem[]> {
    const chainId = await this.getChainId();
    const logs = await this.publicClient.getLogs({
      address: opts.contract,
      event: postedEvent,
      args: { channelId: opts.channelId },
      fromBlock: opts.fromBlock,
    });
    const items: DisclosedItem[] = [];
    for (const log of logs) {
      const ctx = { chainId, contract: opts.contract, channelId: log.args.channelId!, author: log.args.author! };
      const envelope = hexToBytes(log.args.envelope!);
      const key = unwrapContentKey(envelope, this.identity.keyPair, ctx);
      if (!key) continue;
      if (opts.filter) {
        const { openWithContentKey } = await import('@sodi/a2a');
        const m = JSON.parse(new TextDecoder().decode(openWithContentKey(envelope, key, ctx)!));
        if (!opts.filter({ author: log.args.author!, type: m.type, body: m.body })) continue;
      }
      items.push({ kind: 'a2a', chainId, contract: opts.contract, ref: `${log.transactionHash}:${log.logIndex}`, contentKey: bytesToHex(key) });
    }
    return items;
  }

  /** The deliverable and (if confidential) the evaluator's review of one ERC-8183 job. */
  async collectJob(opts: { hook: Address; jobId: bigint; fromBlock: bigint }): Promise<DisclosedItem[]> {
    const chainId = await this.getChainId();
    const items: DisclosedItem[] = [];
    const deliverables = await this.publicClient.getLogs({ address: opts.hook, event: deliverableEvent, args: { jobId: opts.jobId }, fromBlock: opts.fromBlock });
    const reasons = await this.publicClient.getLogs({ address: opts.hook, event: reasonEvent, args: { jobId: opts.jobId }, fromBlock: opts.fromBlock });
    for (const [kind, logs, authorOf] of [
      ['erc8183-deliverable', deliverables, (l: (typeof deliverables)[number]) => l.args.provider!],
      ['erc8183-review', reasons, (l: (typeof reasons)[number]) => l.args.evaluator!],
    ] as const) {
      for (const log of logs as never[]) {
        const l = log as { args: { envelope: Hex }; transactionHash: Hex; logIndex: number };
        const ctx = { chainId, contract: opts.hook, channelId: opts.jobId, author: (authorOf as (x: never) => Address)(log) };
        const key = unwrapContentKey(hexToBytes(l.args.envelope), this.identity.keyPair, ctx);
        if (key) items.push({ kind, chainId, contract: opts.hook, ref: `${l.transactionHash}:${l.logIndex}`, contentKey: bytesToHex(key) });
      }
    }
    return items;
  }

  /** Selected versions (default: all) of one memory slot. */
  async collectMemory(memory: AgentMemory, contract: Address, slot: Slot | string, versions?: bigint[]): Promise<DisclosedItem[]> {
    const chainId = await this.getChainId();
    const keys = await memory.contentKeys(slot, { versions });
    return keys.map((k) => ({
      kind: 'memory' as const,
      chainId,
      contract,
      ref: k.ref,
      contentKey: k.contentKey,
      ...(k.location ? { location: k.location } : {}),
    }));
  }

  /**
   * Seals the grant to the auditor and posts it as A2A messages (split if large). Returns the
   * transaction hashes. Anyone can see that the owner messaged the auditor; only the auditor can read it.
   */
  async send(opts: {
    auditor: Address;
    note: string;
    items: DisclosedItem[];
    pool?: PoolDisclosure[];
    channelId?: bigint;
  }): Promise<Hex[]> {
    const grantId = keccak256(toHex(`${this.owner}:${Date.now()}:${Math.random()}`)).slice(0, 18);
    const chunks: DisclosedItem[][] = [];
    for (let i = 0; i < opts.items.length; i += MAX_ITEMS_PER_MESSAGE) chunks.push(opts.items.slice(i, i + MAX_ITEMS_PER_MESSAGE));
    if (chunks.length === 0) chunks.push([]);
    const txs: Hex[] = [];
    for (const [index, items] of chunks.entries()) {
      const grant: Grant = {
        v: 1,
        owner: this.owner,
        issuedAt: Math.floor(Date.now() / 1000),
        note: opts.note,
        items,
        ...(index === 0 && opts.pool ? { pool: opts.pool } : {}),
        part: { index, total: chunks.length, grantId },
      };
      txs.push(await this.identity.send({ to: [opts.auditor], channelId: opts.channelId ?? 0n, type: 'sodi-disclosure', body: grant }));
    }
    return txs;
  }
}

/**
 * Ongoing access: the owner keeps a list of auditors per scope in its private memory and adds them as
 * readers of future writes. Revoking stops future access only; anything already shared stays readable.
 */
export class StandingGrants {
  static readonly SLOT = 'sodi:disclosure-policy';

  constructor(
    private readonly memory: AgentMemory,
    private readonly identity: A2AClient,
  ) {}

  async list(): Promise<StandingGrant[]> {
    return (await this.memory.get<StandingGrant[]>(StandingGrants.SLOT))?.value ?? [];
  }

  /** Public keys that should be added as readers for a write in `scope`. */
  async readersFor(scope: string): Promise<Hex[]> {
    return (await this.list()).filter((g) => g.scope === scope && !g.revokedAt).map((g) => g.auditorKey);
  }

  async grant(auditor: Address, scope: string, note: string): Promise<void> {
    const auditorKey = await this.identity.keyOf(auditor);
    await this.memory.update<StandingGrant[]>(StandingGrants.SLOT, (cur) => [
      ...(cur ?? []).filter((g) => !(g.auditor === auditor && g.scope === scope && !g.revokedAt)),
      { auditor, auditorKey, scope, since: Math.floor(Date.now() / 1000) },
    ]);
    await this.identity.send({ to: [auditor], type: 'sodi-standing-grant', body: { scope, note, owner: this.identity.address } });
  }

  async revoke(auditor: Address, scope: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.memory.update<StandingGrant[]>(StandingGrants.SLOT, (cur) =>
      (cur ?? []).map((g) => (g.auditor === auditor && g.scope === scope && !g.revokedAt ? { ...g, revokedAt: now } : g)),
    );
    await this.identity.send({ to: [auditor], type: 'sodi-standing-revoked', body: { scope, owner: this.identity.address } });
  }
}

export const memoryScope = (slotId: Hex) => `memory:${slotId.toLowerCase()}`;

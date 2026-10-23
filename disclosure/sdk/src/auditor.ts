import { type A2AClient, open, openWithContentKey } from '@sodi/a2a';
import type { BlobStore } from '@sodi/memory';
import {
  type Address,
  type Hex,
  type PublicClient,
  decodeEventLog,
  hexToBytes,
  keccak256,
  parseAbiItem,
} from 'viem';

import { verifyPoolDisclosure, type VerifiedPoolHistory } from './pool.js';
import type { DisclosedItem, Grant } from './types.js';

const events = {
  a2a: parseAbiItem('event Posted(uint256 indexed channelId, address indexed author, bytes envelope)'),
  'erc8183-deliverable': parseAbiItem(
    'event ConfidentialDeliverable(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bytes envelope)',
  ),
  'erc8183-review': parseAbiItem(
    'event ConfidentialReason(uint256 indexed jobId, address indexed evaluator, bytes4 indexed action, bytes32 reason, bytes envelope)',
  ),
  memory: parseAbiItem(
    'event MemoryCommitted(address indexed agent, bytes32 indexed namespace, uint64 version, bytes32 contentHash, bytes envelope, string location)',
  ),
} as const;

export interface DisclosedRecord {
  kind: DisclosedItem['kind'];
  ref: string;
  /** On-chain author of the envelope (not the owner's claim). */
  author: Address;
  /** Channel, job id or memory slot the envelope belongs to. */
  scope: string;
  data: unknown;
}

export interface ReceivedGrant extends Grant {
  /** On-chain sender of the grant message. */
  from: Address;
  messageId: string;
}

/**
 * The auditor's side. Every disclosed item is re-fetched from the chain and opened under the context
 * the chain itself records, so what the auditor reads is exactly what was published, by its real author.
 */
export class Auditor {
  constructor(
    private readonly publicClient: PublicClient,
    /** The auditor's messaging identity (initialized), which receives grants. */
    private readonly identity: A2AClient,
    private readonly blobs?: BlobStore,
  ) {}

  /** Grants received, with multi-part grants merged. */
  async grants(fromBlock: bigint): Promise<ReceivedGrant[]> {
    const inbox = await this.identity.inbox({ fromBlock });
    const parts = inbox.filter((m) => m.type === 'sodi-disclosure');
    const merged = new Map<string, ReceivedGrant>();
    for (const m of parts) {
      const g = m.body as Grant;
      // A grant only speaks for the account that sent it on-chain.
      if (g.owner.toLowerCase() !== m.from.toLowerCase()) continue;
      const id = g.part?.grantId ?? m.id;
      const existing = merged.get(id);
      if (existing) {
        existing.items.push(...g.items);
        if (g.pool) existing.pool = [...(existing.pool ?? []), ...g.pool];
      } else {
        merged.set(id, { ...g, items: [...g.items], from: m.from, messageId: m.id });
      }
    }
    return [...merged.values()];
  }

  /** Standing grants and revocations announced to this auditor. */
  async standingNotices(fromBlock: bigint) {
    const inbox = await this.identity.inbox({ fromBlock });
    return inbox
      .filter((m) => m.type === 'sodi-standing-grant' || m.type === 'sodi-standing-revoked')
      .map((m) => ({ type: m.type, from: m.from, ...(m.body as { scope: string }) }));
  }

  /** Fetches and decrypts one disclosed item, verifying it against the chain. */
  async read(item: DisclosedItem): Promise<DisclosedRecord> {
    if ((await this.publicClient.getChainId()) !== item.chainId) throw new Error('item is for a different chain');
    const [txHash, idx] = item.ref.split(':') as [Hex, string];
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    const log = receipt.logs.find((l) => l.logIndex === Number(idx));
    if (!log || log.address.toLowerCase() !== item.contract.toLowerCase()) {
      throw new Error(`no ${item.kind} log at ${item.ref} from ${item.contract}`);
    }
    const ev = decodeEventLog({ abi: [events[item.kind]], data: log.data, topics: log.topics }) as {
      args: Record<string, unknown>;
    };
    const a = ev.args;

    let envelope: Uint8Array;
    let author: Address;
    let channel: bigint;
    let scope: string;
    switch (item.kind) {
      case 'a2a':
        envelope = hexToBytes(a.envelope as Hex);
        author = a.author as Address;
        channel = a.channelId as bigint;
        scope = `a2a channel ${channel}`;
        break;
      case 'erc8183-deliverable':
      case 'erc8183-review':
        envelope = hexToBytes(a.envelope as Hex);
        author = (item.kind === 'erc8183-deliverable' ? a.provider : a.evaluator) as Address;
        channel = a.jobId as bigint;
        scope = `ERC-8183 job ${channel}`;
        // The envelope must be the one the job publicly committed to.
        if (keccak256(envelope) !== (item.kind === 'erc8183-deliverable' ? a.deliverable : a.reason)) {
          throw new Error('envelope does not match the job commitment');
        }
        break;
      case 'memory': {
        const inline = a.envelope as Hex;
        if (inline !== '0x') envelope = hexToBytes(inline);
        else {
          if (!this.blobs) throw new Error(`memory stored at ${a.location}; a blob store is needed to read it`);
          envelope = await this.blobs.get(a.location as string);
        }
        if (keccak256(envelope) !== a.contentHash) throw new Error('memory blob failed its integrity check');
        author = a.agent as Address;
        channel = BigInt(a.namespace as Hex);
        scope = `memory slot ${(a.namespace as Hex).slice(0, 12)}… v${a.version}`;
        break;
      }
    }

    const ctx = { chainId: item.chainId, contract: item.contract, channelId: channel, author };
    const plain = openWithContentKey(envelope, hexToBytes(item.contentKey), ctx);
    if (!plain) throw new Error(`the disclosed key does not open ${item.ref}`);
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    return { kind: item.kind, ref: item.ref, author, scope, data: parsed.body ?? parsed.value ?? parsed };
  }

  /** Reads every item in a grant; items that fail verification are reported, not silently dropped. */
  async readGrant(grant: Grant): Promise<{ records: DisclosedRecord[]; failures: { ref: string; error: string }[] }> {
    const records: DisclosedRecord[] = [];
    const failures: { ref: string; error: string }[] = [];
    for (const item of grant.items) {
      try {
        records.push(await this.read(item));
      } catch (err) {
        failures.push({ ref: item.ref, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { records, failures };
  }

  async verifyPool(grant: Grant, fromBlock: bigint): Promise<VerifiedPoolHistory[]> {
    return Promise.all((grant.pool ?? []).map((p) => verifyPoolDisclosure(this.publicClient, p, fromBlock)));
  }

  /** Versions of an owner's memory slot that were shared with this auditor under a standing grant. */
  async readStandingMemory(contract: Address, owner: Address, namespace: Hex, fromBlock: bigint) {
    const chainId = await this.publicClient.getChainId();
    const logs = await this.publicClient.getLogs({
      address: contract,
      event: events.memory,
      args: { agent: owner, namespace },
      fromBlock,
    });
    const out: { version: bigint; value: unknown }[] = [];
    for (const l of logs) {
      if (l.args.envelope === '0x') continue;
      const plain = open(hexToBytes(l.args.envelope!), this.identity.keyPair, {
        chainId,
        contract,
        channelId: BigInt(namespace),
        author: owner,
      });
      if (plain) out.push({ version: BigInt(l.args.version!), value: JSON.parse(new TextDecoder().decode(plain)).value });
    }
    return out;
  }
}

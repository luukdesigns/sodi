import { type A2AClient, open, openWithContentKey, seal, unwrapContentKey } from '@sodi/a2a';
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  bytesToHex,
  hexToBytes,
  keccak256,
  parseEventLogs,
  toFunctionSelector,
} from 'viem';

import { JOB_STATUS, agenticCommerceAbi, erc20Abi, hookAbi } from './abi.js';

export interface PrivateJobsConfig {
  publicClient: PublicClient;
  wallet: WalletClient;
  /** ERC-8183 AgenticCommerce contract. */
  commerce: Address;
  /** ConfidentialDeliverableHook attached to private jobs. */
  hook: Address;
  /**
   * This agent's messaging identity (keys derived from a wallet signature and published in the
   * registry the hook reads, e.g. SodiA2A). Call `init()` and `register()` on it first.
   */
  identity: A2AClient;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const COMPLETE = toFunctionSelector('complete(uint256,bytes32,bytes)');

/**
 * One party's view of ERC-8183 jobs that use the confidential-deliverable hook. The same class serves
 * clients, providers and evaluators.
 */
export class PrivateJobs {
  private chainId?: number;

  constructor(private readonly c: PrivateJobsConfig) {}

  get address(): Address {
    return this.c.wallet.account!.address;
  }

  private async getChainId() {
    this.chainId ??= await this.c.publicClient.getChainId();
    return this.chainId;
  }

  private async write(
    address: Address,
    abi: typeof agenticCommerceAbi | typeof erc20Abi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const hash = await this.c.wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: this.c.wallet.account!,
      chain: this.c.wallet.chain,
    } as never);
    const receipt = await this.c.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  // ------------------------------------------------------------------ client

  /** Creates a job with the privacy hook attached. The description is public: keep it high level. */
  async createJob(a: { provider: Address; evaluator: Address; expiresInSeconds: number; description: string }) {
    const block = await this.c.publicClient.getBlock();
    const receipt = await this.write(this.c.commerce, agenticCommerceAbi, 'createJob', [
      a.provider,
      a.evaluator,
      block.timestamp + BigInt(a.expiresInSeconds),
      a.description,
      this.c.hook,
    ]);
    const [created] = parseEventLogs({ abi: agenticCommerceAbi, eventName: 'JobCreated', logs: receipt.logs });
    return { jobId: created!.args.jobId, tx: receipt.transactionHash };
  }

  async fund(jobId: bigint) {
    const job = await this.getJob(jobId);
    const token = await this.c.publicClient.readContract({
      address: this.c.commerce,
      abi: agenticCommerceAbi,
      functionName: 'paymentToken',
    });
    await this.write(token, erc20Abi, 'approve', [this.c.commerce, job.budget]);
    return (await this.write(this.c.commerce, agenticCommerceAbi, 'fund', [jobId, '0x'])).transactionHash;
  }

  // ------------------------------------------------------------------ provider

  async setBudget(jobId: bigint, amount: bigint) {
    return (await this.write(this.c.commerce, agenticCommerceAbi, 'setBudget', [jobId, amount, '0x'])).transactionHash;
  }

  /**
   * Encrypts the work to the client, the evaluator and the provider, commits to it as the public
   * `deliverable` hash, and submits.
   */
  async submitConfidential(jobId: bigint, work: unknown) {
    const job = await this.getJob(jobId);
    const envelope = await this.sealFor(jobId, [job.client, job.evaluator, this.address], { kind: 'deliverable', work });
    const receipt = await this.write(this.c.commerce, agenticCommerceAbi, 'submit', [jobId, keccak256(envelope), envelope]);
    return { deliverable: keccak256(envelope), tx: receipt.transactionHash, envelopeBytes: (envelope.length - 2) / 2 };
  }

  // ------------------------------------------------------------------ evaluator

  /**
   * Completes the job, releasing payment. Refuses if the evaluator can't open the deliverable. The
   * review (encrypted to client, provider and evaluator) always carries the deliverable's content key,
   * so the client can read the work even if the provider left the client out of the envelope: the
   * hook can't check who an envelope is encrypted to, but the evaluator can make sure the client gets it.
   */
  async complete(jobId: bigint, review?: unknown, opts: { fromBlock?: bigint } = {}) {
    return this.decide('complete', jobId, review, opts.fromBlock ?? 0n);
  }

  async reject(jobId: bigint, review?: unknown, opts: { fromBlock?: bigint } = {}) {
    return this.decide('reject', jobId, review, opts.fromBlock ?? 0n);
  }

  private async decide(action: 'complete' | 'reject', jobId: bigint, review: unknown, fromBlock: bigint) {
    const delivered = await this.latestDeliverable(jobId, fromBlock);
    let deliverableKey: Hex | undefined;
    if (delivered) {
      const key = unwrapContentKey(hexToBytes(delivered.envelope), this.c.identity.keyPair, await this.ctx(jobId, delivered.provider));
      if (key) deliverableKey = bytesToHex(key);
      else if (action === 'complete') throw new Error("can't open the deliverable, so it can't be approved; reject the job instead");
    }
    if (review === undefined && !deliverableKey) {
      return (await this.write(this.c.commerce, agenticCommerceAbi, action, [jobId, `0x${'0'.repeat(64)}`, '0x']))
        .transactionHash;
    }
    const job = await this.getJob(jobId);
    const envelope = await this.sealFor(jobId, [job.client, job.provider, this.address], { kind: action, review: review ?? null, deliverableKey });
    return (await this.write(this.c.commerce, agenticCommerceAbi, action, [jobId, keccak256(envelope), envelope]))
      .transactionHash;
  }

  // ------------------------------------------------------------------ reading

  async getJob(jobId: bigint) {
    const j = await this.c.publicClient.readContract({
      address: this.c.commerce,
      abi: agenticCommerceAbi,
      functionName: 'getJob',
      args: [jobId],
    });
    return { ...j, statusName: JOB_STATUS[j.status] ?? 'Unknown' };
  }

  private async latestDeliverable(jobId: bigint, fromBlock: bigint) {
    const logs = await this.c.publicClient.getContractEvents({
      address: this.c.hook,
      abi: hookAbi,
      eventName: 'ConfidentialDeliverable',
      args: { jobId },
      fromBlock,
    });
    const log = logs.at(-1);
    return log ? { provider: log.args.provider!, envelope: log.args.envelope!, deliverable: log.args.deliverable! } : undefined;
  }

  /**
   * Decrypts the deliverable if this party can: directly as a recipient, or with the content key the
   * evaluator passed on in its review. Returns null otherwise.
   */
  async readDeliverable(jobId: bigint, fromBlock: bigint): Promise<{ work: unknown; deliverable: Hex } | null> {
    const d = await this.latestDeliverable(jobId, fromBlock);
    if (!d) return null;
    let plain = await this.openFrom(jobId, d.provider, d.envelope);
    if (!plain) {
      const review = await this.readReviewRaw(jobId, fromBlock);
      const key = (review?.plain as { deliverableKey?: Hex } | undefined)?.deliverableKey;
      if (key) {
        const bytes = openWithContentKey(hexToBytes(d.envelope), hexToBytes(key), await this.ctx(jobId, d.provider));
        if (bytes) plain = JSON.parse(dec.decode(bytes));
      }
    }
    return plain ? { work: (plain as { work: unknown }).work, deliverable: d.deliverable } : null;
  }

  private async readReviewRaw(jobId: bigint, fromBlock: bigint) {
    const logs = await this.c.publicClient.getContractEvents({
      address: this.c.hook,
      abi: hookAbi,
      eventName: 'ConfidentialReason',
      args: { jobId },
      fromBlock,
    });
    const log = logs.at(-1);
    if (!log) return null;
    // The event's `evaluator` field is whoever acted (the client, for a reject of an open job).
    const plain = await this.openFrom(jobId, log.args.evaluator!, log.args.envelope!);
    return plain ? { plain, approved: log.args.action === COMPLETE } : null;
  }

  async readReview(jobId: bigint, fromBlock: bigint): Promise<{ review: unknown; approved: boolean } | null> {
    const r = await this.readReviewRaw(jobId, fromBlock);
    return r ? { review: (r.plain as { review: unknown }).review, approved: r.approved } : null;
  }

  // ------------------------------------------------------------------ crypto

  private async sealFor(jobId: bigint, parties: Address[], payload: unknown): Promise<Hex> {
    const recipients = await Promise.all([...new Set(parties)].map((p) => this.c.identity.keyOf(p)));
    const bytes = seal(enc.encode(JSON.stringify(payload)), recipients, {
      chainId: await this.getChainId(),
      contract: this.c.hook,
      channelId: jobId,
      author: this.address,
    });
    return bytesToHex(bytes);
  }

  private async ctx(jobId: bigint, author: Address) {
    return { chainId: await this.getChainId(), contract: this.c.hook, channelId: jobId, author };
  }

  private async openFrom(jobId: bigint, author: Address, envelope: Hex): Promise<unknown | null> {
    const plain = open(hexToBytes(envelope), this.c.identity.keyPair, await this.ctx(jobId, author));
    if (!plain) return null;
    try {
      return JSON.parse(dec.decode(plain));
    } catch {
      return null;
    }
  }
}

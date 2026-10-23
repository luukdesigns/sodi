import { type A2AClient, open, seal } from '@sodi/a2a';
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

  /** Completes the job. A non-empty `review` is encrypted to client, provider and evaluator. */
  async complete(jobId: bigint, review?: unknown) {
    return this.decide('complete', jobId, review);
  }

  async reject(jobId: bigint, review?: unknown) {
    return this.decide('reject', jobId, review);
  }

  private async decide(action: 'complete' | 'reject', jobId: bigint, review?: unknown) {
    if (review === undefined) {
      return (await this.write(this.c.commerce, agenticCommerceAbi, action, [jobId, `0x${'0'.repeat(64)}`, '0x']))
        .transactionHash;
    }
    const job = await this.getJob(jobId);
    const envelope = await this.sealFor(jobId, [job.client, job.provider, this.address], { kind: action, review });
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

  /** Decrypts the deliverable if this party can; returns null if it is not a recipient. */
  async readDeliverable(jobId: bigint, fromBlock: bigint): Promise<{ work: unknown; deliverable: Hex } | null> {
    const logs = await this.c.publicClient.getContractEvents({
      address: this.c.hook,
      abi: hookAbi,
      eventName: 'ConfidentialDeliverable',
      args: { jobId },
      fromBlock,
    });
    const log = logs.at(-1);
    if (!log) return null;
    const plain = await this.openFrom(jobId, log.args.provider!, log.args.envelope!);
    return plain ? { work: (plain as { work: unknown }).work, deliverable: log.args.deliverable! } : null;
  }

  async readReview(jobId: bigint, fromBlock: bigint): Promise<{ review: unknown; approved: boolean } | null> {
    const logs = await this.c.publicClient.getContractEvents({
      address: this.c.hook,
      abi: hookAbi,
      eventName: 'ConfidentialReason',
      args: { jobId },
      fromBlock,
    });
    const log = logs.at(-1);
    if (!log) return null;
    const plain = await this.openFrom(jobId, log.args.evaluator!, log.args.envelope!);
    return plain ? { review: (plain as { review: unknown }).review, approved: log.args.action === COMPLETE } : null;
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

  private async openFrom(jobId: bigint, author: Address, envelope: Hex): Promise<unknown | null> {
    const keys = this.c.identity.keyPair;
    const plain = open(hexToBytes(envelope), keys, {
      chainId: await this.getChainId(),
      contract: this.c.hook,
      channelId: jobId,
      author,
    });
    return plain ? JSON.parse(dec.decode(plain)) : null;
  }
}

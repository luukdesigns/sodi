import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  parseEventLogs,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { depositedEvent, entrypointAbi, erc20Abi, latestAspRoot, poolAbi, stateTreeLeaves } from './chain.js';
import {
  type MasterKeys,
  commitmentHash,
  depositSecrets,
  generateMasterKeys,
  merkleProof,
  precommitmentHash,
  withdrawalContext,
  withdrawalSecrets,
} from './crypto.js';
import type { WithdrawalProver } from './prover.js';
import type { Relayer } from './relayer.js';
import type { PoolNote, Session, Store, WalletState } from './store.js';
import { paymentHeader, parsePaymentRequired, selectRequirement, signAuthorization } from './x402.js';

export interface SessionPolicy {
  /** Amount withdrawn into each new session (asset base units). */
  budget: bigint;
  /** Rotate to a new address after this many payments. */
  maxPayments: number;
  /** Rotate after this many seconds. */
  maxAgeSeconds: number;
  /** Refuse any single payment above this amount. */
  maxPaymentAmount: bigint;
}

export interface Rx402Config {
  publicClient: PublicClient;
  /** Owner wallet, used only for public deposits into the pool. */
  ownerWallet?: WalletClient;
  /** Mnemonic the pool secrets are derived from. Keep it as safe as a wallet seed. */
  mnemonic: string;
  entrypoint: Address;
  pool: Address;
  asset: Address;
  /** Block the pool was deployed at, where state-tree scanning starts. */
  poolDeploymentBlock: bigint;
  relayer: Relayer;
  prover: WithdrawalProver;
  /** Approved labels of the current association set, e.g. from the Sodi approval service. */
  associationSet: () => Promise<bigint[]>;
  store: Store;
  policy: SessionPolicy;
  now?: () => number;
}

export interface PaidResponse {
  response: Response;
  /** Set when this request was paid for. */
  payment?: { amount: bigint; payTo: Address; from: Address };
}

/**
 * rx402: private x402 payments.
 *
 * The owner deposits into a Privacy Pool once. Each *session* is a zero-knowledge withdrawal of a
 * small budget, relayed to a brand-new address that pays x402 merchants with EIP-3009 signatures.
 * Merchants see an ordinary payment from an address with no history; nothing links it to the owner
 * or to the agent's other sessions.
 */
export class Rx402Client {
  private readonly keys: MasterKeys;
  private scope?: bigint;
  private chainId?: number;

  constructor(private readonly config: Rx402Config) {
    this.keys = generateMasterKeys(config.mnemonic);
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async getScope(): Promise<bigint> {
    this.scope ??= await this.config.publicClient.readContract({
      address: this.config.pool,
      abi: poolAbi,
      functionName: 'SCOPE',
    });
    return this.scope;
  }

  private async getChainId(): Promise<number> {
    this.chainId ??= await this.config.publicClient.getChainId();
    return this.chainId;
  }

  // ---------------------------------------------------------------- deposits

  /** Deposits `amount` of the asset from the owner wallet. This step is public. */
  async deposit(amount: bigint): Promise<PoolNote> {
    const { ownerWallet, publicClient, entrypoint, asset, store } = this.config;
    if (!ownerWallet?.account) throw new Error('ownerWallet is required to deposit');
    const scope = await this.getScope();
    const state = store.load();
    const index = state.depositCounts[scope.toString()] ?? 0;
    const secrets = depositSecrets(this.keys, scope, BigInt(index));

    const allowance = await publicClient.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerWallet.account.address, entrypoint],
    });
    if (allowance < amount) {
      const approveTx = await ownerWallet.writeContract({
        address: asset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [entrypoint, amount],
        account: ownerWallet.account,
        chain: ownerWallet.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const depositTx = await ownerWallet.writeContract({
      address: entrypoint,
      abi: entrypointAbi,
      functionName: 'deposit',
      args: [asset, amount, precommitmentHash(secrets)],
      account: ownerWallet.account,
      chain: ownerWallet.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    if (receipt.status !== 'success') throw new Error(`deposit reverted: ${depositTx}`);

    const [event] = parseEventLogs({ abi: [depositedEvent], logs: receipt.logs }).filter(
      (l) => l.address.toLowerCase() === this.config.pool.toLowerCase(),
    );
    if (!event) throw new Error('Deposited event not found');
    const { _label: label, _value: value, _commitment: commitment } = event.args;
    if (commitmentHash(value, label, secrets) !== commitment) {
      throw new Error('on-chain commitment does not match locally derived secrets');
    }

    const note: PoolNote = {
      scope: scope.toString(),
      depositIndex: index,
      label: label.toString(),
      value: value.toString(),
      spendCount: 0,
      depositTx,
    };
    state.depositCounts[scope.toString()] = index + 1;
    state.notes.push(note);
    store.save(state);
    return note;
  }

  /** Total value still in the pool across all notes. */
  poolBalance(): bigint {
    return this.config.store.load().notes.reduce((sum, n) => sum + BigInt(n.value), 0n);
  }

  /** The session the next payment would use, with what it has left. */
  currentSession(): (Session & { remaining: bigint; ageSeconds: number }) | undefined {
    const s = this.config.store.load().sessions.at(-1);
    if (!s) return undefined;
    return { ...s, remaining: BigInt(s.budget) - BigInt(s.spent), ageSeconds: this.now() - s.openedAt };
  }

  get policy(): Readonly<SessionPolicy> {
    return this.config.policy;
  }

  get canDeposit(): boolean {
    return Boolean(this.config.ownerWallet?.account);
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Withdraws `budget` from the pool to a fresh address via the relayer, with a zero-knowledge proof.
   * The withdrawal reveals the amount and the new address, but not which deposit it came from.
   */
  async openSession(budget: bigint = this.config.policy.budget): Promise<Session> {
    const { publicClient, entrypoint, pool, relayer, prover, store } = this.config;
    const state = store.load();
    const note = state.notes.find((n) => BigInt(n.value) >= budget);
    if (!note) throw new Error(`no pool deposit with at least ${budget} available; deposit more`);

    const scope = await this.getScope();
    const label = BigInt(note.label);
    const existingValue = BigInt(note.value);
    const existing =
      note.spendCount === 0
        ? depositSecrets(this.keys, scope, BigInt(note.depositIndex))
        : withdrawalSecrets(this.keys, label, BigInt(note.spendCount - 1));
    const next = withdrawalSecrets(this.keys, label, BigInt(note.spendCount));

    // Inclusion proofs: the note is in the pool's state tree, and its label is approved.
    const leaves = await stateTreeLeaves(publicClient, pool, this.config.poolDeploymentBlock);
    const stateProof = merkleProof(leaves, commitmentHash(existingValue, label, existing));
    const approved = await this.config.associationSet();
    const aspProof = merkleProof(approved, label);
    const onChainAsp = await latestAspRoot(publicClient, entrypoint);
    if (aspProof.root !== onChainAsp) {
      throw new Error('association set does not match the on-chain root; is the approval service in sync?');
    }

    const sessionKey = generatePrivateKey();
    const sessionAddress = privateKeyToAccount(sessionKey).address;
    const withdrawal = {
      processooor: entrypoint,
      data: encodeAbiParameters(
        [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }],
        [[sessionAddress, relayer.feeRecipient, relayer.relayFeeBPS]],
      ),
    };

    const { proof } = await prover.prove({
      withdrawnValue: budget,
      stateProof,
      aspProof,
      context: withdrawalContext(withdrawal, scope),
      label,
      existingValue,
      existing,
      next,
    });
    const fundingTx = await relayer.relay(withdrawal, proof, scope);

    const received = budget - (budget * relayer.relayFeeBPS) / 10_000n;
    note.value = (existingValue - budget).toString();
    note.spendCount += 1;
    const session: Session = {
      address: sessionAddress,
      privateKey: sessionKey,
      budget: received.toString(),
      spent: '0',
      payments: 0,
      openedAt: this.now(),
      fundingTx,
    };
    state.sessions.push(session);
    store.save(state);
    return session;
  }

  /** The current session if it can still pay `amount` under the rotation policy. */
  private usableSession(state: WalletState, amount: bigint): Session | undefined {
    const s = state.sessions.at(-1);
    if (!s) return undefined;
    const { maxPayments, maxAgeSeconds } = this.config.policy;
    const remaining = BigInt(s.budget) - BigInt(s.spent);
    if (remaining < amount || s.payments >= maxPayments || this.now() - s.openedAt >= maxAgeSeconds) {
      return undefined;
    }
    return s;
  }

  // ---------------------------------------------------------------- x402

  /**
   * `fetch` that pays x402 `402 Payment Required` responses from a private session, opening or
   * rotating sessions as needed.
   */
  async fetch(
    input: string | URL,
    init: RequestInit = {},
    options: { maxPaymentAmount?: bigint } = {},
  ): Promise<PaidResponse> {
    const first = await fetch(input, init);
    if (first.status !== 402) return { response: first };

    const required = await parsePaymentRequired(first);
    const chainId = await this.getChainId();
    // A per-call cap can only tighten the policy, never loosen it.
    const policyCap = this.config.policy.maxPaymentAmount;
    const cap =
      options.maxPaymentAmount !== undefined && options.maxPaymentAmount < policyCap ? options.maxPaymentAmount : policyCap;
    const requirement = selectRequirement(required, chainId, this.config.asset, cap);

    let state = this.config.store.load();
    let session = this.usableSession(state, requirement.amount);
    if (!session) {
      const budget = this.config.policy.budget > requirement.amount ? this.config.policy.budget : requirement.amount;
      await this.openSession(budget);
      state = this.config.store.load();
      session = state.sessions.at(-1)!;
    }

    const account = privateKeyToAccount(session.privateKey);
    const signed = await signAuthorization(account, requirement, chainId, this.now());
    const [name, value] = paymentHeader(required.version, requirement, signed);
    const headers = new Headers(init.headers);
    headers.set(name, value);
    const response = await fetch(input, { ...init, headers });

    if (response.ok) {
      const s = state.sessions.find((x) => x.address === session!.address)!;
      s.spent = (BigInt(s.spent) + requirement.amount).toString();
      s.payments += 1;
      this.config.store.save(state);
      return { response, payment: { amount: requirement.amount, payTo: requirement.payTo, from: account.address } };
    }
    return { response };
  }
}

export type { Hex };

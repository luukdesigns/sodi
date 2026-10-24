import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  bytesToHex,
  hexToBytes,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  zeroHash,
} from 'viem';

const postedEvent = parseAbiItem('event Posted(uint256 indexed channelId, address indexed author, bytes envelope)');

import { sodiA2AAbi } from './abi.js';
import { type KeyPair, isValidRecipientKey, keyDerivationMessage, keyPairFromSignature, open, seal } from './crypto.js';

export interface Message<T = unknown> {
  /** Transaction hash and log index. */
  id: string;
  channelId: bigint;
  /** On-chain author: the sender, or the signer of a relayed post. */
  from: Address;
  type: string;
  body: T;
  /** Optional id of the message this replies to. */
  ref?: string;
  sentAt: number;
  blockNumber: bigint;
}

export interface SendOptions<T> {
  to: Address[];
  type: string;
  body: T;
  channelId?: bigint;
  ref?: string;
}

/**
 * Submits signed posts and key registrations for agents that hold no gas. The signature fixes the
 * author, envelope and nonce, so the relayer can only submit or drop them, never alter them.
 */
export interface PostRelayer {
  postFor(args: { author: Address; channelId: bigint; envelope: Hex; deadline: bigint; signature: Hex }): Promise<Hex>;
  setKeyFor(args: { agent: Address; key: Hex; deadline: bigint; signature: Hex }): Promise<Hex>;
}

export class WalletPostRelayer implements PostRelayer {
  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly contract: Address,
  ) {}

  private async send(functionName: 'postFor' | 'setKeyFor', args: readonly unknown[]): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contract,
      abi: sodiA2AAbi,
      functionName,
      args: args as never,
      account: this.wallet.account!,
      chain: this.wallet.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  postFor(a: { author: Address; channelId: bigint; envelope: Hex; deadline: bigint; signature: Hex }) {
    return this.send('postFor', [a.author, a.channelId, a.envelope, a.deadline, a.signature]);
  }

  setKeyFor(a: { agent: Address; key: Hex; deadline: bigint; signature: Hex }) {
    return this.send('setKeyFor', [a.agent, a.key, a.deadline, a.signature]);
  }
}

export interface A2AConfig {
  publicClient: PublicClient;
  /** The agent's wallet. Only needs gas if no relayer is given. */
  wallet: WalletClient;
  contract: Address;
  relayer?: PostRelayer;
  /** Seconds a relayed signature stays valid. */
  signatureTtl?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One agent's view of Sodi A2A: its keys, sending, and reading its inbox. */
export class A2AClient {
  private keys?: KeyPair;
  private chainId?: number;

  constructor(private readonly config: A2AConfig) {}

  get address(): Address {
    return this.config.wallet.account!.address;
  }

  get publicKey(): Hex {
    return this.keyPair.publicKey;
  }

  /** The derived messaging key pair, for decrypting envelopes in other contexts (e.g. ERC-8183 jobs). */
  get keyPair(): KeyPair {
    if (!this.keys) throw new Error('call init() first');
    return this.keys;
  }

  /**
   * Derives the messaging key from a wallet signature. Signs twice and checks the results match:
   * wallets with non-deterministic signatures would otherwise lose their key on the next run.
   */
  async init(): Promise<Hex> {
    const account = this.config.wallet.account!;
    const message = keyDerivationMessage(account.address);
    const sign = () => this.config.wallet.signMessage({ account, message });
    const [a, b] = await Promise.all([sign(), sign()]);
    if (a !== b) throw new Error('this wallet produces non-deterministic signatures; it cannot derive a stable key');
    this.keys = keyPairFromSignature(a);
    this.chainId = await this.config.publicClient.getChainId();
    return this.keys.publicKey;
  }

  /** Publishes the public key on-chain if it is not there already. */
  async register(): Promise<Hex | null> {
    const key = this.publicKey;
    const current = await this.keyOf(this.address).catch(() => null);
    if (current?.toLowerCase() === key.toLowerCase()) return null;

    const { relayer, wallet, contract, publicClient } = this.config;
    if (!relayer) {
      const hash = await wallet.writeContract({
        address: contract,
        abi: sodiA2AAbi,
        functionName: 'setKey',
        args: [key],
        account: wallet.account!,
        chain: wallet.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    }
    const deadline = await this.deadline();
    const signature = await wallet.signTypedData({
      account: wallet.account!,
      domain: await this.domain(),
      types: {
        SetKey: [
          { name: 'agent', type: 'address' },
          { name: 'encryptionKey', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'SetKey',
      message: { agent: this.address, encryptionKey: key, nonce: await this.nonce(), deadline },
    });
    return relayer.setKeyFor({ agent: this.address, key, deadline, signature });
  }

  async keyOf(agent: Address): Promise<Hex> {
    const key = await this.config.publicClient.readContract({
      address: this.config.contract,
      abi: sodiA2AAbi,
      functionName: 'encryptionKey',
      args: [agent],
    });
    if (key === zeroHash) throw new Error(`${agent} has not registered a messaging key`);
    return key;
  }

  async createChannel(restricted: boolean, writers: Address[]): Promise<bigint> {
    const { wallet, contract, publicClient } = this.config;
    const hash = await wallet.writeContract({
      address: contract,
      abi: sodiA2AAbi,
      functionName: 'createChannel',
      args: [restricted, writers],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: sodiA2AAbi, eventName: 'ChannelCreated', logs: receipt.logs });
    if (!created) throw new Error('ChannelCreated not found');
    return created.args.channelId;
  }

  /**
   * Encrypts a message to `to` (and to yourself, so you can read your sent messages) and posts it.
   * Returns the transaction hash.
   */
  async send<T>({ to, type, body, channelId = 0n, ref }: SendOptions<T>): Promise<Hex> {
    const addresses = [...new Set([...to, this.address])];
    const recipients = await Promise.all(addresses.map((a) => this.keyOf(a)));
    const invalid = addresses.filter((_, i) => !isValidRecipientKey(recipients[i]!));
    if (invalid.length) throw new Error(`these agents registered keys that can't be encrypted to: ${invalid.join(', ')}; leave them out`);
    const plaintext = enc.encode(JSON.stringify({ v: 1, type, body, ref, t: Math.floor(Date.now() / 1000) }));
    const envelope = bytesToHex(
      seal(plaintext, recipients, {
        chainId: this.chainId!,
        contract: this.config.contract,
        channelId,
        author: this.address,
      }),
    );
    return this.post(channelId, envelope);
  }

  private async post(channelId: bigint, envelope: Hex): Promise<Hex> {
    const { relayer, wallet, contract, publicClient } = this.config;
    if (!relayer) {
      const hash = await wallet.writeContract({
        address: contract,
        abi: sodiA2AAbi,
        functionName: 'post',
        args: [channelId, envelope],
        account: wallet.account!,
        chain: wallet.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`post reverted: ${hash}`);
      return hash;
    }
    const deadline = await this.deadline();
    const signature = await wallet.signTypedData({
      account: wallet.account!,
      domain: await this.domain(),
      types: {
        Post: [
          { name: 'author', type: 'address' },
          { name: 'channelId', type: 'uint256' },
          { name: 'envelopeHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Post',
      message: { author: this.address, channelId, envelopeHash: keccak256(envelope), nonce: await this.nonce(), deadline },
    });
    return relayer.postFor({ author: this.address, channelId, envelope, deadline, signature });
  }

  /** Every message on the given channels (all channels by default) that this agent can decrypt. */
  async inbox(opts: { fromBlock: bigint; toBlock?: bigint; channelIds?: bigint[] }): Promise<Message[]> {
    const logs = await this.config.publicClient.getLogs({
      address: this.config.contract,
      event: postedEvent,
      args: opts.channelIds ? { channelId: opts.channelIds } : {},
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock ?? 'latest',
    });
    const out: Message[] = [];
    for (const log of logs) {
      const plain = open(hexToBytes(log.args.envelope!), this.keys!, {
        chainId: this.chainId!,
        contract: this.config.contract,
        channelId: log.args.channelId!,
        author: log.args.author!,
      });
      if (!plain) continue;
      try {
        const m = JSON.parse(dec.decode(plain));
        out.push({
          id: `${log.transactionHash}:${log.logIndex}`,
          channelId: log.args.channelId!,
          from: log.args.author!,
          type: m.type,
          body: m.body,
          ref: m.ref,
          sentAt: m.t,
          blockNumber: log.blockNumber,
        });
      } catch {
        // decrypted but malformed: ignore
      }
    }
    return out;
  }

  private async nonce(): Promise<bigint> {
    return this.config.publicClient.readContract({
      address: this.config.contract,
      abi: sodiA2AAbi,
      functionName: 'nonces',
      args: [this.address],
    });
  }

  private async deadline(): Promise<bigint> {
    const block = await this.config.publicClient.getBlock();
    return block.timestamp + BigInt(this.config.signatureTtl ?? 600);
  }

  private async domain() {
    return { name: 'SodiA2A', version: '1', chainId: this.chainId!, verifyingContract: this.config.contract } as const;
  }
}

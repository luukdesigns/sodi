/**
 * Merchant side of stealth x402 payments.
 *
 *   StealthReceiver  viewing key only: offers stealth, verifies payments, settles them, scans for them.
 *                    This is all a merchant's server needs, and it can't move funds.
 *   StealthMerchant  adds the spending key: sweeps funds out of stealth addresses. Keep it offline.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  hexToBigInt,
  parseAbi,
  parseSignature,
  recoverTypedDataAddress,
  size,
  slice,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { StealthKeys, ViewingKeys } from './keys.js';
import { ERC5564_ANNOUNCER, announcerAbi } from './registry.js';
import { SCHEME_ID, checkStealthAddress, computeStealthKey, encodeMetaAddress } from './stealth.js';
import { type StealthProof, offerStealth } from './x402.js';

const TRANSFER_WITH_AUTHORIZATION: Hex = '0xe3ee160e';

const settlerAbi = parseAbi([
  'struct Payment { address token; address from; address stealthAddress; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; uint8 v; bytes32 r; bytes32 s; }',
  'function settle(Payment p, bytes ephemeralPubKey, bytes1 viewTag)',
]);
const eip3009Abi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function balanceOf(address) view returns (uint256)',
]);

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** EIP-712 domain of the payment token, e.g. { name: 'Global Dollar', version: '1' } for USDG. */
export interface TokenDomain {
  name: string;
  version: string;
}

/** The decoded payment header (x402 v1 `X-PAYMENT` or v2 `PAYMENT-SIGNATURE`). */
export interface X402Payment {
  x402Version: number;
  accepted?: Record<string, unknown>;
  payload: {
    signature: Hex;
    authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
    stealth?: StealthProof;
  };
}

export function decodePaymentHeader(header: string): X402Payment {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

export interface VerifiedStealthPayment {
  token: Address;
  from: Address;
  stealthAddress: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

export interface FoundPayment {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  token?: Address;
  amount?: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

export class StealthReceiver {
  constructor(protected readonly keys: ViewingKeys) {}

  get metaAddress(): string {
    return encodeMetaAddress(this.keys);
  }

  /** Adds this merchant's stealth offer to an x402 payment requirement. */
  offer<T extends { extra?: Record<string, unknown> }>(requirement: T): T {
    return offerStealth(requirement, this.metaAddress);
  }

  /** Is this one-time address ours? */
  owns(stealthAddress: Address, proof: StealthProof): boolean {
    return checkStealthAddress({
      stealthAddress,
      ephemeralPublicKey: proof.ephemeralPublicKey,
      viewTag: proof.viewTag,
      viewingPrivateKey: this.keys.viewingPrivateKey,
      spendingPublicKey: this.keys.spendingPublicKey,
    });
  }

  /**
   * Checks a stealth payment the way a facilitator checks an ordinary one, except that the recipient
   * must be one of our stealth addresses rather than `payTo`. Throws with the reason if it isn't valid.
   */
  async verify(
    payment: X402Payment,
    expected: { asset: Address; amount: bigint; chainId: number; domain: TokenDomain },
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<VerifiedStealthPayment> {
    const { signature, authorization: a, stealth } = payment.payload;
    if (!stealth) throw new Error('not a stealth payment');
    if (!this.owns(a.to, stealth)) throw new Error('recipient is not one of our stealth addresses');
    const value = BigInt(a.value);
    const validAfter = BigInt(a.validAfter);
    const validBefore = BigInt(a.validBefore);
    if (value < expected.amount) throw new Error(`underpaid: ${value} < ${expected.amount}`);
    if (validAfter >= BigInt(nowSeconds)) throw new Error('authorization not yet valid');
    if (validBefore <= BigInt(nowSeconds + 5)) throw new Error('authorization expires too soon');
    const signer = await recoverTypedDataAddress({
      domain: { ...expected.domain, chainId: expected.chainId, verifyingContract: expected.asset },
      types: authorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce },
      signature,
    });
    if (signer.toLowerCase() !== a.from.toLowerCase()) throw new Error('bad authorization signature');
    return {
      token: expected.asset,
      from: a.from,
      stealthAddress: a.to,
      value,
      validAfter,
      validBefore,
      nonce: a.nonce,
      signature,
      ephemeralPublicKey: stealth.ephemeralPublicKey,
      viewTag: stealth.viewTag,
    };
  }

  /**
   * Settles through the SodiStealthSettler: moves the funds and announces them in one transaction.
   * Whoever pays the gas is visible on-chain, so use a facilitator shared with other merchants;
   * settling every payment from the merchant's own wallet would link its stealth addresses.
   */
  async settle(wallet: WalletClient, publicClient: PublicClient, settler: Address, p: VerifiedStealthPayment): Promise<Hex> {
    const { v, r, s, yParity } = parseSignature(p.signature);
    const hash = await wallet.writeContract({
      address: settler,
      abi: settlerAbi,
      functionName: 'settle',
      args: [
        {
          token: p.token,
          from: p.from,
          stealthAddress: p.stealthAddress,
          value: p.value,
          validAfter: p.validAfter,
          validBefore: p.validBefore,
          nonce: p.nonce,
          v: Number(v ?? BigInt(yParity + 27)),
          r,
          s,
        },
        p.ephemeralPublicKey,
        p.viewTag,
      ],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`settlement reverted: ${hash}`);
    return hash;
  }

  /**
   * Finds our payments from ERC-5564 announcements alone, so nothing needs to be stored off-chain.
   * Pass `caller` (the settler) to look only at Sodi settlements.
   */
  async scan(
    publicClient: PublicClient,
    opts: { fromBlock: bigint; toBlock?: bigint; caller?: Address; announcer?: Address; chunkSize?: bigint },
  ): Promise<FoundPayment[]> {
    // cacheTime 0: viem otherwise reuses a block number up to a few seconds old and misses fresh payments.
    const to = opts.toBlock ?? (await publicClient.getBlockNumber({ cacheTime: 0 }));
    const step = opts.chunkSize ?? 25_000n;
    const found: FoundPayment[] = [];
    for (let from = opts.fromBlock; from <= to; from += step) {
      const end = from + step - 1n < to ? from + step - 1n : to;
      const logs = await publicClient.getLogs({
        address: opts.announcer ?? ERC5564_ANNOUNCER,
        event: announcerAbi[0],
        args: { schemeId: SCHEME_ID, ...(opts.caller ? { caller: opts.caller } : {}) },
        fromBlock: from,
        toBlock: end,
      });
      for (const log of logs) {
        const { stealthAddress, ephemeralPubKey, metadata } = log.args;
        if (!stealthAddress || !ephemeralPubKey || !metadata || size(metadata) < 1) continue;
        const viewTag = slice(metadata, 0, 1);
        if (!this.owns(stealthAddress, { ephemeralPublicKey: ephemeralPubKey, viewTag })) continue;
        const isTransfer = size(metadata) >= 57 && slice(metadata, 1, 5) === TRANSFER_WITH_AUTHORIZATION;
        found.push({
          stealthAddress,
          ephemeralPublicKey: ephemeralPubKey,
          token: isTransfer ? slice(metadata, 5, 25) : undefined,
          amount: isTransfer ? hexToBigInt(slice(metadata, 25, 57)) : undefined,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    }
    return found;
  }
}

export class StealthMerchant extends StealthReceiver {
  constructor(private readonly fullKeys: StealthKeys) {
    super(fullKeys);
  }

  /** The private key of one stealth address. */
  keyFor(ephemeralPublicKey: Hex): Hex {
    return computeStealthKey({
      ephemeralPublicKey,
      viewingPrivateKey: this.fullKeys.viewingPrivateKey,
      spendingPrivateKey: this.fullKeys.spendingPrivateKey,
    });
  }

  /**
   * Moves each payment's full balance to `to` with an EIP-3009 authorization signed by its stealth key,
   * so stealth addresses never need gas. `gasPayer` submits them.
   *
   * Privacy: sweeping many stealth addresses to one destination, or in one burst, links them back
   * together. Sweep to different destinations, at different times, or into a privacy pool.
   */
  async sweep(opts: {
    publicClient: PublicClient;
    gasPayer: WalletClient;
    payments: FoundPayment[];
    token: Address;
    domain: TokenDomain;
    to: Address;
    nowSeconds?: number;
  }): Promise<{ stealthAddress: Address; amount: bigint; txHash: Hex }[]> {
    const { publicClient, gasPayer, token, domain, to } = opts;
    const chainId = await publicClient.getChainId();
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    const swept = [];
    for (const p of opts.payments) {
      const account = privateKeyToAccount(this.keyFor(p.ephemeralPublicKey));
      if (account.address.toLowerCase() !== p.stealthAddress.toLowerCase()) throw new Error('stealth key mismatch');
      const balance = await publicClient.readContract({ address: token, abi: eip3009Abi, functionName: 'balanceOf', args: [account.address] });
      if (balance === 0n) continue;
      const message = {
        from: account.address,
        to,
        value: balance,
        validAfter: 0n,
        validBefore: BigInt(now + 600),
        nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex,
      };
      const signature = await account.signTypedData({
        domain: { ...domain, chainId, verifyingContract: token },
        types: authorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message,
      });
      const { v, r, s, yParity } = parseSignature(signature);
      const hash = await gasPayer.writeContract({
        address: token,
        abi: eip3009Abi,
        functionName: 'transferWithAuthorization',
        args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
        account: gasPayer.account!,
        chain: gasPayer.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`sweep reverted: ${hash}`);
      swept.push({ stealthAddress: account.address, amount: balance, txHash: hash });
    }
    return swept;
  }
}

import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseSignature,
  toHex,
} from 'viem';

import { entrypointAbi } from './chain.js';

export const recyclerAbi = parseAbi([
  'struct Authorization { address from; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; uint8 v; bytes32 r; bytes32 s; }',
  'function recycle(Authorization a, uint256 precommitment, uint256 fee, address feeRecipient) returns (uint256 commitment)',
  'function recycleNonce(uint256 precommitment, uint256 fee, address feeRecipient) pure returns (bytes32)',
  'function refundTo(uint256 label) view returns (address)',
  'function entrypoint() view returns (address)',
  'function asset() view returns (address)',
  'event Recycled(address indexed from, uint256 indexed commitment, uint256 deposited, uint256 fee, address feeRecipient)',
]);

const NONCE_TAG = keccak256(toHex('sodi-recycle-v1'));

/** The nonce `SodiRecycler` requires: it binds the authorization to one deposit and one fee. */
export function recycleNonce(precommitment: bigint, fee: bigint, feeRecipient: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], [NONCE_TAG, precommitment, fee, feeRecipient]),
  );
}

/** A signed recycle, ready for anyone to submit. Values are decimal strings, so it travels as JSON. */
export interface RecycleRequest {
  authorization: { from: Address; value: string; validAfter: string; validBefore: string; nonce: Hex; v: number; r: Hex; s: Hex };
  precommitment: string;
  fee: string;
  feeRecipient: Address;
}

export interface TokenDomain {
  name: string;
  version: string;
}

/** USDG's EIP-712 domain on Robinhood Chain. */
export const USDG_DOMAIN: TokenDomain = { name: 'Global Dollar', version: '1' };

/**
 * Signs an EIP-3009 `ReceiveWithAuthorization` moving `value` from `account` into the pool through the
 * recycler, as a deposit with `precommitment`. Nobody who submits it can change the deposit or the fee.
 */
export async function signRecycle(
  account: LocalAccount,
  opts: { chainId: number; asset: Address; domain: TokenDomain; recycler: Address; value: bigint; precommitment: bigint; fee: bigint; feeRecipient: Address; now: number },
): Promise<RecycleRequest> {
  const nonce = recycleNonce(opts.precommitment, opts.fee, opts.feeRecipient);
  const message = { from: account.address, to: opts.recycler, value: opts.value, validAfter: 0n, validBefore: BigInt(opts.now + 300), nonce };
  const signature = await account.signTypedData({
    domain: { ...opts.domain, chainId: opts.chainId, verifyingContract: opts.asset },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message,
  });
  const { v, r, s, yParity } = parseSignature(signature);
  return {
    authorization: {
      from: account.address,
      value: opts.value.toString(),
      validAfter: '0',
      validBefore: message.validBefore.toString(),
      nonce,
      v: Number(v ?? BigInt(yParity + 27)),
      r,
      s,
    },
    precommitment: opts.precommitment.toString(),
    fee: opts.fee.toString(),
    feeRecipient: opts.feeRecipient,
  };
}

export function recycleArgs(req: RecycleRequest) {
  const a = req.authorization;
  return [
    { from: a.from, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce, v: a.v, r: a.r, s: a.s },
    BigInt(req.precommitment),
    BigInt(req.fee),
    req.feeRecipient,
  ] as const;
}

/**
 * Submits recycles. Whoever submits pays the gas and is visible on-chain, so use one that many people
 * share (a Sodi relayer, `HttpRelayer`), not the owner's own wallet.
 */
export interface RecycleSubmitter {
  /** The SodiRecycler contract. */
  recycler: Address;
  /** Taken out of the recycled amount for the submitter. */
  recycleFee: bigint;
  feeRecipient: Address;
  recycle(req: RecycleRequest): Promise<Hex>;
}

/** Submits from a wallet you run. Fine on a fork or for testing; on a real chain the wallet links every recycle it submits. */
export class WalletRecycleSubmitter implements RecycleSubmitter {
  readonly recycleFee = 0n;
  readonly feeRecipient: Address;

  constructor(
    private readonly wallet: WalletClient,
    private readonly publicClient: PublicClient,
    readonly recycler: Address,
  ) {
    this.feeRecipient = wallet.account!.address;
  }

  async recycle(req: RecycleRequest): Promise<Hex> {
    const call = { address: this.recycler, abi: recyclerAbi, functionName: 'recycle', args: recycleArgs(req), account: this.wallet.account! } as const;
    // Estimates for calls into ERC-4626 vaults (Morpho) can come in too tight; leave headroom.
    const gas = ((await this.publicClient.estimateContractGas(call)) * 13n) / 10n;
    const hash = await this.wallet.writeContract({ ...call, gas, chain: this.wallet.chain });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`recycle reverted: ${hash} (gas used ${receipt.gasUsed} of ${gas})`);
    return hash;
  }
}

/**
 * Signs and submits a recycle of `value` from `account` into a deposit with `precommitment`, and waits
 * for it. Returns the transaction.
 */
export async function recycleFrom(
  account: LocalAccount,
  opts: { publicClient: PublicClient; asset: Address; domain: TokenDomain; submitter: RecycleSubmitter; value: bigint; precommitment: bigint; now: number },
): Promise<Hex> {
  const { publicClient, submitter } = opts;
  const req = await signRecycle(account, {
    chainId: await publicClient.getChainId(),
    asset: opts.asset,
    domain: opts.domain,
    recycler: submitter.recycler,
    value: opts.value,
    precommitment: opts.precommitment,
    fee: submitter.recycleFee,
    feeRecipient: submitter.feeRecipient,
    now: opts.now,
  });
  const hash = await submitter.recycle(req);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`recycle reverted: ${hash}`);
  return hash;
}

/** The pool's minimum deposit for the recycler's asset, read from the chain. Smaller amounts can't be recycled. */
export async function recycleMinimum(publicClient: PublicClient, recycler: Address): Promise<bigint> {
  const [entrypoint, asset] = await Promise.all([
    publicClient.readContract({ address: recycler, abi: recyclerAbi, functionName: 'entrypoint' }),
    publicClient.readContract({ address: recycler, abi: recyclerAbi, functionName: 'asset' }),
  ]);
  const [, minimum] = await publicClient.readContract({ address: entrypoint, abi: entrypointAbi, functionName: 'assetConfig', args: [asset] });
  return minimum;
}

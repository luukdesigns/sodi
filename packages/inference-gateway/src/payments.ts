/**
 * x402 on the gateway side: the 402 we answer with, checking a payment before we spend anything
 * upstream, and settling it once the upstream has accepted the request.
 *
 * By default the 402 offers a stealth address (the x402 stealth extension), so each payment lands at
 * a fresh one-time address only the operator can find and spend, and gateway revenue can't be
 * totalled from the chain. Clients that don't know the extension pay `payTo` as usual.
 */
import { type StealthReceiver, type TokenDomain, type X402Payment, decodePaymentHeader } from '@sodi/stealth';
import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi, parseSignature, recoverTypedDataAddress } from 'viem';

const tokenAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function balanceOf(address) view returns (uint256)',
]);
const transferTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export class PaymentError extends Error {}

export interface PaymentConfig {
  chainId: number;
  asset: Address;
  /** EIP-712 domain of the asset; USDG's by default. */
  domain?: TokenDomain;
  /** Paid by clients that don't take the stealth offer. */
  payTo: Address;
  /** Viewing keys and settler: set to offer stealth addresses (the default in `fromEnv`). */
  stealth?: StealthReceiver;
  publicClient: PublicClient;
  /** Pays the gas to settle. Use a facilitator shared with other merchants: its address is on every settlement. */
  facilitator: WalletClient;
  maxTimeoutSeconds?: number;
  now?: () => number;
}

export interface VerifiedPayment {
  /** The paying address: an rx402 session, never the agent's owner. */
  from: Address;
  value: bigint;
  stealth: boolean;
  /** Moves the funds; resolves with the transaction once it's mined successfully. */
  settle(): Promise<Hex>;
  /** Frees the payment's hold when we refuse the request without settling it. */
  release(): void;
}

export class PaymentGate {
  private readonly domain: TokenDomain;
  /** Authorization nonces in flight or settled, until they expire. */
  private readonly seen = new Map<string, number>();
  /** Value of unsettled payments per payer, so one balance can't back two requests at once. */
  private readonly held = new Map<string, bigint>();

  constructor(private readonly config: PaymentConfig) {
    this.domain = config.domain ?? { name: 'Global Dollar', version: '1' };
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** The 402 body for a request priced at `amount`. */
  paymentRequired(amount: bigint, resource: string, description: string) {
    const base = {
      scheme: 'exact',
      network: `eip155:${this.config.chainId}`,
      asset: this.config.asset,
      payTo: this.config.payTo,
      amount: amount.toString(),
      maxTimeoutSeconds: this.config.maxTimeoutSeconds ?? 300,
      resource,
      description,
      mimeType: 'application/json',
      extra: { ...this.domain } as Record<string, unknown>,
    };
    const requirement = this.config.stealth ? this.config.stealth.offer(base) : base;
    return { x402Version: 2, error: 'payment required', accepts: [requirement] };
  }

  /** Checks a payment header against the price. Throws PaymentError with a reason the client may see. */
  async verify(header: string, amount: bigint): Promise<VerifiedPayment> {
    let payment: X402Payment;
    try {
      payment = decodePaymentHeader(header);
    } catch {
      throw new PaymentError('unreadable payment header');
    }
    const a = payment.payload?.authorization;
    if (!a?.from || !a.nonce) throw new PaymentError('payment has no authorization');
    const stealth = Boolean(payment.payload.stealth);
    const expected = { asset: this.config.asset, amount, chainId: this.config.chainId, domain: this.domain };
    let verified: Awaited<ReturnType<StealthReceiver['verify']>> | undefined;
    if (stealth) {
      if (!this.config.stealth) throw new PaymentError('stealth payments are not offered here');
      try {
        verified = await this.config.stealth.verify(payment, expected, this.now());
      } catch (err) {
        throw new PaymentError((err as Error).message);
      }
    } else {
      await this.verifyPlain(payment, amount);
    }

    const key = a.nonce.toLowerCase();
    this.prune();
    if (this.seen.has(key)) throw new PaymentError('this authorization was already used');
    const value = BigInt(a.value);
    const from = a.from.toLowerCase();
    const balance = await this.config.publicClient.readContract({ address: this.config.asset, abi: tokenAbi, functionName: 'balanceOf', args: [a.from] });
    const held = this.held.get(from) ?? 0n;
    if (balance < held + value) throw new PaymentError('the paying address does not hold enough to cover this payment');
    if (this.seen.has(key)) throw new PaymentError('this authorization was already used'); // re-check after the await
    this.seen.set(key, Number(a.validBefore));
    this.held.set(from, held + value);

    let done = false;
    const unhold = () => {
      if (done) return;
      done = true;
      const h = (this.held.get(from) ?? 0n) - value;
      if (h > 0n) this.held.set(from, h);
      else this.held.delete(from);
    };
    return {
      from: a.from,
      value,
      stealth,
      settle: async () => {
        try {
          return verified ? await this.config.stealth!.settle(this.config.facilitator, this.config.publicClient, verified) : await this.settlePlain(payment);
        } finally {
          unhold();
        }
      },
      release: () => {
        unhold();
        // Not settled: the authorization stays unspent, so let the client present it again.
        this.seen.delete(key);
      },
    };
  }

  private async verifyPlain(payment: X402Payment, amount: bigint) {
    const { signature, authorization: a } = payment.payload;
    if (a.to.toLowerCase() !== this.config.payTo.toLowerCase()) throw new PaymentError('payment is not to our payTo');
    const value = BigInt(a.value);
    if (value < amount) throw new PaymentError(`underpaid: ${value} < ${amount}`);
    const now = BigInt(this.now());
    if (BigInt(a.validAfter) >= now) throw new PaymentError('authorization not yet valid');
    if (BigInt(a.validBefore) <= now + 5n) throw new PaymentError('authorization expires too soon');
    const signer = await recoverTypedDataAddress({
      domain: { ...this.domain, chainId: this.config.chainId, verifyingContract: this.config.asset },
      types: transferTypes,
      primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature,
    }).catch(() => undefined);
    if (signer?.toLowerCase() !== a.from.toLowerCase()) throw new PaymentError('bad authorization signature');
  }

  private async settlePlain(payment: X402Payment): Promise<Hex> {
    const { signature, authorization: a } = payment.payload;
    const { v, r, s, yParity } = parseSignature(signature);
    const wallet = this.config.facilitator;
    const hash = await wallet.writeContract({
      address: this.config.asset,
      abi: tokenAbi,
      functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await this.config.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`settlement reverted: ${hash}`);
    return hash;
  }

  private prune() {
    const now = this.now();
    for (const [k, until] of this.seen) if (until < now) this.seen.delete(k);
  }
}

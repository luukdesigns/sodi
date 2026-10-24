import { type KeyPair, canonicalSignature, keyPairFromSignature } from '@sodi/a2a';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { type Address, type Hex, type WalletClient, bytesToHex, getAddress, hexToBytes, keccak256, toBytes } from 'viem';

/**
 * Memory keys are separate from messaging keys: an agent signs a different message, so a leak of
 * one does not expose the other. Keys come in numbered epochs; rotating moves to the next one.
 */
export function memoryKeyMessage(address: Address, epoch: number): string {
  return [
    'Sodi Memory encryption key',
    '',
    'Signing this unlocks your agent memory. It does not authorize any transaction or payment.',
    '',
    `Address: ${getAddress(address)}`,
    `Epoch: ${epoch}`,
  ].join('\n');
}

/** Salt for hiding namespace names; fixed across key epochs so slots keep their ids. */
export function namespaceSaltMessage(address: Address): string {
  return [
    'Sodi Memory namespaces',
    '',
    'Signing this lets you find your memory slots. It does not authorize any transaction or payment.',
    '',
    `Address: ${getAddress(address)}`,
  ].join('\n');
}

async function signDeterministic(wallet: WalletClient, message: string): Promise<Hex> {
  const account = wallet.account!;
  const [a, b] = await Promise.all([wallet.signMessage({ account, message }), wallet.signMessage({ account, message })]);
  if (a !== b) throw new Error('this wallet produces non-deterministic signatures; it cannot derive a stable key');
  return a;
}

export async function deriveMemoryKey(wallet: WalletClient, epoch: number): Promise<KeyPair> {
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('epoch must be a positive integer');
  return keyPairFromSignature(await signDeterministic(wallet, memoryKeyMessage(wallet.account!.address, epoch)));
}

export async function deriveNamespaceSalt(wallet: WalletClient): Promise<Uint8Array> {
  const sig = await signDeterministic(wallet, namespaceSaltMessage(wallet.account!.address));
  return hkdf(sha256, hexToBytes(canonicalSignature(sig)), toBytes('sodi-memory-v1'), toBytes('namespace salt'), 32);
}

/**
 * Private slot id: outsiders cannot tell which slot is "portfolio" or "api-credentials", even by
 * guessing names. Use `publicNamespace` for slots you deliberately share by name.
 */
export function privateNamespace(salt: Uint8Array, name: string): Hex {
  const n = toBytes(name);
  const buf = new Uint8Array(salt.length + n.length);
  buf.set(salt);
  buf.set(n, salt.length);
  return keccak256(buf);
}

export function publicNamespace(name: string): Hex {
  return keccak256(toBytes(`sodi-memory-public:${name}`));
}

export { bytesToHex };

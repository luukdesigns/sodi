/**
 * ERC-6538 registry: where an address publishes its stealth meta-address, so payers can look it up.
 * Canonical deployments (same address on every chain), both live on Robinhood Chain testnet.
 */
import { type Address, type Hex, type PublicClient, type WalletClient, parseAbi } from 'viem';

import { SCHEME_ID, encodeMetaAddress, metaAddressBytes, parseMetaAddress } from './stealth.js';

export const ERC6538_REGISTRY: Address = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';
export const ERC5564_ANNOUNCER: Address = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';

export const registryAbi = parseAbi([
  'function registerKeys(uint256 schemeId, bytes stealthMetaAddress)',
  'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)',
]);

export const announcerAbi = parseAbi([
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
]);

/** Publishes `metaAddress` for the wallet's own address. */
export async function registerMetaAddress(
  wallet: WalletClient,
  publicClient: PublicClient,
  metaAddress: string,
  registry: Address = ERC6538_REGISTRY,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: 'registerKeys',
    args: [SCHEME_ID, metaAddressBytes(metaAddress)],
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`registerKeys reverted: ${hash}`);
  return hash;
}

/** The meta-address `who` has published, or undefined. */
export async function lookupMetaAddress(
  publicClient: PublicClient,
  who: Address,
  registry: Address = ERC6538_REGISTRY,
): Promise<string | undefined> {
  const raw = await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'stealthMetaAddressOf',
    args: [who, SCHEME_ID],
  });
  if (raw === '0x') return undefined;
  return encodeMetaAddress(parseMetaAddress(raw));
}

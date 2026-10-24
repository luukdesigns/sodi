/**
 * Deploys the yield pool stack on a local fork of Robinhood Chain mainnet: the audited Privacy Pools
 * contracts, unchanged, over SodiYieldVault shares invested in the real Steakhouse USDG Morpho vault.
 */
import { readFileSync } from 'node:fs';

import { type Abi, type Address, type Hex, createPublicClient, createTestClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
export const STEAK = '0xBeEff033F34C046626B8D0A041844C5d1A5409dd' as Address;
export const PROTOCOL_FEE_BPS = 50n;

export const chain = defineChain({ id: 4663, name: 'Robinhood Chain (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const publicClient = createPublicClient({ chain, transport: http(RPC) });
export const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
export type Account = ReturnType<typeof privateKeyToAccount>;
export const wallet = (account: Account) => createWalletClient({ chain, account, transport: http(RPC) });
export const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const usdgOf = (a: Address) => publicClient.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });

export const artifact = (file: string, name: string, libraries: Record<string, Address> = {}) => {
  const a = JSON.parse(readFileSync(new URL(`../../../../contracts/out/${file}/${name}.json`, import.meta.url), 'utf8'));
  let code = (a.bytecode.object as string).slice(2);
  // Link libraries (Foundry does this for scripts; a raw deploy has to).
  for (const refs of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
    for (const [lib, places] of Object.entries(refs)) {
      const address = libraries[lib];
      if (!address) throw new Error(`${name} needs library ${lib}`);
      for (const { start, length } of places) code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice((start + length) * 2);
    }
  }
  return { abi: a.abi as Abi, bytecode: `0x${code}` as Hex };
};

export async function deploy(from: Account, a: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
  const hash = await wallet(from).deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy failed');
  return r.contractAddress;
}

export async function send(from: Account, to: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet(from).writeContract({ address: to, abi, functionName, args } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}

/** USDG for tests, from the Morpho vault's idle balance (fork only). */
export async function fundUsdg(grants: [Address, bigint][]) {
  await testClient.impersonateAccount({ address: STEAK });
  await testClient.setBalance({ address: STEAK, value: 10n ** 18n });
  const steak = createWalletClient({ chain, account: STEAK, transport: http(RPC) });
  for (const [to, amount] of grants) {
    await publicClient.waitForTransactionReceipt({ hash: await steak.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [to, amount] }) });
  }
}

export interface YieldStack {
  entrypoint: Address;
  pool: Address;
  vault: Address;
  router: Address;
  funder: Address;
  deployBlock: bigint;
}

/** Deploys and wires the whole stack. `deployer` owns the Entrypoint and the vault and needs 1 USDG for the seed. */
export async function deployYieldStack(deployer: Account, postman: Address): Promise<YieldStack> {
  const wv = await deploy(deployer, artifact('WithdrawalVerifier.sol', 'WithdrawalVerifier'));
  const rv = await deploy(deployer, artifact('CommitmentVerifier.sol', 'CommitmentVerifier'));
  const ep = artifact('Entrypoint.sol', 'Entrypoint');
  const impl = await deploy(deployer, ep);
  const entrypoint = await deploy(deployer, artifact('ERC1967Proxy.sol', 'ERC1967Proxy'), [
    impl,
    encodeFunctionData({ abi: ep.abi, functionName: 'initialize', args: [deployer.address, postman] }),
  ]);
  const vault = await deploy(deployer, artifact('SodiYieldVault.sol', 'SodiYieldVault'), [USDG, STEAK, deployer.address, deployer.address]);
  const libraries = {
    PoseidonT3: await deploy(deployer, artifact('PoseidonT3.sol', 'PoseidonT3')),
    PoseidonT4: await deploy(deployer, artifact('PoseidonT4.sol', 'PoseidonT4')),
  };
  const pool = await deploy(deployer, artifact('PrivacyPoolComplex.sol', 'PrivacyPoolComplex', libraries), [entrypoint, wv, rv, vault]);
  const deployBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
  await send(deployer, entrypoint, ep.abi, 'registerPool', [vault, pool, 1_000_000n, 0n, 100n]);
  const funder = await deploy(deployer, artifact('SodiSessionFunder.sol', 'SodiSessionFunder'), [pool, vault, PROTOCOL_FEE_BPS]);
  const router = await deploy(deployer, artifact('SodiYieldDepositor.sol', 'SodiYieldDepositor'), [entrypoint, vault]);
  // Wire the only holders of shares, with the seed deposit (never withdrawn).
  await send(deployer, USDG, erc20, 'approve', [vault, 1_000_000n]);
  await send(deployer, vault, parseAbi(['function wire(address,address,address,address,uint256)']), 'wire', [pool, entrypoint, router, funder, 1_000_000n]);
  return { entrypoint, pool, vault, router, funder, deployBlock };
}

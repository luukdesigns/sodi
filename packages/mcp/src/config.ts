import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  FileControls,
  FileStore,
  HttpRelayer,
  IssuerSessions,
  Rx402Client,
  poolFromDeployment,
  WithdrawalProver,
  aspAssociationSet,
} from '@sodi/rx402';
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { McpOptions } from './tools.js';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};
const usdg = (s: string) => parseUnits(s, 6);

/** Builds the rx402 client and MCP limits from environment variables (see README). */
export async function fromEnv(): Promise<{ client: Rx402Client; options: McpOptions }> {
  const rpcUrl = env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
  // The npm package ships the deployment and the circuits next to its bundle; a checkout uses the repo's.
  // (In the bundle this code sits in dist/chunks/, so look one level up too.)
  const packaged = (p: string) => [resolve(import.meta.dirname, p), resolve(import.meta.dirname, '..', p)].find((f) => existsSync(f));
  const deploymentFile = env(
    'DEPLOYMENT_FILE',
    packaged('deployments/46630.json') ?? resolve(import.meta.dirname, '../../../contracts/deployments/46630.json'),
  );
  const circuitsDir = process.env.RX402_CIRCUITS_DIR ?? packaged('circuits');
  const prover = () =>
    new WithdrawalProver(
      circuitsDir ? { wasm: resolve(circuitsDir, 'withdraw.wasm'), zkey: resolve(circuitsDir, 'withdraw.zkey'), vkey: resolve(circuitsDir, 'withdraw.vkey') } : undefined,
    );
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  const chain = defineChain({
    id: deployment.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // RX402_POOL=syUSDG uses the yield pool.
  const poolSettings = poolFromDeployment(deployment, env('RX402_POOL', 'USDG'));
  const common = {
    publicClient,
    asset: poolSettings.asset,
    stealth: env('RX402_STEALTH', 'true') !== 'false',
    store: new FileStore(env('RX402_STORE', join(homedir(), '.sodi', 'rx402.json'))),
    controls: new FileControls(env('RX402_CONTROLS', join(homedir(), '.sodi', 'controls.json'))),
    policy: {
      budget: usdg(env('RX402_SESSION_BUDGET', '1')),
      maxPayments: Number(env('RX402_MAX_PAYMENTS_PER_SESSION', '20')),
      maxAgeSeconds: Number(env('RX402_MAX_SESSION_AGE', '3600')),
      maxPaymentAmount: usdg(env('RX402_MAX_PER_REQUEST', '0.10')),
    },
  };

  // With a session issuer, this process holds only an agent key: the pool secret stays with the issuer.
  const relayerUrl = env('RELAYER_URL', 'https://relayer.sodi.network');
  const relayerTerms = {
    chainId: deployment.chainId as number,
    entrypoint: deployment.contracts.Entrypoint as Address,
    feeRecipient: process.env.RELAYER_FEE_RECIPIENT as Address | undefined,
    maxFeeBPS: BigInt(env('RELAYER_MAX_FEE_BPS', '100')),
  };
  let relayer: HttpRelayer | undefined;
  const issuerUrl = process.env.RX402_ISSUER_URL;
  let issuer: IssuerSessions | undefined;
  let client: Rx402Client;
  if (issuerUrl) {
    if (process.env.RX402_MNEMONIC) throw new Error('set RX402_ISSUER_URL or RX402_MNEMONIC, not both: the point of an issuer is that the agent never holds the mnemonic');
    issuer = new IssuerSessions({ url: issuerUrl, agentKey: env('RX402_AGENT_KEY') as Hex, publicClient, asset: common.asset, store: common.store });
    client = new Rx402Client({ ...common, sessions: issuer });
  } else {
    const ownerKey = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
    client = new Rx402Client({
      ...common,
      ownerWallet: ownerKey ? createWalletClient({ chain, account: privateKeyToAccount(ownerKey), transport: http(rpcUrl) }) : undefined,
      mnemonic: env('RX402_MNEMONIC'),
      ...poolSettings,
      relayer: (relayer = await HttpRelayer.connect(relayerUrl, relayerTerms)),
      prover: prover(),
      associationSet: aspAssociationSet(env('ASP_URL', 'https://sodi-asp.onrender.com')),
    });
  }

  const options: McpOptions = {
    maxTotalSpend: usdg(env('RX402_MAX_TOTAL_SPEND', '5')),
    allowedHosts: (process.env.RX402_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    issuer,
  };

  // The inference gateway for ask_model; RX402_GATEWAY_URL=off turns the tool off.
  const gatewayUrl = env('RX402_GATEWAY_URL', 'https://inference.sodi.network');
  if (gatewayUrl !== 'off') {
    options.gateway = {
      url: gatewayUrl,
      defaultModel: env('RX402_GATEWAY_MODEL', 'deepseek/deepseek-v4.1-flash'),
      defaultMaxTokens: Number(env('RX402_GATEWAY_MAX_TOKENS', '1024')),
    };
  }

  // Recycling goes through the relayer (connected on first use when sessions come from an issuer).
  const recycler = (process.env.RX402_RECYCLER ?? deployment.contracts.SodiRecycler) as Address | undefined;
  if (recycler) {
    const maxFee = usdg(env('RX402_MAX_RECYCLE_FEE', '0.001'));
    options.recycle = async () => {
      relayer ??= await HttpRelayer.connect(relayerUrl, relayerTerms);
      return client.recycleSessions({ submitter: relayer.recycleSubmitter({ recycler, maxFee }) });
    };
  }
  return { client, options };
}

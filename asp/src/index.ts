import type { Address } from 'viem';

import { makeClients } from './chain.js';
import { loadBlocklist, loadConfig } from './config.js';
import { startServer } from './server.js';
import { runCycle } from './service.js';
import { loadState } from './state.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const config = loadConfig();
  const { deployment } = config;
  const entrypoint = deployment.contracts.Entrypoint;
  const pools = Object.values(deployment.pools).map((p) => p.pool as Address);
  // Deposits through these are screened against the real depositor named in their events.
  const forwarders = deployment.forwarders ?? [deployment.contracts.SodiRecycler, deployment.contracts.SodiYieldDepositor].filter((a): a is Address => !!a);
  const { publicClient, walletClient } = makeClients(deployment.chainId, config.rpcUrl, config.postmanKey);

  const chainId = await publicClient.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(`RPC is on chain ${chainId}, deployment file is for ${deployment.chainId}`);
  }

  const state = loadState(config.stateFile, () => ({
    chainId,
    entrypoint: entrypoint.toLowerCase(),
    lastScannedBlock: deployment.deploymentBlock - 1,
    deposits: [],
    published: [],
  }));

  log(
    `approval service: chain ${chainId}, entrypoint ${entrypoint}, ${pools.length} pool(s), ` +
      `vetting delay ${config.vettingDelaySeconds}s${config.dryRun ? ', DRY RUN' : ''}`,
  );

  const cycle = async () => {
    const blocklist = loadBlocklist(config.blocklistFile); // re-read each cycle so edits apply live
    const r = await runCycle({
      publicClient,
      walletClient,
      entrypoint,
      pools,
      forwarders,
      policy: {
        blockedAddresses: new Set(blocklist.addresses.map((a) => a.toLowerCase())),
        deniedLabels: new Set(blocklist.labels),
        vettingDelaySeconds: config.vettingDelaySeconds,
        allowedContracts: new Set(blocklist.allowedContracts.map((a) => a.toLowerCase())),
      },
      state,
      stateFile: config.stateFile,
      setsDir: config.setsDir,
      logChunkSize: config.logChunkSize,
      dryRun: config.dryRun,
      log,
    });
    log(
      `block ${state.lastScannedBlock}: +${r.newDeposits} new, ${r.approved} approved, ` +
        `${r.pending} pending, ${r.denied} denied; root ${r.root === r.onChainRoot ? 'up to date' : 'changed'}`,
    );
  };

  if (config.once) {
    await cycle();
    return;
  }

  startServer(config.port, () => state, config.setsDir);
  log(`API listening on :${config.port}`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

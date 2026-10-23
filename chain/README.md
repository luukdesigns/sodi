# Sodi L3

**Draft.** A future Arbitrum Orbit chain settling to Robinhood Chain, for private agent payments with fees and ordering designed for agents.

Nothing here is deployed, and nothing else in Sodi depends on it. Every Sodi component runs on Robinhood Chain today.

- [Architecture](./docs/ARCHITECTURE.md): why an L3, what it costs, and the design choices fixed at genesis
- [Roadmap and open questions](./docs/ROADMAP.md): stages and the gates before mainnet
- [`deploy/`](./deploy): deployment scripts using the Arbitrum chain SDK

## Status

Robinhood Chain is a supported Orbit parent. The Arbitrum chain SDK ships factory addresses for it, and they are live on testnet. Rehearsed on a testnet fork against the real RollupCreator, the deployment script produces a rollup with the expected chain ID, owner, batch poster, validator and challenge period, and generates a node config for it.

## Deploying

`deploy/` is its own npm package (the chain SDK needs viem 1), outside the root workspaces.

```sh
cd chain/deploy
npm install

# Dry run: checks the parameters and the cost
DEPLOYER_PRIVATE_KEY=0x... BATCH_POSTER_ADDRESS=0x... VALIDATOR_ADDRESS=0x... npm run rollup

# Deploy the core contracts; writes chain/deployments/76340.json
npm run rollup -- --send

# Write the Nitro node config to ~/.sodi-chain/76340/ (contains keys; never commit it)
BATCH_POSTER_PRIVATE_KEY=0x... VALIDATOR_PRIVATE_KEY=0x... npm run node-config

# With the node running: deploy the token bridge
SODI_RPC_URL=http://localhost:8449 npm run token-bridge
```

Set `SODI_NETWORK=mainnet` for mainnet. Use three different keys; on mainnet the owner should be a multisig.

Testnet deployment needs about 0.13 ETH in the owner wallet, almost all of it prepaid L3 gas for the bridge factories, refunded on the L3 if unused.

## Rehearsal on a fork

```sh
bash test/run-fork.sh   # needs anvil and cast (Foundry)
```

Forks Robinhood Chain testnet, deploys with fresh throwaway keys, and checks the result. Anvil has no Arbitrum precompiles, so the script installs small stand-ins for ArbSys and ArbGasInfo (`test/mocks`).

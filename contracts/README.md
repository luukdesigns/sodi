# contracts

Deployment of the shielded USDG pool on Robinhood Chain.

The pool is [0xbow Privacy Pools](https://github.com/0xbow-io/privacy-pools-core), used **unchanged**: the audited contracts are compiled from the pinned submodule with the same compiler settings as upstream (solc 0.8.28, optimizer 10,000 runs). Sodi adds the deployment script, tests, and one contract of its own beside the pool, the [recycler](#sodirecycler).

## Layout

```
contracts/
├── lib/                      Pinned git submodules
│   ├── privacy-pools-core    0xbow Privacy Pools @ d494b63
│   ├── openzeppelin-contracts            v5.1.0
│   ├── openzeppelin-contracts-upgradeable v5.0.2
│   ├── zk-kit.solidity       lean-imt.sol v2.0.0
│   ├── poseidon-solidity     v0.0.5
│   └── forge-std             v1.9.6
├── src/SodiRecycler.sol      Puts leftover funds back into the pool, gaslessly
├── script/DeployUSDGPool.s.sol
└── test/                     Pool deployment and recycler tests
```

Dependency versions match those pinned by upstream Privacy Pools.

## Setup

```bash
git clone --recurse-submodules https://github.com/rowanweiss/sodi
# or, in an existing clone:
git submodule update --init --recursive

cd contracts
forge build
forge test
```

## Deployments

### Robinhood Chain testnet (46630)

| Contract | Address |
| --- | --- |
| Entrypoint (proxy) | [`0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce`](https://explorer.testnet.chain.robinhood.com/address/0xaCa6B50b648a6f575a009DC7c97aBe62808869Ce) |
| USDG pool | [`0x8cddbb1C33ce49aB72FD1765649835935604BF76`](https://explorer.testnet.chain.robinhood.com/address/0x8cddbb1C33ce49aB72FD1765649835935604BF76) |
| Entrypoint implementation | `0xDcB02c8EF8057861f4fd37Becde9b1B2586F75f3` |
| WithdrawalVerifier | `0x2740523E66d4a74002B8e11c839AbbF86A084c71` |
| CommitmentVerifier | `0x58E37acaf8B2B2f61c3A65E1db59A7dEcb879061` |
| USDG (asset) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| SodiRecycler | [`0x9727252654cbB19A057a5e052aCbAdd3F33e1055`](https://explorer.testnet.chain.robinhood.com/address/0x9727252654cbB19A057a5e052aCbAdd3F33e1055) (the first, `0x2302…37AF`, is superseded: see below) |

Owner and postman are the testnet deployer, `0xF4411EC2705299FCe6f6Cd99e432AEe88382BF4d`. Full details in [`deployments/46630.json`](./deployments/46630.json); transaction logs in `broadcast/`.

## SodiRecycler

Puts funds left at an address back into the pool: an rx402 session that has rotated, or a merchant's stealth address. The address never needs gas.

- The address signs an EIP-3009 `ReceiveWithAuthorization` paying the recycler, whose nonce commits to the new deposit's precommitment and the submitter's fee. Only the recycler can execute it, and only with that deposit, so whoever submits it (a [relayer](../relayer), usually) the funds can only become the deposit the owner chose.
- The pool records the recycler as the depositor, so the recycler also forwards ragequits, and a ragequit can only send the funds back to the address they came from.
- Ragequit refunds are keyed by the deposit's **label**, which stays the same when part of the deposit is withdrawn. The first deployment keyed them by commitment, so a recycled deposit couldn't be ragequit through it after a partial withdrawal (it could still be withdrawn privately); it was replaced on 2026-10-24.
- The approval service screens the address the funds came from, named in the recycler's `Recycled` event, not the recycler.
- No owner, nothing held between calls. Amounts below the pool's minimum deposit can't be recycled.

Tests (`forge test --match-contract SodiRecycler`), against a full local deployment of the pool: recycling with a fee, a front-runner swapping the deposit, a submitter raising its fee, moving the funds around the recycler, replays, dust below the minimum, and ragequits (with the ragequit verifier mocked). The [issuer's fork test](../issuer/test/e2e/recycle.test.ts) recycles real sessions through the relayer on a testnet fork.

**Live on testnet** ([`recycle-live.ts`](../packages/rx402/demo/recycle-live.ts)): the live agent's two finished sessions (0.03975 and 0.03175 USDG) were recycled through the relayer, the approval service approved the new deposits, and a new session was funded by a zero-knowledge withdrawal from one of them. A third session, holding 0.007 USDG, was below the minimum and was left alone. Transactions are under `recycler.liveRun` in [`deployments/46630.json`](./deployments/46630.json).

## What the deploy script does

1. Deploys the Groth16 `WithdrawalVerifier` and `CommitmentVerifier`.
2. Deploys the `Entrypoint` behind an ERC-1967 (UUPS) proxy and initializes it with `OWNER_ADDRESS` and `POSTMAN_ADDRESS`.
3. Deploys a `PrivacyPoolComplex` for USDG.
4. Registers the pool with the Entrypoint (minimum deposit 1 USDG, 0% vetting fee, 1% max relay fee), if the deployer is the owner. On testnet the minimum was later lowered to 0.1 USDG, because testnet USDG is scarce, and then to 0.01 USDG so leftover session funds can be recycled; see `deployments/46630.json`.

Before deploying, it checks that the configured USDG address is a contract with 6 decimals and that you are on chain 46630.

Unlike upstream, it deploys with plain `new` rather than the CreateX singleton, since CreateX may not exist on Robinhood Chain. Addresses are therefore not deterministic.

## Deploy to Robinhood Chain testnet

1. Get testnet ETH from the [faucet](https://faucet.testnet.chain.robinhood.com).
2. Import a throwaway key into a Foundry keystore: `cast wallet import sodi-testnet-deployer --interactive`
3. Copy `.env.example` to `.env` in the repo root and fill in `OWNER_ADDRESS` and `POSTMAN_ADDRESS` (your deployer address works for both on testnet).
4. Check the USDG testnet address in `script/DeployUSDGPool.s.sol` on the [explorer](https://explorer.testnet.chain.robinhood.com).
5. Dry run, then broadcast:

```bash
source ../.env
forge script script/DeployUSDGPool.s.sol:RobinhoodTestnet --rpc-url robinhood_testnet --account $DEPLOYER_ACCOUNT
forge script script/DeployUSDGPool.s.sol:RobinhoodTestnet --rpc-url robinhood_testnet --account $DEPLOYER_ACCOUNT --broadcast --slow
```

## Not done yet

- The association-set (ASP) root: until the postman publishes one, deposits can be made but not privately withdrawn. Ragequit (public exit to the depositing wallet) always works.
- Mainnet configuration, which needs a multisig owner and an audit of anything Sodi adds.

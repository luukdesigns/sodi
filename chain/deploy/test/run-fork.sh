#!/usr/bin/env bash
# Rehearses the Sodi L3 core deployment on a fork of Robinhood Chain testnet, against the real
# RollupCreator, then checks what it deployed. No real funds are used: a fresh key is funded on the fork.
#
#   bash test/run-fork.sh
#
# Needs anvil and cast (Foundry) on PATH, or FOUNDRY_BIN pointing at their directory.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${FOUNDRY_BIN:+$FOUNDRY_BIN/}"
FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
PORT="${PORT:-8547}"
RPC="http://127.0.0.1:$PORT"
OUT="$(mktemp -d)"

"${BIN}anvil" --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null; rm -rf "$OUT"' EXIT
for _ in $(seq 60); do "${BIN}cast" chain-id -r "$RPC" >/dev/null 2>&1 && break; sleep 1; done

# Anvil has no Arbitrum precompiles. The rollup contracts read ArbSys and ArbGasInfo when deployed on an
# Arbitrum parent, so install minimal stand-ins (sources in test/mocks; rebuild with solc 0.8.28 --optimize).
"${BIN}cast" rpc anvil_setCode 0x0000000000000000000000000000000000000064 "0x$(tr -d '\n' < test/mocks/ArbSysMock.bin-runtime)" -r "$RPC" >/dev/null
"${BIN}cast" rpc anvil_setCode 0x000000000000000000000000000000000000006c "0x$(tr -d '\n' < test/mocks/ArbGasInfoMock.bin-runtime)" -r "$RPC" >/dev/null

new_key() { "${BIN}cast" wallet new | awk '/Private key/ {print $3}'; }
addr() { "${BIN}cast" wallet address "$1"; }
OWNER_KEY=$(new_key); POSTER_KEY=$(new_key); VALIDATOR_KEY=$(new_key)
OWNER=$(addr "$OWNER_KEY")
"${BIN}cast" rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 -r "$RPC" >/dev/null # 100 ETH

DEPLOYER_PRIVATE_KEY="$OWNER_KEY" \
BATCH_POSTER_ADDRESS=$(addr "$POSTER_KEY") \
VALIDATOR_ADDRESS=$(addr "$VALIDATOR_KEY") \
PARENT_RPC_URL="$RPC" \
DEPLOYMENT_OUT="$OUT/deployment.json" \
  npx tsx src/create-rollup.ts --send

fail=0
check() { local got="${2%% *}"; if [ "$got" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $got, want $3"; fail=1; fi; }
get() { node -e "const d=require('$OUT/deployment.json'); console.log(d.coreContracts['$1'])"; }

for c in rollup inbox outbox bridge sequencerInbox rollupEventInbox challengeManager upgradeExecutor validatorWalletCreator; do
  size=$("${BIN}cast" codesize "$(get $c)" -r "$RPC")
  if [ "$size" -gt 0 ]; then echo "ok   $c has code ($size bytes)"; else echo "FAIL $c has no code"; fail=1; fi
done
ROLLUP=$(get rollup)
check "rollup chain id" "$("${BIN}cast" call "$ROLLUP" 'chainId()(uint256)' -r "$RPC")" 76340
check "rollup is owned by the upgrade executor" \
  "$("${BIN}cast" call "$ROLLUP" 'owner()(address)' -r "$RPC" | tr 'A-F' 'a-f')" "$(get upgradeExecutor | tr 'A-F' 'a-f')"
check "batch poster is authorised" \
  "$("${BIN}cast" call "$(get sequencerInbox)" 'isBatchPoster(address)(bool)' "$(addr "$POSTER_KEY")" -r "$RPC")" true
check "validator is allowlisted" \
  "$("${BIN}cast" call "$ROLLUP" 'isValidator(address)(bool)' "$(addr "$VALIDATOR_KEY")" -r "$RPC")" true
check "challenge period" "$("${BIN}cast" call "$ROLLUP" 'confirmPeriodBlocks()(uint64)' -r "$RPC")" 150

# The node config generator should accept what was deployed (keys are throwaway fork keys).
BATCH_POSTER_PRIVATE_KEY="$POSTER_KEY" VALIDATOR_PRIVATE_KEY="$VALIDATOR_KEY" PARENT_RPC_URL="$RPC" \
  DEPLOYMENT_FILE="$OUT/deployment.json" NODE_CONFIG_DIR="$OUT/node" npx tsx src/node-config.ts >/dev/null
check "node config targets the deployed rollup" \
  "$(node -e "console.log(require('$OUT/node/node-config.json').chain['info-json'])" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].rollup.rollup))")" "$ROLLUP"

exit $fail

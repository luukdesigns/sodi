#!/usr/bin/env bash
# Runs the yield pool prototype test against a local fork of Robinhood Chain MAINNET, where USDG and
# the Steakhouse USDG Morpho vault are live. Nothing is sent to mainnet: everything happens on the fork.
#
#   ./test/e2e-mainnet/run-fork.sh
#
# Needs the contracts built (forge build in contracts/).
set -euo pipefail
cd "$(dirname "$0")/../.."

FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${PORT:-8545}"

[ -f ../../contracts/out/SodiSessionFunder.sol/SodiSessionFunder.json ] || (cd ../../contracts && forge build)

# The public RPC rate-limits; keep anvil's request rate modest and retry.
anvil --fork-url "$FORK_URL" --port "$PORT" --silent --compute-units-per-second 100 --fork-retry-backoff 1000 --retries 10 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  sleep 1
done

FORK_RPC="http://127.0.0.1:$PORT" npx vitest run ${TESTS:-test/e2e-mainnet/} --no-file-parallelism

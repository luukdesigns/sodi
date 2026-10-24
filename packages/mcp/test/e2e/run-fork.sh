#!/usr/bin/env bash
# Runs the Sodi full-stack end-to-end test (MCP, rx402, relayer, approval service) against a local fork of Robinhood Chain testnet.
#
#   POSTMAN_PRIVATE_KEY=0x... ./test/e2e/run-fork.sh
#
# POSTMAN_PRIVATE_KEY must hold ASP_POSTMAN on the testnet Entrypoint (the testnet deployer does).
# Nothing is sent to the real testnet: all transactions happen on the local fork.
set -euo pipefail
cd "$(dirname "$0")/../.."

FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
PORT="${PORT:-8545}"

anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  sleep 1
done

# The recycle test deploys SodiRecycler from the contracts build.
[ -f ../../contracts/out/SodiRecycler.sol/SodiRecycler.json ] || (cd ../../contracts && forge build)

FORK_RPC="http://127.0.0.1:$PORT" npx vitest run test/e2e

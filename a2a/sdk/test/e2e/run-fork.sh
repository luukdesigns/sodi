#!/usr/bin/env bash
# Runs the Sodi A2A negotiation test against a local fork of Robinhood Chain testnet.
#
#   ./test/e2e/run-fork.sh   (builds the contract first)
#
# Nothing is sent to the real testnet: all transactions happen on the local fork.
set -euo pipefail
cd "$(dirname "$0")/../.."

(cd ../contracts && forge build >/dev/null)
FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
PORT="${PORT:-8545}"

anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  sleep 1
done

FORK_RPC="http://127.0.0.1:$PORT" npx vitest run test/e2e

#!/usr/bin/env bash
# Stealth payments end to end on a local fork of Robinhood Chain testnet.
#
#   POSTMAN_PRIVATE_KEY=0x... ./test/e2e/run-fork.sh
#
# POSTMAN_PRIVATE_KEY must hold ASP_POSTMAN on the testnet Entrypoint (the testnet deployer does).
# Nothing is sent to the real testnet.
set -euo pipefail
cd "$(dirname "$0")/../.."

FORK_URL="${FORK_URL:-https://rpc.testnet.chain.robinhood.com}"
PORT="${PORT:-8545}"
BIN="${FOUNDRY_BIN:+$FOUNDRY_BIN/}"

(cd ../contracts && "${BIN}forge" build ${FORGE_FLAGS:-} >/dev/null)

"${BIN}anvil" --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  "${BIN}cast" chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  sleep 1
done

FORK_RPC="http://127.0.0.1:$PORT" npx vitest run test/e2e

#!/bin/sh
# Starts one workspace service on Render, loading secrets from the service's Secret File if present.
#   sh scripts/render-start.sh @sodi/relayer
set -eu
if [ -f /etc/secrets/.env ]; then
  set -a
  . /etc/secrets/.env
  set +a
fi
exec npm start -w "$1"

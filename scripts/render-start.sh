#!/bin/sh
# Starts one workspace service on Render, loading its secrets from a Render Secret File:
#   @sodi/relayer            /etc/secrets/relayer.env
#   @sodi/asp                /etc/secrets/asp.env
#   @sodi/inference-gateway  /etc/secrets/gateway.env
# (or /etc/secrets/.env). Only the service's own file is read, even if others are present.
#   sh scripts/render-start.sh @sodi/relayer
set -eu
case "$1" in
  @sodi/relayer) own=relayer.env ;;
  @sodi/asp) own=asp.env ;;
  @sodi/inference-gateway) own=gateway.env ;;
  *) own=.env ;;
esac
for f in "/etc/secrets/$own" /etc/secrets/.env; do
  if [ -f "$f" ]; then
    set -a
    . "$f"
    set +a
    echo "loaded secrets from $f" >&2
    break
  fi
done
exec npm start -w "$1"

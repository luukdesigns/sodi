#!/bin/sh
# Starts one workspace service on Render, loading its secrets from a Render Secret File.
# Looks for, in order:
#   the service's own file   relayer.env / asp.env / gateway.env
#   a shared .env
#   any other *.env file     (e.g. one shared file under another name)
# Logs file names only, never contents.
#   sh scripts/render-start.sh @sodi/relayer
set -eu
case "$1" in
  @sodi/relayer) own=relayer.env ;;
  @sodi/asp) own=asp.env ;;
  @sodi/inference-gateway) own=gateway.env ;;
  *) own=.env ;;
esac
load() {
  set -a
  . "$1"
  set +a
  echo "loaded secrets from $1" >&2
}
if [ -f "/etc/secrets/$own" ]; then
  load "/etc/secrets/$own"
elif [ -f /etc/secrets/.env ]; then
  load /etc/secrets/.env
else
  found=0
  for f in /etc/secrets/*.env; do
    [ -f "$f" ] || continue
    load "$f"
    found=1
  done
  if [ "$found" = 0 ]; then
    echo "no secret file found; /etc/secrets holds: $(ls -A /etc/secrets 2>/dev/null | tr '\n' ' ' || echo 'nothing (no Secret Files on this service)')" >&2
  fi
fi
exec npm start -w "$1"

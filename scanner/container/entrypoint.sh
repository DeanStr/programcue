#!/bin/sh
set -eu

/init &

attempt=0
while [ ! -S /run/clamav/clamd.sock ] && [ ! -S /tmp/clamd.sock ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 300 ]; then
    echo "ClamAV did not become ready within five minutes." >&2
    exit 1
  fi
  sleep 1
done

# The container disk is ephemeral. Refresh and reload signatures before the
# health port opens so the first scan after a cold start never uses stale data.
freshclam --stdout --user=clamav

exec python3 /opt/program-cue-scanner/scanner_server.py

#!/bin/sh
set -eu

readiness_file=/tmp/program-cue-scanner-ready
rm -f "$readiness_file"

/init &

(
  attempt=0
  while [ ! -S /run/clamav/clamd.sock ] && [ ! -S /tmp/clamd.sock ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 300 ]; then
      echo "ClamAV did not become ready within five minutes." >&2
      exit 1
    fi
    sleep 1
  done

  # The disk is ephemeral. Keep scans unavailable until the cold-start
  # signature refresh succeeds, but do not delay the platform health port.
  freshclam --stdout --user=clamav
  : > "$readiness_file"
) &

exec python3 /opt/program-cue-scanner/scanner_server.py

#!/bin/sh
set -eu

readiness_file=/tmp/program-cue-scanner-ready
maximum_signature_age_seconds=604800
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

  version=$(clamdscan --version)
  signature_date=${version##*/}
  signature_epoch=$(date --date="$signature_date" +%s)
  now=$(date +%s)
  if [ "$signature_epoch" -gt $((now + 86400)) ] || \
    [ $((now - signature_epoch)) -gt "$maximum_signature_age_seconds" ]; then
    echo "The baked ClamAV signature database is outside the seven-day freshness window." >&2
    exit 1
  fi
  : > "$readiness_file"

  # The deployment image contains a fresh, verified database so a transient
  # mirror failure never blocks a cold start. Keep checking the allowlisted
  # ClamAV mirror while this instance remains alive.
  freshclam --daemon --foreground --checks=24 --daemon-notify=/etc/clamav/clamd.conf \
    --stdout --user=clamav
) &

exec python3 /opt/program-cue-scanner/scanner_server.py

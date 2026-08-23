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

  if version=$(clamdscan --version); then
    signature_date=${version##*/}
    signature_epoch=$(date --date="$signature_date" +%s)
    now=$(date +%s)
    if [ "$signature_epoch" -le $((now + 86400)) ] && \
      [ $((now - signature_epoch)) -le "$maximum_signature_age_seconds" ]; then
      : > "$readiness_file"
    else
      echo "The baked ClamAV signature database is outside the seven-day freshness window." >&2
    fi
  else
    echo "The ClamAV signature version could not be verified." >&2
  fi

  # The deployment image contains a fresh, verified database so a transient
  # mirror failure never blocks a cold start. Keep checking the allowlisted
  # ClamAV mirror while this instance remains alive.
  freshclam --daemon --foreground --checks=24 --daemon-notify=/etc/clamav/clamd.conf \
    --stdout --user=clamav
) &

# The image initializer needs root, but the request-facing adapter processes
# hostile files and must not retain those privileges.
exec setpriv --reuid=clamav --regid=clamav --init-groups --no-new-privs \
  python3 /opt/program-cue-scanner/scanner_server.py

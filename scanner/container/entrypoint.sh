#!/bin/sh
set -eu

scanner_proxy_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ ! -r "$scanner_proxy_ca" ] || [ ! -s "$scanner_proxy_ca" ]; then
  echo "The Cloudflare interception CA is required for ClamAV signature updates." >&2
  exit 1
fi

/init &

(
  attempt=0
  while [ ! -S /tmp/clamd.sock ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 300 ]; then
      echo "ClamAV did not become ready within five minutes." >&2
      exit 1
    fi
    sleep 1
  done

  # Refresh even when the image's baked database has aged out. HTTP readiness
  # checks the daemon's loaded database on every probe, including after reload.
  # FreshClam uses libcurl's CA bundle; Python's R2 trust configuration does not
  # apply to this process. Keep certificate verification enabled for the proxy.
  CURL_CA_BUNDLE="$scanner_proxy_ca" \
    freshclam --daemon --foreground --checks=24 --daemon-notify=/etc/clamav/clamd.conf \
    --stdout --user=clamav
) &

# The image initializer needs root, but the request-facing adapter processes
# hostile files and must not retain those privileges.
exec setpriv --reuid=clamav --regid=clamav --init-groups --no-new-privs \
  python3 /opt/program-cue-scanner/scanner_server.py

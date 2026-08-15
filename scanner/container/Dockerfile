FROM clamav/clamav:1.4.6-debian13-slim@sha256:5ec6dcef8e7cd8a019fb388639628139bb7d358c6ab07b90ea344613bf446353

USER root

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scanner_server.py /opt/program-cue-scanner/scanner_server.py
COPY entrypoint.sh /usr/local/bin/program-cue-scanner-entrypoint

RUN chmod 0755 \
    /opt/program-cue-scanner/scanner_server.py \
    /usr/local/bin/program-cue-scanner-entrypoint \
    && freshclam --stdout --user=clamav

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/program-cue-scanner-entrypoint"]

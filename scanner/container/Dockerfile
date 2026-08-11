FROM clamav/clamav:1.4.5-debian13-slim@sha256:c730bead5fe766dc0edbac5e389b71fc1403a5d3a35c6af9397ad79a52fdc27a

USER root

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scanner_server.py /opt/program-cue-scanner/scanner_server.py
COPY entrypoint.sh /usr/local/bin/program-cue-scanner-entrypoint

RUN chmod 0755 \
    /opt/program-cue-scanner/scanner_server.py \
    /usr/local/bin/program-cue-scanner-entrypoint

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/program-cue-scanner-entrypoint"]

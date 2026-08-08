#!/usr/bin/env python3
"""Local HTTP smoke and security test for the zero-install evaluator build."""
from __future__ import annotations

import http.client
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(url: str, method: str = "GET", attempts: int = 40) -> tuple[int, bytes, str, dict[str, str]]:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            req = urllib.request.Request(url, method=method)
            with urllib.request.urlopen(req, timeout=2) as response:
                return response.status, response.read(), response.headers.get_content_type(), {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get_content_type(), {key.lower(): value for key, value in error.headers.items()}
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError(f"Unable to fetch {url}: {last_error}")


def raw_request(port: int, path: str) -> tuple[int, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    connection.request("GET", path)
    response = connection.getresponse()
    body = response.read()
    status = response.status
    connection.close()
    return status, body


def main() -> int:
    port = free_port()
    environment = os.environ.copy()
    environment["PORT"] = str(port)
    process = subprocess.Popen(
        ["node", "server.mjs"],
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        checks = [
            ("/healthz", b"ok", "text/plain"),
            ("/api/v1/health", b'"service":"program-cue"', "application/json"),
            ("/", b"Program Cue", "text/html"),
            ("/app.js", b"openCommand", "text/javascript"),
            ("/styles.css", b"--brand", "text/css"),
            ("/openapi.json", b"openapi", "application/json"),
            ("/api/v1/public/events/future-of-events-2025/programme", b"startsAt", "application/json"),
            ("/api/v1/public/events/future-of-events-2025/calendar.ics", b"DTSTART:", "text/calendar"),
            ("/embed/future-of-events-2025", b"Program Cue", "text/html"),
        ]
        for path, expected, content_type in checks:
            status, body, actual_type, _headers = request(base + path)
            if status != 200:
                raise AssertionError(f"{path}: expected 200, received {status}")
            if expected not in body:
                raise AssertionError(f"{path}: expected marker {expected!r}")
            if actual_type != content_type:
                raise AssertionError(f"{path}: expected {content_type}, received {actual_type}")

        status, body, _type, headers = request(base + "/", method="HEAD")
        if status != 200 or body:
            raise AssertionError("HEAD / must return 200 with no response body")
        if "frame-ancestors 'self'" not in headers.get("content-security-policy", ""):
            raise AssertionError("normal application route is missing restrictive frame ancestors")

        _status, _body, _type, api_headers = request(base + "/api/v1/public/events/future-of-events-2025/programme")
        if api_headers.get("access-control-allow-origin") != "*":
            raise AssertionError("public programme API is missing permissive read-only CORS")
        _status, _body, _type, embed_headers = request(base + "/embed/future-of-events-2025")
        if "frame-ancestors *" not in embed_headers.get("content-security-policy", ""):
            raise AssertionError("embed route is not externally frameable")

        for path in ("/missing.js", "/api/v1/not-a-route", "/embed/not-this-event"):
            status, _body, _type, _headers = request(base + path)
            if status != 404:
                raise AssertionError(f"{path}: expected 404, received {status}")

        status, traversal_body = raw_request(port, "/%2e%2e/package.json")
        if status not in (400, 404) or b'"name": "program-cue"' in traversal_body:
            raise AssertionError("encoded path traversal was not rejected")

        print(f"smoke test passed: {len(checks) + 7} HTTP and security checks on port {port}")
        return 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        if process.returncode not in (0, -15):
            stdout, stderr = process.communicate()
            print(stdout, file=sys.stderr)
            print(stderr, file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())

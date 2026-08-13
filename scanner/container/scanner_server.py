#!/usr/bin/env python3
"""Small, fail-closed HTTP adapter around the local ClamAV daemon."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_FILE_BYTES = 1_073_741_824
MAX_REQUEST_BYTES = 24_000
DOWNLOAD_TIMEOUT_SECONDS = 600
SCAN_TIMEOUT_SECONDS = 720
CHUNK_BYTES = 1024 * 1024
SCAN_DIRECTORY = Path("/tmp/program-cue-scans")
READINESS_FILE = Path("/tmp/program-cue-scanner-ready")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
SCAN_LOCK = threading.BoundedSemaphore(1)


class ContractError(Exception):
    """The trusted caller still supplied an invalid or unsafe job."""


class ObjectFetchError(Exception):
    """The private object could not be fetched and verified."""


class ClamScanError(Exception):
    """ClamAV could not produce a trustworthy verdict."""


def clamav_ready() -> bool:
    sockets = [Path("/run/clamav/clamd.sock"), Path("/tmp/clamd.sock")]
    return READINESS_FILE.is_file() and any(path.exists() for path in sockets)


def wait_for_clamav(timeout_seconds: float = 300) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if clamav_ready():
            return True
        time.sleep(0.25)
    return clamav_ready()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise ObjectFetchError("R2 object downloads must not redirect.")


def _required_string(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ContractError(f"{name} is invalid.")
    return value


def validate_scan_request(
    payload: Any,
    expected_host: str,
    expected_bucket: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"jobId", "object"}:
        raise ContractError("The scan request shape is invalid.")
    job_id = _required_string(payload.get("jobId"), "jobId", 200)
    if not IDENTIFIER.fullmatch(job_id):
        raise ContractError("jobId is invalid.")
    object_input = payload.get("object")
    if not isinstance(object_input, dict) or set(object_input) != {
        "url",
        "sizeBytes",
        "etag",
    }:
        raise ContractError("The object identity is invalid.")
    object_url = _required_string(object_input.get("url"), "object.url", 8192)
    expected_etag = _required_string(object_input.get("etag"), "object.etag", 200)
    expected_size = object_input.get("sizeBytes")
    if (
        isinstance(expected_size, bool)
        or not isinstance(expected_size, int)
        or expected_size < 1
        or expected_size > MAX_FILE_BYTES
    ):
        raise ContractError("object.sizeBytes is invalid.")

    parsed = urllib.parse.urlsplit(object_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ContractError("The object URL is outside the configured R2 account.")
    bucket_prefix = f"/{urllib.parse.quote(expected_bucket, safe='')}/"
    if not parsed.path.startswith(bucket_prefix):
        raise ContractError("The object URL is outside the configured R2 bucket.")
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if (
        query.get("X-Amz-Algorithm") != ["AWS4-HMAC-SHA256"]
        or not query.get("X-Amz-Signature", [""])[0]
    ):
        raise ContractError("The object URL is not a signed R2 request.")

    return {
        "jobId": job_id,
        "object": {
            "url": object_url,
            "sizeBytes": expected_size,
            "etag": expected_etag,
        },
    }


def _normalized_etag(value: str) -> str:
    normalized = value.strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    return normalized.strip('"')


def download_verified_object(
    object_input: dict[str, Any],
    destination: Path,
) -> int:
    expected_size = object_input["sizeBytes"]
    expected_etag = object_input["etag"]
    request = urllib.request.Request(
        object_input["url"],
        method="GET",
        headers={
            "User-Agent": "Program-Cue-File-Scanner/1",
            "X-Program-Cue-Expected-Size": str(expected_size),
            "X-Program-Cue-Expected-Etag": expected_etag,
        },
    )
    opener = urllib.request.build_opener(NoRedirect())
    started = time.monotonic()
    try:
        with opener.open(request, timeout=60) as response:
            if response.status != 200:
                raise ObjectFetchError("R2 returned a non-success status.")
            content_length = response.headers.get("Content-Length", "")
            if not content_length.isdigit() or int(content_length) != expected_size:
                raise ObjectFetchError("R2 returned an unexpected object size.")
            response_etag = response.headers.get("ETag", "")
            if not response_etag or _normalized_etag(response_etag) != _normalized_etag(
                expected_etag
            ):
                raise ObjectFetchError("R2 returned an unexpected object ETag.")
            total = 0
            with destination.open("xb") as output:
                os.chmod(destination, 0o600)
                while True:
                    if time.monotonic() - started > DOWNLOAD_TIMEOUT_SECONDS:
                        raise ObjectFetchError("The R2 object download timed out.")
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > expected_size or total > MAX_FILE_BYTES:
                        raise ObjectFetchError("R2 returned too many object bytes.")
                    output.write(chunk)
            if total != expected_size:
                raise ObjectFetchError("R2 returned an incomplete object.")
            return total
    except ObjectFetchError:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise ObjectFetchError("The R2 object could not be downloaded.") from error


def parse_clamdscan_output(
    return_code: int,
    output: str,
    scanned_bytes: int,
    duration_ms: int,
    version_output: str,
) -> dict[str, Any]:
    version_parts = version_output.strip().split("/", 2)
    engine_version = version_parts[0].removeprefix("ClamAV ").strip()
    signature_version = "/".join(version_parts[1:]).strip()
    if not engine_version or not signature_version:
        raise ClamScanError("ClamAV did not report its engine and signature versions.")
    base = {
        "engine": "clamav",
        "engineVersion": engine_version[:80],
        "signatureVersion": signature_version[:160],
        "scannedBytes": scanned_bytes,
        "durationMs": duration_ms,
    }
    if return_code == 0 and any(line.rstrip().endswith(": OK") for line in output.splitlines()):
        return {"verdict": "clean", **base}
    if return_code == 1:
        threats = []
        for line in output.splitlines():
            match = re.search(r": (.+) FOUND$", line.rstrip())
            if match and match.group(1) not in threats:
                threats.append(match.group(1)[:200])
        if threats:
            return {"verdict": "infected", **base, "threats": threats[:20]}
    raise ClamScanError("ClamAV did not produce a supported verdict.")


def scan_file(path: Path, scanned_bytes: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        version = subprocess.run(
            ["clamdscan", "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        completed = subprocess.run(
            [
                "clamdscan",
                "--config-file=/etc/clamav/clamd.conf",
                "--fdpass",
                "--no-summary",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=SCAN_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ClamScanError("ClamAV execution failed.") from error
    duration_ms = int((time.monotonic() - started) * 1000)
    return parse_clamdscan_output(
        completed.returncode,
        f"{completed.stdout}\n{completed.stderr}",
        scanned_bytes,
        duration_ms,
        version.stdout,
    )


def execute_scan(payload: Any, expected_host: str, expected_bucket: str) -> dict[str, Any]:
    job = validate_scan_request(payload, expected_host, expected_bucket)
    SCAN_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix="scan-", dir=SCAN_DIRECTORY)
    os.close(descriptor)
    path = Path(temporary_name)
    path.unlink()
    try:
        scanned_bytes = download_verified_object(job["object"], path)
        return scan_file(path, scanned_bytes)
    finally:
        path.unlink(missing_ok=True)


class ScannerHandler(BaseHTTPRequestHandler):
    server_version = "ProgramCueScanner/1"
    sys_version = ""

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/", "/health", "/ping"}:
            self._json(404, {"error": "Not found."})
            return
        if self.path == "/ping":
            self._json(200, {"status": "alive"})
            return
        if not clamav_ready():
            self._json(503, {"status": "starting"})
            return
        self._json(200, {"status": "ok", "engine": "clamav"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/scan":
            self._json(404, {"error": "Not found."})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._json(415, {"error": "Content-Type must be application/json."})
            return
        content_length = self.headers.get("Content-Length", "")
        if not content_length.isdigit() or int(content_length) > MAX_REQUEST_BYTES:
            self._json(413, {"error": "Request body is too large."})
            return
        if not SCAN_LOCK.acquire(blocking=False):
            self._json(503, {"error": "The scanner is busy; retry this job."})
            return
        try:
            if not wait_for_clamav():
                self._json(503, {"error": "ClamAV is not ready."})
                return
            try:
                raw_body = self.rfile.read(int(content_length))
                payload = json.loads(raw_body.decode("utf-8"))
                result = execute_scan(
                    payload,
                    os.environ.get("EXPECTED_R2_HOST", ""),
                    os.environ.get("EXPECTED_R2_BUCKET", ""),
                )
                self._json(200, result)
            except (ContractError, UnicodeError, json.JSONDecodeError):
                self._json(400, {"error": "The scan job is invalid."})
            except ObjectFetchError as error:
                print(
                    json.dumps(
                        {
                            "level": "error",
                            "subsystem": "file-scanner-container",
                            "event": "object-fetch-failed",
                            "message": str(error),
                        },
                        separators=(",", ":"),
                    ),
                    flush=True,
                )
                self._json(422, {"error": "The private object could not be verified."})
            except ClamScanError:
                self._json(503, {"error": "ClamAV could not produce a verdict."})
            except Exception as error:  # fail closed; do not disclose object URLs
                print(
                    json.dumps(
                        {
                            "level": "error",
                            "subsystem": "clamav-container",
                            "event": "scan-failed",
                            "errorName": type(error).__name__[:80],
                            "message": "The container scan failed.",
                        }
                    ),
                    flush=True,
                )
                self._json(500, {"error": "The container scan failed."})
        finally:
            SCAN_LOCK.release()

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    expected_host = os.environ.get("EXPECTED_R2_HOST", "")
    expected_bucket = os.environ.get("EXPECTED_R2_BUCKET", "")
    if not re.fullmatch(r"[0-9a-f]{32}\.r2\.cloudflarestorage\.com", expected_host):
        raise SystemExit("EXPECTED_R2_HOST is missing or invalid.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", expected_bucket):
        raise SystemExit("EXPECTED_R2_BUCKET is missing or invalid.")
    server = ThreadingHTTPServer(("0.0.0.0", 8080), ScannerHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()

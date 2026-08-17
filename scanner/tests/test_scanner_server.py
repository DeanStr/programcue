import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "container" / "scanner_server.py"
SPEC = importlib.util.spec_from_file_location("program_cue_scanner_server", MODULE_PATH)
scanner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(scanner)


class ScannerServerContractTests(unittest.TestCase):
    host = "327c60945460c16be8ecdbbc7fa35447.r2.cloudflarestorage.com"
    bucket = "program-cue-files"

    def setUp(self):
        # A ready scan keeps the process-wide lock as it exits. Isolate each
        # test so that one-shot shutdown cannot leak capacity into later cases.
        patcher = mock.patch.object(
            scanner,
            "SCAN_LOCK",
            scanner.threading.BoundedSemaphore(1),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def job(self):
        return {
            "jobId": "file-scan-dispatch:version-1",
            "object": {
                "url": (
                    f"https://{self.host}/{self.bucket}/private/object"
                    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"
                ),
                "sizeBytes": 1024,
                "etag": '"etag-1"',
            },
        }

    def test_accepts_exact_private_r2_boundary(self):
        self.assertEqual(
            scanner.validate_scan_request(self.job(), self.host, self.bucket),
            self.job(),
        )

    def test_rejects_cross_account_object_url(self):
        job = self.job()
        job["object"]["url"] = job["object"]["url"].replace(
            self.host, "attacker.example"
        )
        with self.assertRaises(scanner.ContractError):
            scanner.validate_scan_request(job, self.host, self.bucket)

    def test_parses_clean_and_infected_clamav_verdicts(self):
        clean = scanner.parse_clamdscan_output(
            0,
            "/tmp/scan: OK\n",
            1024,
            20,
            "ClamAV 1.4.6/28087/Sun Aug  9 06:24:56 2026\n",
        )
        self.assertEqual(clean["verdict"], "clean")
        self.assertEqual(clean["engineVersion"], "1.4.6")

        infected = scanner.parse_clamdscan_output(
            1,
            "/tmp/scan: Win.Test.EICAR_HDB-1 FOUND\n",
            1024,
            20,
            "ClamAV 1.4.6/28087/Sun Aug  9 06:24:56 2026\n",
        )
        self.assertEqual(infected["verdict"], "infected")
        self.assertEqual(infected["threats"], ["Win.Test.EICAR_HDB-1"])

    def test_rejects_ambiguous_clamav_output(self):
        with self.assertRaises(scanner.ClamScanError):
            scanner.parse_clamdscan_output(
                2,
                "scan failed",
                1024,
                20,
                "ClamAV 1.4.6/28087/Sun Aug  9 06:24:56 2026\n",
            )

    def test_clamav_readiness_requires_marker_and_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            readiness_file = pathlib.Path(directory) / "ready"
            socket_file = pathlib.Path(directory) / "clamd.sock"
            with (
                mock.patch.object(scanner, "READINESS_FILE", readiness_file),
                mock.patch.object(scanner, "Path", side_effect=lambda value: {
                    "/run/clamav/clamd.sock": socket_file,
                    "/tmp/clamd.sock": socket_file,
                }.get(value, pathlib.Path(value))),
            ):
                self.assertFalse(scanner.clamav_ready())
                readiness_file.touch()
                self.assertFalse(scanner.clamav_ready())
                socket_file.touch()
                self.assertTrue(scanner.clamav_ready())

    def test_download_passes_exact_identity_to_r2_binding_proxy(self):
        object_input = self.job()["object"]
        object_input["sizeBytes"] = 4
        object_input["etag"] = '"etag-1"'
        response = io.BytesIO(b"safe")
        response.status = 200
        response.headers = {"Content-Length": "4", "ETag": '"etag-1"'}
        opener = mock.Mock()
        opener.open.return_value = response

        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "object"
            with mock.patch.object(scanner, "build_object_opener", return_value=opener):
                self.assertEqual(
                    scanner.download_verified_object(object_input, destination),
                    4,
                )
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_header("X-program-cue-expected-size"), "4")
            self.assertEqual(
                request.get_header("X-program-cue-expected-etag"), '"etag-1"'
            )

    def test_object_opener_fails_closed_without_interception_ca(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(
                scanner,
                "INTERCEPTION_CA",
                pathlib.Path(directory) / "missing-ca.crt",
            ),
        ):
            with self.assertRaisesRegex(
                scanner.ObjectFetchError,
                "trusted R2 proxy CA is unavailable",
            ):
                scanner.build_object_opener()

    def test_ping_is_liveness_while_health_is_readiness(self):
        handler = object.__new__(scanner.ScannerHandler)
        handler._json = mock.Mock()

        handler.path = "/ping"
        with mock.patch.object(scanner, "clamav_ready") as ready:
            handler.do_GET()
            handler._json.assert_called_once_with(200, {"status": "alive"})
            ready.assert_not_called()

        handler._json.reset_mock()
        handler.path = "/health"
        with mock.patch.object(scanner, "clamav_ready", return_value=False):
            handler.do_GET()
            handler._json.assert_called_once_with(503, {"status": "starting"})

    def test_busy_scan_is_an_explicit_retryable_capacity_response(self):
        handler = object.__new__(scanner.ScannerHandler)
        handler._json = mock.Mock()
        handler.path = "/scan"
        handler.headers = {
            "Content-Type": "application/json",
            "Content-Length": "2",
        }

        with mock.patch.object(scanner.SCAN_LOCK, "acquire", return_value=False):
            handler.do_POST()

        handler._json.assert_called_once_with(
            503,
            {
                "code": "scanner_busy",
                "error": "The scanner is busy; retry this job.",
            },
            {"Retry-After": "15"},
        )

    def test_unready_scan_returns_capacity_without_holding_the_request(self):
        handler = object.__new__(scanner.ScannerHandler)
        handler._json = mock.Mock()
        handler.path = "/scan"
        handler.headers = {
            "Content-Type": "application/json",
            "Content-Length": "2",
        }

        with mock.patch.object(scanner, "clamav_ready", return_value=False):
            handler.do_POST()

        handler._json.assert_called_once_with(
            503,
            {
                "code": "scanner_not_ready",
                "error": "ClamAV is not ready.",
            },
            {"Retry-After": "15"},
        )
        self.assertTrue(scanner.SCAN_LOCK.acquire(blocking=False))
        scanner.SCAN_LOCK.release()

    def test_ready_scan_shuts_down_container_after_response(self):
        handler = object.__new__(scanner.ScannerHandler)
        handler._json = mock.Mock()
        handler.path = "/scan"
        handler.headers = {
            "Content-Type": "application/json",
            "Content-Length": "2",
        }
        handler.rfile = io.BytesIO(b"{}")
        handler.server = mock.Mock()
        verdict = {
            "verdict": "clean",
            "engine": "clamav",
            "engineVersion": "1.4.6",
            "signatureVersion": "28087/Sun Aug 9 06:24:56 2026",
            "scannedBytes": 4,
            "durationMs": 20,
        }

        with (
            mock.patch.object(scanner, "clamav_ready", return_value=True),
            mock.patch.object(scanner, "execute_scan", return_value=verdict),
            mock.patch.object(scanner, "shutdown_server") as shutdown,
        ):
            handler.do_POST()

        handler._json.assert_called_once_with(200, verdict)
        shutdown.assert_called_once_with(
            handler.server,
            "scan_request_finished",
        )
        self.assertFalse(
            scanner.SCAN_LOCK.acquire(blocking=False),
            "an admitted scan must keep the lock while the instance exits",
        )

    def test_ready_scan_stops_the_real_http_server(self):
        server = scanner.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            scanner.ScannerHandler,
        )
        server_thread = scanner.threading.Thread(target=server.serve_forever)
        server_thread.start()
        verdict = {
            "verdict": "clean",
            "engine": "clamav",
            "engineVersion": "1.4.6",
            "signatureVersion": "28087/Sun Aug 9 06:24:56 2026",
            "scannedBytes": 4,
            "durationMs": 20,
        }
        request = scanner.urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/scan",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with (
                mock.patch.object(scanner, "clamav_ready", return_value=True),
                mock.patch.object(scanner, "execute_scan", return_value=verdict),
                scanner.urllib.request.urlopen(request, timeout=2) as response,
            ):
                self.assertEqual(json.loads(response.read()), verdict)
            server_thread.join(timeout=2)
            self.assertFalse(server_thread.is_alive())
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)

    def test_lifetime_guard_is_daemonized_and_started(self):
        server = mock.Mock()
        timer = mock.Mock()
        with mock.patch.object(scanner.threading, "Timer", return_value=timer) as factory:
            self.assertIs(scanner.start_lifetime_guard(server), timer)

        factory.assert_called_once_with(
            scanner.MAX_CONTAINER_LIFETIME_SECONDS,
            scanner.shutdown_server,
            args=(server, "maximum_lifetime"),
        )
        self.assertTrue(timer.daemon)
        timer.start.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

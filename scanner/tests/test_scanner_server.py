import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "container" / "scanner_server.py"
SPEC = importlib.util.spec_from_file_location("program_cue_scanner_server", MODULE_PATH)
scanner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(scanner)


class ScannerServerContractTests(unittest.TestCase):
    host = "327c60945460c16be8ecdbbc7fa35447.r2.cloudflarestorage.com"
    bucket = "program-cue-files"

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
            "ClamAV 1.4.5/27720/Mon Aug 11 08:00:00 2026\n",
        )
        self.assertEqual(clean["verdict"], "clean")
        self.assertEqual(clean["engineVersion"], "1.4.5")

        infected = scanner.parse_clamdscan_output(
            1,
            "/tmp/scan: Win.Test.EICAR_HDB-1 FOUND\n",
            1024,
            20,
            "ClamAV 1.4.5/27720/Mon Aug 11 08:00:00 2026\n",
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
                "ClamAV 1.4.5/27720/Mon Aug 11 08:00:00 2026\n",
            )


if __name__ == "__main__":
    unittest.main()

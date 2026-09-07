import { validateScan } from "./scan-receipt.mjs";
import { isDeepStrictEqual } from "node:util";
export function mailVerdict(receipt, expected) {
  if (
    receipt.version !== 1 ||
    typeof receipt.received !== "boolean" ||
    !Array.isArray(receipt.checks) ||
    !isDeepStrictEqual(
      receipt.checks.map((check) => check.expected),
      expected.bodyIncludes,
    ) ||
    receipt.checks.some((check) => typeof check.present !== "boolean")
  )
    throw new Error("Invalid local mail receipt");
  return receipt.received && receipt.checks.every((check) => check.present) ? "pass" : "fail";
}
export function zipVerdict(entries, expected) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry.sha256 !== "string"))
    throw new Error("Invalid ZIP inspection result");
  const files = entries.filter((entry) => !entry.name.endsWith("/"));
  return files.length === 1 && files[0].sha256 === expected.latestSha256 ? "pass" : "fail";
}

export function scanVerdict(receipt, expected) {
  if (
    receipt.version !== 1 ||
    receipt.source !== "isolated-local-r2-and-real-clamav" ||
    !Array.isArray(receipt.scans)
  )
    throw new Error("Invalid local scan receipt");
  receipt.scans.forEach(validateScan);
  const required = [expected.previousSha256, expected.latestSha256];
  return receipt.scans.length === 2 &&
    new Set(receipt.scans.map((scan) => scan.versionId)).size === 2 &&
    required.every((hash) =>
      receipt.scans.some(
        (scan) =>
          scan.sha256 === hash &&
          scan.verdict === "clean" &&
          scan.engine === "clamav" &&
          scan.engineVersion.length > 0 &&
          scan.signatureVersion.length > 0 &&
          scan.scannedBytes > 0 &&
          scan.scannedBytes === scan.object.sizeBytes &&
          scan.object.etag.length > 0 &&
          scan.object.key.startsWith("private/") &&
          scan.callbackStatus === 200,
      ),
    )
    ? "pass"
    : "fail";
}

const digest = /^[a-f0-9]{64}$/;

export function validateScan(scan) {
  if (
    !scan ||
    !digest.test(scan.sha256) ||
    typeof scan.versionId !== "string" ||
    typeof scan.verdict !== "string" ||
    typeof scan.engine !== "string" ||
    typeof scan.engineVersion !== "string" ||
    typeof scan.signatureVersion !== "string" ||
    !Number.isInteger(scan.scannedBytes) ||
    !Number.isInteger(scan.callbackStatus) ||
    !scan.object ||
    typeof scan.object.key !== "string" ||
    typeof scan.object.etag !== "string" ||
    !Number.isInteger(scan.object.sizeBytes) ||
    (scan.threats !== undefined &&
      (!Array.isArray(scan.threats) || scan.threats.some((threat) => typeof threat !== "string")))
  )
    throw new Error("Malformed local scan evidence");
}

import { validateScan } from "./scan-receipt.mjs";
export const localOrigin = "http://127.0.0.1:5188";
const digest = /^[a-f0-9]{64}$/;

export function privateDownloadUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== localOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/admin\/content\/files\/[a-f0-9-]{36}\/versions\/[a-f0-9-]{36}$/.test(url.pathname)
  )
    throw new Error("File access probes require an observed isolated-local private download URL");
  return url;
}

export function validateAccessReceipt(receipt) {
  if (
    receipt.version !== 1 ||
    receipt.source !== "isolated-local-file-access" ||
    !Array.isArray(receipt.scans) ||
    receipt.anonymousCookiesBefore !== 0 ||
    !receipt.history ||
    receipt.history.ok !== true ||
    !Array.isArray(receipt.history.versions)
  )
    throw new Error("Invalid local file access receipt");
  const url = privateDownloadUrl(receipt.cleanUrl);
  for (const name of ["clean", "infected", "anonymous"]) {
    const response = receipt.responses?.[name];
    if (
      !response ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 599 ||
      !Number.isInteger(response.bytes) ||
      response.bytes < 0 ||
      !digest.test(response.sha256) ||
      typeof response.path !== "string" ||
      !(response.location === null || typeof response.location === "string")
    )
      throw new Error(`Malformed ${name} HTTP evidence`);
    if (response.status >= 500)
      throw new Error(`${name} probe received a server error: ${response.status}`);
  }
  for (const version of receipt.history.versions) {
    if (
      typeof version.id !== "string" ||
      !Number.isInteger(version.versionNumber) ||
      typeof version.current !== "boolean" ||
      typeof version.scanStatus !== "string"
    )
      throw new Error("Malformed file version history");
  }
  receipt.scans.forEach(validateScan);
  if (
    receipt.responses.clean.path !== url.pathname ||
    receipt.responses.anonymous.path !== url.pathname
  )
    throw new Error("Anonymous probe and authenticated control must address the same private file");
}

function cleanControl(receipt, expected) {
  return (
    receipt.responses.clean.status === 200 &&
    receipt.responses.clean.sha256 === expected.cleanSha256
  );
}

function validateExpected(expected) {
  if (
    !digest.test(expected.cleanSha256) ||
    !digest.test(expected.eicarSha256) ||
    expected.cleanSha256 === expected.eicarSha256 ||
    !Number.isInteger(expected.eicarBytes) ||
    expected.eicarBytes <= 0
  )
    throw new Error("Invalid independent file access expectations");
}

export function quarantineVerdict(receipt, expected) {
  validateExpected(expected);
  validateAccessReceipt(receipt);
  const infected = receipt.history.versions.find((version) => version.versionNumber === 3);
  const clean = receipt.history.versions.find(
    (version) => version.id === receipt.cleanUrl.split("/").at(-1),
  );
  const scans = receipt.scans.filter((scan) => scan.sha256 === expected.eicarSha256);
  if (scans.length === 0) return "cannot_judge";
  if (scans.length !== 1 || !infected || !clean) return "fail";
  const scan = scans[0];
  const infectedPath = new URL(receipt.cleanUrl).pathname.replace(/[^/]+$/, infected.id);
  return scan.verdict === "infected" &&
    scan.versionId === infected.id &&
    scan.engine === "clamav" &&
    scan.engineVersion.length > 0 &&
    scan.signatureVersion.length > 0 &&
    scan.scannedBytes === expected.eicarBytes &&
    scan.object.sizeBytes === expected.eicarBytes &&
    scan.object.key.startsWith("private/") &&
    scan.object.key.endsWith(
      `/${new URL(receipt.cleanUrl).pathname.split("/")[4]}/${infected.id}`,
    ) &&
    scan.object.etag.length > 0 &&
    scan.threats?.some((threat) => threat.includes("Eicar")) &&
    scan.callbackStatus === 200 &&
    infected.scanStatus === "infected" &&
    !infected.current &&
    clean.versionNumber === 2 &&
    clean.current &&
    receipt.history.versions.filter((version) => version.current).length === 1 &&
    clean.scanStatus === "clean" &&
    cleanControl(receipt, expected) &&
    receipt.responses.infected.path === infectedPath &&
    receipt.responses.infected.status === 404 &&
    receipt.responses.infected.sha256 !== expected.eicarSha256
    ? "pass"
    : "fail";
}

export function anonymousVerdict(receipt, expected) {
  validateExpected(expected);
  validateAccessReceipt(receipt);
  if (!cleanControl(receipt, expected)) return "cannot_judge";
  const response = receipt.responses.anonymous;
  if (response.sha256 === expected.cleanSha256) return "fail";
  return deniesPrivateDownload(response, receipt.cleanUrl) ? "pass" : "fail";
}

export function deniesPrivateDownload(response, cleanUrl) {
  const target = privateDownloadUrl(cleanUrl);
  if (response.status >= 500)
    throw new Error(`Anonymous probe received a server error: ${response.status}`);
  if ([401, 403, 404].includes(response.status)) return true;
  if ([302, 303, 307, 308].includes(response.status) && response.location !== null) {
    const location = new URL(response.location, localOrigin);
    return (
      location.origin === localOrigin &&
      location.pathname === "/demo" &&
      location.searchParams.get("returnTo") === target.pathname
    );
  }
  return false;
}

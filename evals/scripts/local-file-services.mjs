import { setTimeout as delay } from "node:timers/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { presignR2S3Request } from "../../app/modules/files/r2-s3-signing.server.ts";
import {
  verifyScannerDispatch,
  signScannerCallback,
  scannerCallbackRequestInit,
  SCANNER_PROVIDER,
} from "../../scanner/src/contract.ts";

const execute = promisify(execFile);
export const s3Host = "00000000000000000000000000000000.r2.cloudflarestorage.com";
export const callbackUrl = "https://programcue-eval.invalid/api/webhooks/file-scanner";
export const scannerUrl = "https://scanner-eval.invalid/v1/scans";
const MAX_BYTES = 10 * 1024 * 1024;

// Uses the production scanner's actual clamdscan invocation and verdict parser.
// Docker has no network; the image must already contain a fresh signature DB.
export async function scanBytes(container, bytes) {
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new Error("Local scan size exceeds its 10 MiB smoke boundary");
  const script = `import sys,tempfile,json,os\nfrom pathlib import Path\nsys.path.insert(0,'/opt/program-cue-scanner')\nfrom scanner_server import scan_file,clamav_ready\nassert clamav_ready(), 'ClamAV is not ready with fresh signatures'\nf=tempfile.NamedTemporaryFile(delete=False)\ntry:\n data=sys.stdin.buffer.read(${MAX_BYTES + 1})\n assert 0 < len(data) <= ${MAX_BYTES}\n f.write(data); f.close()\n print(json.dumps(scan_file(Path(f.name),len(data))))\nfinally:\n os.unlink(f.name)\n`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", "-i", "--user", "clamav", container, "python3", "-c", script],
      { timeout: 60_000, maxBuffer: 16_384 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(bytes);
  });
}

export async function waitForClamav(container, { signal, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      await execute("docker", ["exec", container, "test", "-f", "/tmp/program-cue-scanner-ready"], {
        timeout: Math.min(5000, deadline - Date.now()),
        signal,
      });
      return;
    } catch (error) {
      // Only test(1)'s missing readiness file is a retryable startup condition.
      // Docker failures carry diagnostics; timeouts and spawn failures are fatal.
      if (error.code !== 1 || error.stderr?.trim())
        throw new Error(`ClamAV readiness command failed: ${error.message}`, { cause: error });
      await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
  }
  throw new Error(
    "ClamAV readiness file is still absent; inspect container logs and signature freshness",
  );
}

export function createLocalFileServices({ env, container, getBucket, dispatchCallback, record }) {
  const parts = new Map();
  const jobs = new Map();
  const failures = [];
  const failure = Promise.withResolvers();
  async function s3(request) {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.host !== s3Host ||
      !["GET", "PUT"].includes(request.method)
    )
      return new Response("Unsupported local S3 request", { status: 403 });
    const prefix = `/${env.R2_BUCKET_NAME}/`;
    const key = url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : "";
    const stamp = url.searchParams.get("X-Amz-Date") ?? "";
    if (!key.startsWith("private/") || !/^\d{8}T\d{6}Z$/.test(stamp))
      return new Response("Invalid object authority", { status: 403 });
    const date = new Date(
      stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
    );
    const expiry = Number(url.searchParams.get("X-Amz-Expires"));
    if (
      !Number.isFinite(date.getTime()) ||
      Date.now() < date.getTime() - 30_000 ||
      Date.now() > date.getTime() + expiry * 1000
    )
      return new Response("Expired object authority", { status: 403 });
    const query = Object.fromEntries(
      [...url.searchParams].filter(([key]) => !key.startsWith("X-Amz-")),
    );
    const expected = await presignR2S3Request({
      env,
      method: request.method,
      objectKey: key,
      query,
      expiresSeconds: expiry,
      now: date,
    });
    const supplied = Buffer.from(url.toString());
    const signed = Buffer.from(expected);
    if (supplied.length !== signed.length || !timingSafeEqual(supplied, signed))
      return new Response("Invalid signature", { status: 403 });
    const uploadId = query.uploadId;
    if (!uploadId) return new Response("Missing upload", { status: 400 });
    const mapKey = JSON.stringify([key, uploadId]);
    const manifest = parts.get(mapKey) ?? new Map();
    if (request.method === "PUT") {
      const partNumber = Number(query.partNumber);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 1000)
        return new Response("Invalid part", { status: 400 });
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
        return new Response("Invalid part size", { status: 413 });
      const bucket = await getBucket();
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes);
      manifest.set(partNumber, { etag: part.etag, size: bytes.byteLength });
      parts.set(mapKey, manifest);
      record({ type: "r2-part", key, partNumber, size: bytes.byteLength, etag: part.etag });
      return new Response(null, { headers: { etag: `"${part.etag}"` } });
    }
    // R2's binding has no ListParts API. This isolated S3 adapter retains only
    // parts acknowledged by real R2 uploadPart; it never invents object bytes.
    const xml = [...manifest]
      .sort(([a], [b]) => a - b)
      .map(
        ([number, part]) =>
          `<Part><PartNumber>${number}</PartNumber><Size>${part.size}</Size><ETag>${part.etag}</ETag></Part>`,
      )
      .join("");
    return new Response(
      `<ListPartsResult><IsTruncated>false</IsTruncated>${xml}</ListPartsResult>`,
      { headers: { "content-type": "application/xml" } },
    );
  }
  async function scan(job) {
    const bucket = await getBucket();
    const object = await bucket.get(job.object.key);
    if (!object || object.size !== job.object.sizeBytes || object.httpEtag !== job.object.etag)
      throw new Error("Scanner object identity does not match the signed job");
    const bytes = Buffer.from(await object.arrayBuffer());
    const result = await scanBytes(container, bytes);
    const rawBody = JSON.stringify({
      jobId: job.jobId,
      attempt: job.attempt,
      organisationId: job.organisationId,
      eventId: job.eventId,
      versionId: job.versionId,
      assetId: job.assetId,
      object: job.object,
      provider: SCANNER_PROVIDER,
      verdict: result.verdict,
      result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== "verdict")),
    });
    const signed = await signScannerCallback({
      callbackId: `local-${job.versionId}-${job.attempt}`,
      rawBody,
      secret: env.FILE_SCANNER_WEBHOOK_SECRET,
    });
    const response = await dispatchCallback(
      callbackUrl,
      scannerCallbackRequestInit({ rawBody, signed }),
    );
    if (!response.ok)
      throw new Error(`Scanner callback rejected: ${response.status} ${await response.text()}`);
    await response.arrayBuffer();
    record({
      type: "scan",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      versionId: job.versionId,
      object: job.object,
      ...result,
      callbackStatus: response.status,
    });
  }
  async function scanner(request) {
    const rawBody = await request.text();
    if (rawBody.length > 24_000) return new Response("Too large", { status: 413 });
    let job;
    try {
      job = await verifyScannerDispatch({
        rawBody,
        headers: request.headers,
        secret: env.FILE_SCANNER_DISPATCH_SECRET,
        configuration: { callbackUrl },
      });
    } catch {
      return new Response("Invalid dispatch", { status: 401 });
    }
    const id = `${job.jobId}:attempt:${job.attempt}`;
    if (request.headers.get("idempotency-key") !== id)
      return new Response("Invalid attempt", { status: 400 });
    if (!jobs.has(id)) {
      // Accept first, then let the actual scan/callback complete asynchronously.
      const work = new Promise((resolve) => setTimeout(resolve, 20))
        .then(() => scan(job))
        .catch((error) => {
          failures.push(error);
          failure.resolve(error);
          record({ type: "scan-error", versionId: job.versionId, error: error.message });
        });
      jobs.set(id, work);
    }
    return Response.json(
      { accepted: true, jobId: job.jobId, attempt: job.attempt },
      { status: 202 },
    );
  }
  return {
    s3,
    scanner,
    failure: failure.promise,
    async drain() {
      await Promise.all(jobs.values());
      if (failures.length) throw new AggregateError(failures, "Local scanning failed");
    },
  };
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Container, ContainerProxy } from "@cloudflare/containers";
import { z } from "zod";

import {
  classifyScannerContainerFailure,
  MAX_SCANNER_REQUEST_BYTES,
  SCANNER_BUSY_ATTEMPT_LIMIT,
  SCANNER_PROVIDER,
  type ScannerContainerFailure,
  type ScannerContractConfiguration,
  type ScannerJob,
  scannerCapacityDelaySeconds,
  scannerCapacityShouldWait,
  scannerContainerInstanceName,
  scannerWorkflowDuplicateStatusIsAcceptable,
  signScannerCallback,
  validateScannerJob,
  verifyScannerDispatch,
  workflowInstanceId,
} from "./contract";

export { ContainerProxy };

interface ScannerEnvironment {
  CLAMAV: DurableObjectNamespace<FileScannerContainer>;
  FILES: R2Bucket;
  FILE_SCAN_WORKFLOW: Workflow<ScannerJob>;
  APP_ENV?: string;
  EXPECTED_CALLBACK_URL?: string;
  R2_BUCKET_NAME?: string;
  R2_OBJECT_HOST?: string;
  PROGRAM_CUE_DISPATCH_SECRET?: string;
  PROGRAM_CUE_CALLBACK_SECRET?: string;
  SOURCE_REVISION?: string;
}

const containerScanResultSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      verdict: z.literal("clean"),
      engine: z.literal("clamav"),
      engineVersion: z.string().min(1).max(80),
      signatureVersion: z.string().min(1).max(160),
      scannedBytes: z.number().int().positive(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      verdict: z.literal("infected"),
      engine: z.literal("clamav"),
      engineVersion: z.string().min(1).max(80),
      signatureVersion: z.string().min(1).max(160),
      scannedBytes: z.number().int().positive(),
      durationMs: z.number().int().nonnegative(),
      threats: z.array(z.string().min(1).max(200)).min(1).max(20),
    })
    .strict(),
]);

type ContainerScanResult = z.infer<typeof containerScanResultSchema>;

type ContainerScanAttempt =
  | { kind: "verdict"; result: ContainerScanResult }
  | ScannerContainerFailure;

interface ScannerRuntime {
  callbackSecret: string;
  contract: ScannerContractConfiguration;
  dispatchSecret: string;
  sourceRevision: string;
}

const SCAN_ATTEMPT_STEP = {
  retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
  timeout: "30 minutes",
} as const;
const CALLBACK_STEP = {
  retries: { limit: 8, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class FileScannerContainer extends Container<ScannerEnvironment> {
  defaultPort = 8080;
  interceptHttps = true;
  pingEndpoint = "scanner/ping";
  sleepAfter = "5m";
  enableInternet = false;
  allowedHosts = [
    this.env.R2_OBJECT_HOST ?? "invalid.invalid",
    "database.clamav.net",
  ];
  envVars = {
    EXPECTED_R2_HOST: this.env.R2_OBJECT_HOST ?? "",
    EXPECTED_R2_BUCKET: this.env.R2_BUCKET_NAME ?? "",
    CLAMD_CONF_MaxFileSize: "1100M",
    CLAMD_CONF_MaxScanSize: "1100M",
    CLAMD_CONF_StreamMaxLength: "1100M",
    CLAMD_CONF_MaxScanTime: "720000",
    CLAMD_CONF_AlertExceedsMax: "yes",
    CLAMD_CONF_AlertEncrypted: "yes",
    CLAMAV_NO_FRESHCLAMD: "true",
  };
}

FileScannerContainer.outbound = async (request, environment) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const scannerEnvironment = environment as unknown as ScannerEnvironment;
  const url = new URL(request.url);
  if (url.hostname === scannerEnvironment.R2_OBJECT_HOST) {
    const bucketPrefix = `/${scannerEnvironment.R2_BUCKET_NAME}/`;
    if (!url.pathname.startsWith(bucketPrefix)) {
      return new Response("Not found.", { status: 404 });
    }
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(bucketPrefix.length));
    } catch {
      return new Response("Invalid object key.", { status: 400 });
    }
    if (!key.startsWith("private/")) {
      return new Response("Forbidden.", { status: 403 });
    }
    const object = await scannerEnvironment.FILES.get(key);
    if (!object) {
      structuredLog("warning", "r2-proxy-rejected", {
        reason: "object_missing",
      });
      return new Response("Not found.", { status: 404 });
    }
    const expectedSize = request.headers.get("x-program-cue-expected-size");
    const expectedEtag = request.headers.get("x-program-cue-expected-etag");
    const sizeMatches = expectedSize === String(object.size);
    const etagMatches =
      expectedEtag?.replace(/^W\//u, "").replaceAll('"', "") === object.etag;
    if (!sizeMatches || !etagMatches) {
      structuredLog("warning", "r2-proxy-rejected", {
        reason: "object_identity_mismatch",
        expectedSizePresent: expectedSize !== null,
        expectedEtagPresent: expectedEtag !== null,
        sizeMatches,
        etagMatches,
      });
      return new Response("Object identity mismatch.", { status: 412 });
    }
    structuredLog("info", "r2-proxy-served", {
      method: request.method,
      sizeBytes: object.size,
    });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "content-length": String(object.size),
        etag: object.httpEtag,
        "x-program-cue-object-verified": "r2-binding-v1",
      },
    });
  }
  return fetch(request);
};

function requiredValue(
  value: string | undefined,
  name: string,
  minimumLength = 1,
) {
  const normalized = value?.trim() ?? "";
  if (normalized.length < minimumLength) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return normalized;
}

function requireRuntime(environment: ScannerEnvironment): ScannerRuntime {
  if (environment.APP_ENV !== "production") {
    throw new Error("The file scanner requires APP_ENV=production.");
  }
  const callbackUrl = requiredValue(
    environment.EXPECTED_CALLBACK_URL,
    "EXPECTED_CALLBACK_URL",
  );
  const r2BucketName = requiredValue(
    environment.R2_BUCKET_NAME,
    "R2_BUCKET_NAME",
  );
  const r2ObjectHost = requiredValue(
    environment.R2_OBJECT_HOST,
    "R2_OBJECT_HOST",
  );
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(r2BucketName) ||
    !/^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/u.test(r2ObjectHost)
  ) {
    throw new Error("The private R2 scanner boundary is invalid.");
  }
  const sourceRevision = requiredValue(
    environment.SOURCE_REVISION,
    "SOURCE_REVISION",
  );
  if (!/^[0-9a-f]{7,64}$/iu.test(sourceRevision)) {
    throw new Error("SOURCE_REVISION must be a Git revision.");
  }
  const callbackSecret = requiredValue(
    environment.PROGRAM_CUE_CALLBACK_SECRET,
    "PROGRAM_CUE_CALLBACK_SECRET",
    32,
  );
  const dispatchSecret = requiredValue(
    environment.PROGRAM_CUE_DISPATCH_SECRET,
    "PROGRAM_CUE_DISPATCH_SECRET",
    32,
  );
  if (callbackSecret === dispatchSecret) {
    throw new Error(
      "PROGRAM_CUE_CALLBACK_SECRET and PROGRAM_CUE_DISPATCH_SECRET must be independent.",
    );
  }
  return {
    callbackSecret,
    contract: { callbackUrl },
    dispatchSecret,
    sourceRevision,
  };
}

async function readBoundedText(request: Request, maximumBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new RangeError("Request body is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new RangeError("Request body is too large.");
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
) {
  return readBoundedText(
    new Request("https://scanner.internal/response", {
      method: "POST",
      headers: response.headers,
      body: response.body,
    }),
    maximumBytes,
  );
}

function scannerHeaders(headers?: HeadersInit) {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  output.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  output.set("referrer-policy", "no-referrer");
  output.set("x-content-type-options", "nosniff");
  return output;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = scannerHeaders(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function boundedErrorName(error: unknown) {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(candidate)
    ? candidate
    : "UnknownError";
}

function structuredLog(
  level: "info" | "warning" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  const record = JSON.stringify({
    level,
    subsystem: "file-scanner",
    event,
    ...details,
  });
  if (level === "error") console.error(record);
  else if (level === "warning") console.warn(record);
  else console.log(record);
}

async function scanInContainer(
  environment: ScannerEnvironment,
  job: ScannerJob,
): Promise<ContainerScanAttempt> {
  const instanceName = await scannerContainerInstanceName(
    job.jobId,
    job.attempt,
  );
  const container = environment.CLAMAV.getByName(instanceName);
  const objectUrl = new URL(
    `https://${requiredValue(environment.R2_OBJECT_HOST, "R2_OBJECT_HOST")}/${encodeURIComponent(requiredValue(environment.R2_BUCKET_NAME, "R2_BUCKET_NAME"))}/${encodeURIComponent(job.object.key)}`,
  );
  const response = await container.fetch("http://scanner/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId: job.jobId,
      object: {
        url: objectUrl.toString(),
        sizeBytes: job.object.sizeBytes,
        etag: job.object.etag,
      },
    }),
  });
  const rawBody = await readBoundedResponseText(response, 16_384);
  if (response.ok) {
    return {
      kind: "verdict",
      result: containerScanResultSchema.parse(JSON.parse(rawBody)),
    };
  }
  const failure = classifyScannerContainerFailure(response.status, rawBody);
  if (failure) return failure;
  // An unsupported container response is ambiguous and must be retried or
  // fail closed; it must never be interpreted as a scan verdict.
  throw new Error(`ClamAV container returned HTTP ${response.status}.`);
}

function callbackPayload(job: ScannerJob, scan: ContainerScanAttempt | null) {
  const base = {
    jobId: job.jobId,
    attempt: job.attempt,
    organisationId: job.organisationId,
    eventId: job.eventId,
    versionId: job.versionId,
    assetId: job.assetId,
    object: {
      key: job.object.key,
      etag: job.object.etag,
      sizeBytes: job.object.sizeBytes,
    },
    provider: SCANNER_PROVIDER,
  };
  if (!scan) {
    return {
      ...base,
      verdict: "error" as const,
      error: "The ClamAV scan could not be completed after retrying.",
      result: { engine: "clamav" },
    };
  }
  if (scan.kind === "terminal_error") {
    return {
      ...base,
      verdict: "error" as const,
      error: scan.error,
      result: { engine: "clamav", reason: scan.reason },
    };
  }
  if (scan.kind !== "verdict") {
    return {
      ...base,
      verdict: "error" as const,
      error:
        "Scanner capacity remained unavailable for the permitted wait window.",
      result: { engine: "clamav", reason: scan.code },
    };
  }
  const result = scan.result;
  return {
    ...base,
    verdict: result.verdict,
    result: {
      engine: result.engine,
      engineVersion: result.engineVersion,
      signatureVersion: result.signatureVersion,
      scannedBytes: result.scannedBytes,
      durationMs: result.durationMs,
      ...(result.verdict === "infected" ? { threats: result.threats } : {}),
    },
  };
}

async function deliverCallback(
  job: ScannerJob,
  payload: ReturnType<typeof callbackPayload>,
  callbackSecret: string,
  instanceId: string,
) {
  const rawBody = JSON.stringify(payload);
  const callbackId = `scanner-${instanceId}`;
  const signed = await signScannerCallback({
    callbackId,
    rawBody,
    secret: callbackSecret,
  });
  const response = await fetch(job.callback.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-program-cue-scanner-id": signed.callbackId,
      "x-program-cue-scanner-timestamp": signed.timestamp,
      "x-program-cue-scanner-signature": signed.signature,
    },
    body: rawBody,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Program Cue callback returned HTTP ${response.status}.`);
  }
  await response.body?.cancel().catch(() => undefined);
}

export class FileScanWorkflow extends WorkflowEntrypoint<
  ScannerEnvironment,
  ScannerJob
> {
  async run(event: Readonly<WorkflowEvent<ScannerJob>>, step: WorkflowStep) {
    const runtime = requireRuntime(this.env);
    const job = validateScannerJob(event.payload, runtime.contract);
    let scan: ContainerScanAttempt | null = null;
    let notReadyAttempt = 0;
    try {
      for (
        let capacityAttempt = 1;
        capacityAttempt <= SCANNER_BUSY_ATTEMPT_LIMIT;
        capacityAttempt += 1
      ) {
        const result = await step.do(
          `scan quarantined R2 object attempt ${capacityAttempt}`,
          SCAN_ATTEMPT_STEP,
          () => scanInContainer(this.env, job),
        );
        if (result.kind !== "capacity_wait") {
          scan = result;
          break;
        }
        scan = result;
        if (result.code === "scanner_not_ready") notReadyAttempt += 1;
        const waitAttempt =
          result.code === "scanner_not_ready"
            ? notReadyAttempt
            : capacityAttempt;
        structuredLog("warning", "scanner-capacity-wait", {
          jobId: job.jobId,
          attempt: job.attempt,
          workflowInstanceId: event.instanceId,
          sourceRevision: runtime.sourceRevision,
          capacityAttempt,
          waitAttempt,
          reason: result.code,
        });
        if (!scannerCapacityShouldWait(result.code, waitAttempt)) break;
        if (capacityAttempt < SCANNER_BUSY_ATTEMPT_LIMIT) {
          await step.sleep(
            `wait for scanner capacity attempt ${capacityAttempt}`,
            `${scannerCapacityDelaySeconds(waitAttempt)} seconds`,
          );
        }
      }
    } catch (error) {
      structuredLog("error", "scan-failed", {
        jobId: job.jobId,
        attempt: job.attempt,
        workflowInstanceId: event.instanceId,
        sourceRevision: runtime.sourceRevision,
        errorName: boundedErrorName(error),
        message: "The quarantined file could not be scanned after retrying.",
      });
    }
    const payload = callbackPayload(job, scan);
    await step.do("deliver signed Program Cue verdict", CALLBACK_STEP, () =>
      deliverCallback(job, payload, runtime.callbackSecret, event.instanceId),
    );
    structuredLog("info", "completed", {
      jobId: job.jobId,
      attempt: job.attempt,
      workflowInstanceId: event.instanceId,
      sourceRevision: runtime.sourceRevision,
      verdict: payload.verdict,
    });
    return {
      jobId: job.jobId,
      attempt: job.attempt,
      verdict: payload.verdict,
    };
  }
}

async function acceptScan(
  request: Request,
  environment: ScannerEnvironment,
  runtime: ScannerRuntime,
) {
  const mediaType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return jsonResponse(
      { error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }
  let job: ScannerJob;
  try {
    const rawBody = await readBoundedText(request, MAX_SCANNER_REQUEST_BYTES);
    job = await verifyScannerDispatch({
      rawBody,
      headers: request.headers,
      secret: runtime.dispatchSecret,
      configuration: runtime.contract,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonResponse(
        { error: "Request body is too large." },
        { status: 413 },
      );
    }
    return jsonResponse(
      { error: "Request body or dispatch authentication is invalid." },
      { status: 401 },
    );
  }
  if (
    request.headers.get("idempotency-key") !==
    `${job.jobId}:attempt:${job.attempt}`
  ) {
    return jsonResponse(
      { error: "Idempotency-Key must match the job attempt." },
      { status: 400 },
    );
  }

  const instanceId = await workflowInstanceId(
    `${job.jobId}:attempt:${job.attempt}`,
  );
  const created = await environment.FILE_SCAN_WORKFLOW.createBatch([
    { id: instanceId, params: job },
  ]);
  if (created.length > 1) {
    throw new Error("Scanner Workflow creation returned an invalid result.");
  }
  let duplicateStatus: string | undefined;
  if (created.length === 0) {
    const existing = await environment.FILE_SCAN_WORKFLOW.get(instanceId);
    duplicateStatus = (await existing.status()).status;
    if (!scannerWorkflowDuplicateStatusIsAcceptable(duplicateStatus)) {
      structuredLog("error", "duplicate-workflow-unavailable", {
        jobId: job.jobId,
        attempt: job.attempt,
        workflowInstanceId: instanceId,
        workflowStatus: duplicateStatus,
        sourceRevision: runtime.sourceRevision,
      });
      return jsonResponse(
        { error: "The existing scanner Workflow attempt is unavailable." },
        { status: 503 },
      );
    }
  }
  structuredLog("info", "accepted", {
    jobId: job.jobId,
    attempt: job.attempt,
    workflowInstanceId: instanceId,
    sourceRevision: runtime.sourceRevision,
    duplicate: created.length === 0,
    ...(duplicateStatus ? { workflowStatus: duplicateStatus } : {}),
  });
  return jsonResponse(
    { accepted: true, jobId: job.jobId, attempt: job.attempt },
    { status: 202 },
  );
}

export default {
  async fetch(request: Request, environment: ScannerEnvironment) {
    let runtime: ScannerRuntime;
    try {
      runtime = requireRuntime(environment);
    } catch (error) {
      structuredLog("error", "configuration-invalid", {
        errorName: boundedErrorName(error),
        message: "The scanner runtime configuration is invalid.",
      });
      return jsonResponse(
        { error: "Scanner runtime configuration is unavailable." },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        provider: SCANNER_PROVIDER,
        sourceRevision: runtime.sourceRevision,
      });
    }
    if (url.pathname !== "/v1/scans") {
      return jsonResponse({ error: "Not found." }, { status: 404 });
    }
    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed." },
        { status: 405, headers: { allow: "POST" } },
      );
    }
    try {
      return await acceptScan(request, environment, runtime);
    } catch (error) {
      structuredLog("error", "acceptance-failed", {
        sourceRevision: runtime.sourceRevision,
        errorName: boundedErrorName(error),
        message: "The scanner could not durably accept the job.",
      });
      return jsonResponse(
        { error: "The scanner could not durably accept the job." },
        { status: 503 },
      );
    }
  },
} satisfies ExportedHandler<ScannerEnvironment>;

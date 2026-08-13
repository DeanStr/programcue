import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";

import {
  constantTimeTokenMatch,
  MAX_SCANNER_REQUEST_BYTES,
  SCANNER_PROVIDER,
  signScannerCallback,
  type ScannerContractConfiguration,
  type ScannerJob,
  validateScannerJob,
  workflowInstanceId,
} from "./contract";

export { ContainerProxy };

interface ScannerEnvironment {
  CLAMAV: DurableObjectNamespace<FileScannerContainer>;
  FILE_SCAN_WORKFLOW: Workflow<ScannerJob>;
  APP_ENV?: string;
  EXPECTED_CALLBACK_URL?: string;
  R2_BUCKET_NAME?: string;
  R2_OBJECT_HOST?: string;
  SCANNER_API_TOKEN?: string;
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

interface ScannerRuntime {
  callbackSecret: string;
  contract: ScannerContractConfiguration;
  scannerApiToken: string;
  sourceRevision: string;
}

const SCAN_STEP = {
  retries: { limit: 3, delay: "15 seconds", backoff: "linear" },
  timeout: "13 minutes",
} as const;

const CALLBACK_STEP = {
  retries: { limit: 8, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class FileScannerContainer extends Container<ScannerEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "scanner/ping";
  sleepAfter = "15m";
  enableInternet = false;
  allowedHosts = [this.env.R2_OBJECT_HOST ?? "invalid.invalid", "database.clamav.net"];
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
  return {
    callbackSecret: requiredValue(
      environment.PROGRAM_CUE_CALLBACK_SECRET,
      "PROGRAM_CUE_CALLBACK_SECRET",
      32,
    ),
    contract: { callbackUrl, r2BucketName, r2ObjectHost },
    scannerApiToken: requiredValue(
      environment.SCANNER_API_TOKEN,
      "SCANNER_API_TOKEN",
      32,
    ),
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
  output.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
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
) {
  const container = environment.CLAMAV.getByName("primary");
  const response = await container.fetch("http://scanner/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.jobId, object: job.object }),
  });
  const rawBody = await readBoundedResponseText(response, 16_384);
  if (!response.ok) {
    throw new Error(`ClamAV container returned HTTP ${response.status}.`);
  }
  return containerScanResultSchema.parse(JSON.parse(rawBody));
}

function callbackPayload(job: ScannerJob, scan: ContainerScanResult | null) {
  const base = {
    jobId: job.jobId,
    eventId: job.eventId,
    versionId: job.versionId,
    assetId: job.assetId,
    object: {
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
  return {
    ...base,
    verdict: scan.verdict,
    result: {
      engine: scan.engine,
      engineVersion: scan.engineVersion,
      signatureVersion: scan.signatureVersion,
      scannedBytes: scan.scannedBytes,
      durationMs: scan.durationMs,
      ...(scan.verdict === "infected" ? { threats: scan.threats } : {}),
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
  async run(
    event: Readonly<WorkflowEvent<ScannerJob>>,
    step: WorkflowStep,
  ) {
    const runtime = requireRuntime(this.env);
    const job = validateScannerJob(event.payload, runtime.contract);
    let scan: ContainerScanResult | null = null;
    try {
      scan = await step.do("scan quarantined R2 object", SCAN_STEP, () =>
        scanInContainer(this.env, job),
      );
    } catch (error) {
      structuredLog("error", "scan-failed", {
        jobId: job.jobId,
        workflowInstanceId: event.instanceId,
        sourceRevision: runtime.sourceRevision,
        errorName: boundedErrorName(error),
        message: "The quarantined file could not be scanned after retrying.",
      });
    }
    const payload = callbackPayload(job, scan);
    await step.do("deliver signed Program Cue verdict", CALLBACK_STEP, () =>
      deliverCallback(
        job,
        payload,
        runtime.callbackSecret,
        event.instanceId,
      ),
    );
    structuredLog("info", "completed", {
      jobId: job.jobId,
      workflowInstanceId: event.instanceId,
      sourceRevision: runtime.sourceRevision,
      verdict: payload.verdict,
    });
    return { jobId: job.jobId, verdict: payload.verdict };
  }
}

async function authenticated(request: Request, expectedToken: string) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  if (!supplied || supplied.length > 1_024) return false;
  return constantTimeTokenMatch(supplied, expectedToken);
}

async function acceptScan(
  request: Request,
  environment: ScannerEnvironment,
  runtime: ScannerRuntime,
) {
  if (!(await authenticated(request, runtime.scannerApiToken))) {
    return jsonResponse({ error: "Unauthorized." }, { status: 401 });
  }
  const mediaType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
    "";
  if (mediaType !== "application/json") {
    return jsonResponse(
      { error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }
  let job: ScannerJob;
  try {
    const rawBody = await readBoundedText(request, MAX_SCANNER_REQUEST_BYTES);
    job = validateScannerJob(JSON.parse(rawBody), runtime.contract);
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonResponse({ error: "Request body is too large." }, { status: 413 });
    }
    return jsonResponse(
      { error: "Request body is not a valid scanner job." },
      { status: 400 },
    );
  }
  if (request.headers.get("idempotency-key") !== job.jobId) {
    return jsonResponse(
      { error: "Idempotency-Key must match jobId." },
      { status: 400 },
    );
  }

  const instanceId = await workflowInstanceId(job.jobId);
  const created = await environment.FILE_SCAN_WORKFLOW.createBatch([
    { id: instanceId, params: job },
  ]);
  if (created.length === 0) {
    const existing = await environment.FILE_SCAN_WORKFLOW.get(instanceId);
    const status = await existing.status();
    if (status.status === "errored" || status.status === "terminated") {
      await existing.restart();
    }
  }
  structuredLog("info", "accepted", {
    jobId: job.jobId,
    workflowInstanceId: instanceId,
    sourceRevision: runtime.sourceRevision,
    duplicate: created.length === 0,
  });
  return jsonResponse(
    { accepted: true, jobId: job.jobId },
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

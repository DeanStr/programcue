import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  requireSourceRevision,
  sourceRevisionForLog,
} from "../app/platform/observability/source-revision.server";
import {
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from "../app/platform/http/read-response";
import { requireRuntimeMode } from "../app/platform/runtime-environment.server";

export const D1_BACKUP_CRON = "17 2 * * *";
export const D1_BACKUP_FORMAT = "program-cue-d1-logical-backup-v1";

const BACKUP_PREFIX = "d1-logical";
const MAX_EXPORT_POLLS = 240;
const EXPORT_POLL_DELAY = "10 seconds";
const EXPORT_API_TIMEOUT_MS = 60_000;
const EXPORT_API_RESPONSE_MAX_BYTES = 256 * 1024;
const EXPORT_DOWNLOAD_TIMEOUT_MS = 12 * 60_000;
const DEDUPLICATABLE_BACKUP_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "paused",
  "complete",
  "waiting",
  "waitingForPause",
]);

const API_RETRY = {
  retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const STORAGE_RETRY = {
  retries: { limit: 4, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface D1BackupParameters {
  backupDate: string;
  scheduledTime: number;
}

interface D1BackupEnvironment {
  BACKUPS: R2Bucket;
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  D1_REST_API_TOKEN?: string;
  SOURCE_REVISION?: unknown;
}

interface D1BackupScheduleEnvironment {
  D1_BACKUP_WORKFLOW: Workflow<D1BackupParameters>;
  APP_ENV?: unknown;
  SOURCE_REVISION?: unknown;
}

interface BackupConfiguration {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export function requireProductionBackupRuntime(environment: {
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
}) {
  let mode: ReturnType<typeof requireRuntimeMode>;
  try {
    mode = requireRuntimeMode(environment);
  } catch {
    throw new NonRetryableError(
      "The D1 backup Workflow requires an explicit production runtime configuration.",
    );
  }
  if (mode.appEnvironment !== "production" || mode.demo) {
    throw new NonRetryableError(
      "The D1 backup Workflow is restricted to the production runtime.",
    );
  }
}

interface CloudflareApiMessage {
  code?: unknown;
  message?: unknown;
}

interface D1ExportApiEnvelope {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
}

interface D1ExportApiResult {
  at_bookmark?: unknown;
  error?: unknown;
  messages?: unknown;
  result?: unknown;
  status?: unknown;
  success?: unknown;
  type?: unknown;
}

export type D1ExportState =
  | {
      phase: "pending";
      bookmark: string;
    }
  | {
      phase: "complete";
      bookmark: string;
      filename: string;
      signedUrl: string;
    };

export interface D1BackupManifest {
  format: typeof D1_BACKUP_FORMAT;
  backupDate: string;
  scheduledFor: string;
  databaseId: string;
  bookmark: string;
  sourceFilename: string;
  backupKey: string;
  bytes: number;
  sha256: string;
  objectEtag: string;
  uploadedAt: string;
  workflowInstanceId: string;
}

interface StoredBackup {
  backupKey: string;
  bytes: number;
  sha256: string;
  objectEtag: string;
  uploadedAt: string;
}

interface CloudflareStreamingCrypto extends Crypto {
  DigestStream: typeof DigestStream;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isFetchTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function digestHex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestReadableStream(source: ReadableStream<Uint8Array>) {
  const digestStream = new (crypto as CloudflareStreamingCrypto).DigestStream(
    "SHA-256",
  );
  await source.pipeTo(digestStream);
  const written = digestStream.bytesWritten;
  if (
    typeof written === "bigint" &&
    written > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      "The D1 backup is too large to record an exact byte count.",
    );
  }
  return {
    bytes: typeof written === "bigint" ? Number(written) : written,
    sha256: digestHex(await digestStream.digest),
  };
}

async function requireNonEmptyStream(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader();
  let firstChunk: Uint8Array;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("Cloudflare returned an empty D1 logical export.");
      }
      if (next.value.byteLength > 0) {
        firstChunk = next.value;
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  let firstPending = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(firstChunk);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredConfiguration(
  environment: D1BackupEnvironment,
): BackupConfiguration {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const databaseId = environment.D1_DATABASE_ID?.trim() ?? "";
  const apiToken = environment.D1_REST_API_TOKEN?.trim() ?? "";

  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new NonRetryableError(
      "CLOUDFLARE_ACCOUNT_ID must be the 32-character account identifier before D1 backups can run.",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      databaseId,
    )
  ) {
    throw new NonRetryableError(
      "D1_DATABASE_ID must be the provisioned D1 UUID before D1 backups can run.",
    );
  }
  if (!apiToken) {
    throw new NonRetryableError(
      "D1_REST_API_TOKEN is required before D1 backups can run.",
    );
  }
  if (!environment.BACKUPS || typeof environment.BACKUPS.put !== "function") {
    throw new NonRetryableError(
      "The private BACKUPS R2 binding is required before D1 backups can run.",
    );
  }

  return { accountId, databaseId, apiToken };
}

export function utcBackupDate(scheduledTime: number) {
  if (!Number.isFinite(scheduledTime)) {
    throw new Error("The backup schedule timestamp must be finite.");
  }
  const date = new Date(scheduledTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error("The backup schedule timestamp is invalid.");
  }
  return date.toISOString().slice(0, 10);
}

function backupKeys(backupDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(backupDate)) {
    throw new NonRetryableError("The Workflow backup date is invalid.");
  }
  const backupKey = `${BACKUP_PREFIX}/${backupDate}/program-cue-${backupDate}.sql`;
  return {
    backupKey,
    manifestKey: `${backupKey}.manifest.json`,
  };
}

function structuredLog(
  environment: { APP_ENV?: unknown; SOURCE_REVISION?: unknown },
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    level,
    subsystem: "d1-backup",
    event,
    sourceRevision: sourceRevisionForLog(environment),
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

function apiErrorMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => {
      const message =
        typeof (entry as CloudflareApiMessage).message === "string"
          ? (entry as CloudflareApiMessage).message
          : "Cloudflare API error";
      const code = (entry as CloudflareApiMessage).code;
      return typeof code === "number" ? `${code}: ${message}` : message;
    })
    .slice(0, 3);
}

function apiFailure(status: number, details: string) {
  const message = `Cloudflare D1 export request failed (${status}): ${details}`;
  if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) {
    return new NonRetryableError(message);
  }
  return new Error(message);
}

function validateSignedDownloadUrl(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw new NonRetryableError(
      "Cloudflare completed the D1 export without a signed download URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NonRetryableError(
      "Cloudflare returned an invalid D1 export download URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".r2.cloudflarestorage.com")
  ) {
    throw new NonRetryableError(
      "Cloudflare returned a D1 export URL outside the HTTPS R2 service domain.",
    );
  }
  return url.toString();
}

export function parseD1ExportEnvelope(value: unknown): D1ExportState {
  if (!isRecord(value)) {
    throw new NonRetryableError(
      "Cloudflare returned a malformed D1 export response.",
    );
  }
  const envelope = value as D1ExportApiEnvelope;
  if (envelope.success !== true || !isRecord(envelope.result)) {
    const details = apiErrorMessages(envelope.errors).join("; ");
    throw new Error(
      `Cloudflare rejected the D1 export${details ? `: ${details}` : "."}`,
    );
  }

  const result = envelope.result as D1ExportApiResult;
  const bookmark =
    typeof result.at_bookmark === "string" ? result.at_bookmark.trim() : "";
  if (!bookmark) {
    throw new NonRetryableError(
      "Cloudflare returned a D1 export response without at_bookmark.",
    );
  }
  if (result.status === "error") {
    const detail =
      typeof result.error === "string" && result.error.trim()
        ? result.error.trim()
        : "the export job failed without an error message";
    throw new NonRetryableError(`Cloudflare D1 export failed: ${detail}`);
  }
  if (result.status === undefined || result.status === "active") {
    return { phase: "pending", bookmark };
  }
  if (result.status !== "complete" || !isRecord(result.result)) {
    throw new NonRetryableError(
      "Cloudflare returned an unknown D1 export status.",
    );
  }

  const filename =
    typeof result.result.filename === "string"
      ? result.result.filename.trim()
      : "";
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new NonRetryableError(
      "Cloudflare completed the D1 export without a safe filename.",
    );
  }
  return {
    phase: "complete",
    bookmark,
    filename,
    signedUrl: validateSignedDownloadUrl(result.result.signed_url),
  };
}

export async function requestD1ExportState(
  configuration: BackupConfiguration,
  currentBookmark?: string,
  fetcher: Fetcher = fetch,
) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/d1/database/${configuration.databaseId}/export`;
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuration.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        currentBookmark
          ? {
              current_bookmark: currentBookmark,
              output_format: "polling",
            }
          : { output_format: "polling" },
      ),
      signal: AbortSignal.timeout(EXPORT_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (isFetchTimeout(error)) {
      throw new Error("Cloudflare D1 export request timed out.");
    }
    throw new Error("Cloudflare D1 export request could not reach the API.");
  }

  let payload: unknown;
  try {
    payload = await readBoundedResponseJson(
      response,
      EXPORT_API_RESPONSE_MAX_BYTES,
    );
  } catch (error) {
    throw apiFailure(
      response.status,
      error instanceof ResponseBodyTooLargeError
        ? "the response exceeded the 256 KiB limit"
        : "the response was not valid JSON",
    );
  }
  if (!response.ok) {
    const details = isRecord(payload)
      ? apiErrorMessages(payload.errors).join("; ")
      : "the API returned an error";
    throw apiFailure(response.status, details || "the API returned an error");
  }
  return parseD1ExportEnvelope(payload);
}

function publicExportState(state: D1ExportState) {
  return state.phase === "complete"
    ? {
        phase: state.phase,
        bookmark: state.bookmark,
        filename: state.filename,
      }
    : state;
}

export async function downloadD1Export(
  configuration: BackupConfiguration,
  bookmark: string,
  fetcher: Fetcher = fetch,
) {
  const state = await requestD1ExportState(configuration, bookmark, fetcher);
  if (state.phase !== "complete") {
    throw new Error(
      "Cloudflare reported that the D1 export was no longer ready to download.",
    );
  }

  let response: Response;
  try {
    response = await fetcher(state.signedUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(EXPORT_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (isFetchTimeout(error)) {
      throw new Error("The signed D1 export download timed out.");
    }
    throw new Error("The signed D1 export could not be downloaded from R2.");
  }
  if (!response.ok || !response.body) {
    throw new Error(
      `The signed D1 export download failed (${response.status}).`,
    );
  }
  return response.body;
}

export async function storeBackupStream(
  bucket: R2Bucket,
  source: ReadableStream<Uint8Array>,
  input: {
    backupKey: string;
    backupDate: string;
    databaseId: string;
    bookmark: string;
    workflowInstanceId: string;
  },
): Promise<StoredBackup> {
  // Peek before reserving the immutable daily key. A successful zero-byte D1
  // response must not poison that key for every subsequent Workflow retry.
  const [storageStream, digestInput] = source.tee();
  let nonEmptyDigestInput: ReadableStream<Uint8Array>;
  try {
    nonEmptyDigestInput = await requireNonEmptyStream(digestInput);
  } catch (error) {
    if (!storageStream.locked)
      await storageStream.cancel(error).catch(() => undefined);
    throw error;
  }
  const sourceDigestPromise = digestReadableStream(nonEmptyDigestInput);
  let stored: R2Object | null;
  try {
    stored = await bucket.put(input.backupKey, storageStream, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/sql; charset=utf-8",
        contentDisposition: `attachment; filename="program-cue-${input.backupDate}.sql"`,
      },
      customMetadata: {
        format: D1_BACKUP_FORMAT,
        backupDate: input.backupDate,
        databaseId: input.databaseId,
        bookmark: input.bookmark,
        workflowInstanceId: input.workflowInstanceId,
      },
    });
  } catch (error) {
    if (!storageStream.locked) await storageStream.cancel();
    await sourceDigestPromise.catch(() => undefined);
    throw error;
  }
  if (!stored && !storageStream.locked) await storageStream.cancel();
  const sourceDigest = await sourceDigestPromise;
  if (!stored) {
    const existing = await bucket.get(input.backupKey);
    if (!existing) {
      throw new Error(
        "The conditional R2 backup write was rejected but no existing object was found.",
      );
    }
    const existingDigest = await digestReadableStream(
      existing.body as ReadableStream<Uint8Array>,
    );
    if (
      existingDigest.bytes !== sourceDigest.bytes ||
      existingDigest.sha256 !== sourceDigest.sha256
    ) {
      throw new NonRetryableError(
        "A different immutable R2 object already exists for this daily D1 backup.",
      );
    }
    return {
      backupKey: input.backupKey,
      ...sourceDigest,
      objectEtag: existing.etag,
      uploadedAt: existing.uploaded.toISOString(),
    };
  }
  if (stored.size !== sourceDigest.bytes) {
    throw new Error(
      "The private R2 backup write did not persist the complete export.",
    );
  }
  return {
    backupKey: input.backupKey,
    ...sourceDigest,
    objectEtag: stored.etag,
    uploadedAt: stored.uploaded.toISOString(),
  };
}

function assertManifest(
  value: unknown,
  expected: {
    backupDate: string;
    databaseId: string;
    backupKey: string;
  },
): D1BackupManifest {
  if (!isRecord(value)) {
    throw new NonRetryableError("The stored D1 backup manifest is malformed.");
  }
  if (
    value.format !== D1_BACKUP_FORMAT ||
    value.backupDate !== expected.backupDate ||
    value.databaseId !== expected.databaseId ||
    value.backupKey !== expected.backupKey ||
    typeof value.scheduledFor !== "string" ||
    !Number.isInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.bookmark !== "string" ||
    !value.bookmark ||
    typeof value.sourceFilename !== "string" ||
    !value.sourceFilename ||
    typeof value.objectEtag !== "string" ||
    !value.objectEtag ||
    typeof value.uploadedAt !== "string" ||
    typeof value.workflowInstanceId !== "string" ||
    !value.workflowInstanceId
  ) {
    throw new NonRetryableError(
      "The stored D1 backup manifest does not match the expected daily backup.",
    );
  }
  return value as unknown as D1BackupManifest;
}

export async function readExistingBackupManifest(
  bucket: R2Bucket,
  manifestKey: string,
  expected: {
    backupDate: string;
    databaseId: string;
    backupKey: string;
  },
) {
  const object = await bucket.get(manifestKey);
  if (!object) return null;

  let decoded: unknown;
  try {
    decoded = await object.json<unknown>();
  } catch {
    throw new NonRetryableError(
      "The existing D1 backup manifest is not valid JSON.",
    );
  }
  const manifest = assertManifest(decoded, expected);
  if (object.customMetadata?.sha256 !== manifest.sha256) {
    throw new NonRetryableError(
      "The existing D1 backup manifest checksum metadata does not match its body.",
    );
  }
  const backup = await bucket.head(manifest.backupKey);
  if (
    !backup ||
    backup.size !== manifest.bytes ||
    backup.etag !== manifest.objectEtag
  ) {
    throw new NonRetryableError(
      "The existing D1 backup manifest points to missing or mismatched R2 bytes.",
    );
  }
  return manifest;
}

export async function writeBackupManifest(
  bucket: R2Bucket,
  manifestKey: string,
  manifest: D1BackupManifest,
) {
  const expected = {
    backupDate: manifest.backupDate,
    databaseId: manifest.databaseId,
    backupKey: manifest.backupKey,
  };
  const stored = await bucket.put(
    manifestKey,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        format: D1_BACKUP_FORMAT,
        backupDate: manifest.backupDate,
        sha256: manifest.sha256,
      },
    },
  );
  if (!stored) {
    const existing = await readExistingBackupManifest(
      bucket,
      manifestKey,
      expected,
    );
    if (existing && JSON.stringify(existing) === JSON.stringify(manifest)) {
      return existing;
    }
    throw new NonRetryableError(
      "A different immutable manifest already exists for this daily D1 backup.",
    );
  }

  const verified = await readExistingBackupManifest(
    bucket,
    manifestKey,
    expected,
  );
  if (!verified || JSON.stringify(verified) !== JSON.stringify(manifest)) {
    throw new Error(
      "The D1 backup manifest could not be verified after storage.",
    );
  }
  return verified;
}

export async function scheduleDailyD1Backup(
  environment: D1BackupScheduleEnvironment,
  scheduledTime: number,
) {
  const backupDate = utcBackupDate(scheduledTime);
  const instanceId = `d1-backup-${backupDate}`;
  const workflow = environment.D1_BACKUP_WORKFLOW;
  if (
    !workflow ||
    typeof workflow.createBatch !== "function" ||
    typeof workflow.get !== "function"
  ) {
    throw new Error(
      "The D1_BACKUP_WORKFLOW binding must support createBatch and get before backups can be scheduled.",
    );
  }

  try {
    const created = await workflow.createBatch([
      {
        id: instanceId,
        params: { backupDate, scheduledTime },
      },
    ]);
    if (created.length !== 1 || created[0]?.id !== instanceId) {
      throw new Error(
        "The daily D1 backup scheduler received an invalid createBatch result.",
      );
    }
  } catch (createError) {
    let existingStatus: Awaited<ReturnType<WorkflowInstance["status"]>>;
    try {
      const existing = await workflow.get(instanceId);
      if (!existing || existing.id !== instanceId) {
        throw new Error("The Workflow binding returned the wrong instance.");
      }
      existingStatus = await existing.status();
      if (!existingStatus || existingStatus.status === "unknown") {
        throw new Error("The Workflow instance does not have a known status.");
      }
    } catch (lookupError) {
      throw new Error(
        "The daily D1 backup could not be created or verified as an existing instance.",
        { cause: { createError, lookupError } },
      );
    }
    if (!DEDUPLICATABLE_BACKUP_STATUSES.has(existingStatus.status)) {
      structuredLog(environment, "error", "schedule-failed", {
        backupDate,
        instanceId,
        instanceStatus: existingStatus.status,
        message:
          "The existing daily D1 backup Workflow instance is not viable.",
      });
      throw new Error(
        `The existing daily D1 backup Workflow instance is ${existingStatus.status}.`,
        { cause: createError },
      );
    }
    structuredLog(environment, "info", "scheduled", {
      backupDate,
      instanceId,
      outcome: "deduplicated",
      instanceStatus: existingStatus.status,
    });
    return { backupDate, instanceId, created: false };
  }

  structuredLog(environment, "info", "scheduled", {
    backupDate,
    instanceId,
    outcome: "created",
  });
  return { backupDate, instanceId, created: true };
}

export async function runD1BackupWorkflow(
  environment: D1BackupEnvironment,
  event: Readonly<WorkflowEvent<D1BackupParameters>>,
  step: WorkflowStep,
) {
  const runtimePayload = event.payload as unknown;
  const claimedBackupDate =
    isRecord(runtimePayload) && typeof runtimePayload.backupDate === "string"
      ? runtimePayload.backupDate
      : "invalid";
  try {
    if (
      !isRecord(runtimePayload) ||
      typeof runtimePayload.backupDate !== "string" ||
      typeof runtimePayload.scheduledTime !== "number" ||
      !Number.isFinite(runtimePayload.scheduledTime)
    ) {
      throw new NonRetryableError(
        "The D1 backup Workflow requires a UTC schedule timestamp and backup date.",
      );
    }
    const configuration = requiredConfiguration(environment);
    const expectedDate = utcBackupDate(runtimePayload.scheduledTime);
    if (
      runtimePayload.backupDate !== expectedDate ||
      event.instanceId !== `d1-backup-${expectedDate}`
    ) {
      throw new NonRetryableError(
        "The D1 backup Workflow identity does not match its scheduled UTC date.",
      );
    }
    const scheduledFor = new Date(runtimePayload.scheduledTime).toISOString();
    const { backupKey, manifestKey } = backupKeys(expectedDate);

    structuredLog(environment, "info", "started", {
      backupDate: expectedDate,
      instanceId: event.instanceId,
      scheduledFor,
    });

    const existing = await step.do("check immutable daily backup", async () =>
      readExistingBackupManifest(environment.BACKUPS, manifestKey, {
        backupDate: expectedDate,
        databaseId: configuration.databaseId,
        backupKey,
      }),
    );
    if (existing) {
      structuredLog(environment, "info", "completed", {
        backupDate: expectedDate,
        instanceId: event.instanceId,
        outcome: "already-existed",
        backupKey,
        bytes: existing.bytes,
        sha256: existing.sha256,
      });
      return existing;
    }

    let state = await step.do("initiate D1 logical export", API_RETRY, () =>
      requestD1ExportState(configuration).then(publicExportState),
    );
    let pollCount = 0;
    while (state.phase === "pending" && pollCount < MAX_EXPORT_POLLS) {
      await step.sleep("wait before D1 export poll", EXPORT_POLL_DELAY);
      state = await step.do("poll D1 logical export", API_RETRY, () =>
        requestD1ExportState(configuration, state.bookmark).then(
          publicExportState,
        ),
      );
      pollCount += 1;
    }
    if (state.phase !== "complete") {
      throw new NonRetryableError(
        `Cloudflare did not complete the D1 export after ${MAX_EXPORT_POLLS} polls.`,
      );
    }

    structuredLog(environment, "info", "export-ready", {
      backupDate: expectedDate,
      instanceId: event.instanceId,
      bookmark: state.bookmark,
      pollCount,
    });

    const stored = await step.do(
      "download and stream D1 export to private R2",
      STORAGE_RETRY,
      async () => {
        // The response body must be created inside this retryable callback.
        // Reusing a stream returned by an earlier durable step would reuse a
        // consumed/locked body when this storage attempt is retried.
        const dump = await downloadD1Export(configuration, state.bookmark);
        return storeBackupStream(environment.BACKUPS, dump, {
          backupKey,
          backupDate: expectedDate,
          databaseId: configuration.databaseId,
          bookmark: state.bookmark,
          workflowInstanceId: event.instanceId,
        });
      },
    );
    const manifest: D1BackupManifest = {
      format: D1_BACKUP_FORMAT,
      backupDate: expectedDate,
      scheduledFor,
      databaseId: configuration.databaseId,
      bookmark: state.bookmark,
      sourceFilename: state.filename,
      backupKey,
      bytes: stored.bytes,
      sha256: stored.sha256,
      objectEtag: stored.objectEtag,
      uploadedAt: stored.uploadedAt,
      workflowInstanceId: event.instanceId,
    };
    const verified = await step.do(
      "write and verify D1 backup manifest",
      STORAGE_RETRY,
      () => writeBackupManifest(environment.BACKUPS, manifestKey, manifest),
    );

    structuredLog(environment, "info", "completed", {
      backupDate: expectedDate,
      instanceId: event.instanceId,
      outcome: "stored",
      backupKey,
      manifestKey,
      bytes: verified.bytes,
      sha256: verified.sha256,
      pollCount,
    });
    return verified;
  } catch (error) {
    structuredLog(environment, "error", "failed", {
      backupDate: claimedBackupDate,
      instanceId: event.instanceId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "The D1 backup Workflow failed.",
    });
    throw error;
  }
}

export class D1BackupWorkflow extends WorkflowEntrypoint<
  D1BackupEnvironment,
  D1BackupParameters
> {
  run(event: Readonly<WorkflowEvent<D1BackupParameters>>, step: WorkflowStep) {
    requireProductionBackupRuntime(this.env);
    requireSourceRevision(this.env);
    return runD1BackupWorkflow(this.env, event, step);
  }
}

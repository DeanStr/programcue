import Uppy from "@uppy/core";
import AwsS3, { type AwsS3Part } from "@uppy/aws-s3";
import { md5 } from "@noble/hashes/legacy.js";

import { DIRECT_MULTIPART_PART_SIZE_BYTES } from "./file-policy";

export type ProgramCueMultipartOperation =
  "initiate" | "resume" | "list-parts" | "part-url" | "complete" | "abort";

export type ProgramCueMultipartRequest = <T>(
  operation: ProgramCueMultipartOperation,
  body: Record<string, unknown>,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) => Promise<T>;

export type ProgramCueUploadCompletion = {
  assetId: string;
  versionId: string;
  scanStatus: "pending";
};

type UploadMeta = {
  [key: string]: unknown;
  assetKind: string;
  idempotencyKey: string;
};

type UploadBody = ProgramCueUploadCompletion & { location?: string };

type ResumeRecord = {
  idempotencyKey: string;
  versionId?: string;
  expiresAt: number;
};

type MultipartUploadIntent = {
  assetId: string;
  versionId: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RESUME_STORAGE_PREFIX = "program-cue:multipart-resume:v1:";
const DEFAULT_RESUME_SECONDS = 24 * 60 * 60;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1_024;

export class MultipartResumeStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MultipartResumeStorageError";
  }
}

export class MultipartResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartResponseContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validUploadIntent(value: unknown): value is MultipartUploadIntent {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.assetId) &&
    isNonEmptyString(value.versionId) &&
    Number.isInteger(value.partSizeBytes) &&
    Number(value.partSizeBytes) > 0 &&
    Number.isInteger(value.partCount) &&
    Number(value.partCount) > 0 &&
    Number.isInteger(value.expiresAt) &&
    Number(value.expiresAt) > 0
  );
}

function validCompletion(value: unknown): value is ProgramCueUploadCompletion {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.assetId) &&
    isNonEmptyString(value.versionId) &&
    value.scanStatus === "pending"
  );
}

export function parseProgramCueMultipartResponse<T>(
  operation: ProgramCueMultipartOperation,
  value: unknown,
): T {
  if (!isRecord(value) || value.ok !== true) {
    throw new MultipartResponseContractError(
      "The multipart endpoint returned an invalid success response.",
    );
  }
  let valid = false;
  if (operation === "initiate") valid = validUploadIntent(value.upload);
  else if (operation === "resume")
    valid = value.upload === null || validUploadIntent(value.upload);
  else if (operation === "list-parts") valid = Array.isArray(value.parts);
  else if (operation === "part-url")
    valid = isRecord(value.part) && isNonEmptyString(value.part.url);
  else if (operation === "complete") valid = validCompletion(value.upload);
  else
    valid =
      isRecord(value.upload) &&
      isNonEmptyString(value.upload.versionId) &&
      value.upload.aborted === true;
  if (!valid) {
    throw new MultipartResponseContractError(
      `The multipart ${operation} endpoint returned an invalid success response.`,
    );
  }
  return value as T;
}

export async function readProgramCueMultipartResponse<T>(
  response: Response,
  operation: ProgramCueMultipartOperation,
  failureLabel = "Upload request",
) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok)
      throw new Error(`${failureLabel} failed (${response.status}).`);
    throw new MultipartResponseContractError(
      `The multipart ${operation} endpoint returned invalid JSON.`,
    );
  }
  if (!response.ok) {
    const error = isRecord(payload) ? payload.error : null;
    throw new Error(
      typeof error === "string" && error.length > 0
        ? error
        : `${failureLabel} failed (${response.status}).`,
    );
  }
  return parseProgramCueMultipartResponse<T>(operation, payload);
}

function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(parts: BlobPart[]) {
  const bytes = await new Blob(parts).arrayBuffer();
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function resumableUploadFingerprint(
  scope: string,
  assetKind: string,
  file: Pick<File, "name" | "size" | "type" | "slice">,
) {
  const tailStart = Math.max(
    FINGERPRINT_SAMPLE_BYTES,
    file.size - FINGERPRINT_SAMPLE_BYTES,
  );
  return sha256([
    JSON.stringify({
      scope,
      assetKind,
      name: file.name,
      size: file.size,
      type: file.type.toLowerCase(),
    }),
    "\0",
    file.slice(0, Math.min(file.size, FINGERPRINT_SAMPLE_BYTES)),
    file.size > FINGERPRINT_SAMPLE_BYTES ? file.slice(tailStart) : new Blob(),
  ]);
}

export async function resumableUploadStorageKey(
  scope: string,
  assetKind: string,
  file: Pick<File, "name" | "size" | "type" | "slice">,
) {
  return `${RESUME_STORAGE_PREFIX}${await resumableUploadFingerprint(
    scope,
    assetKind,
    file,
  )}`;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function validResumeRecord(value: unknown): value is ResumeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ResumeRecord>;
  return (
    typeof record.idempotencyKey === "string" &&
    /^[a-zA-Z0-9._:-]{16,160}$/.test(record.idempotencyKey) &&
    (record.versionId === undefined ||
      (typeof record.versionId === "string" &&
        record.versionId.length >= 1 &&
        record.versionId.length <= 160)) &&
    typeof record.expiresAt === "number" &&
    Number.isInteger(record.expiresAt)
  );
}

function readResumeRecord(storage: StorageLike | null, key: string) {
  if (!storage)
    throw new MultipartResumeStorageError(
      "Resumable upload storage is unavailable. Enable browser storage before starting this upload.",
    );
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!validResumeRecord(record)) {
      throw new MultipartResumeStorageError(
        "The saved resumable upload record is invalid. Clear this site's browser storage before starting another upload.",
      );
    }
    if (record.expiresAt <= Math.floor(Date.now() / 1_000)) {
      storage.removeItem(key);
      return null;
    }
    return record;
  } catch (error) {
    if (error instanceof MultipartResumeStorageError) throw error;
    throw new MultipartResumeStorageError(
      "Resumable upload storage could not be read. No upload was started.",
      { cause: error },
    );
  }
}

function writeResumeRecord(
  storage: StorageLike | null,
  key: string,
  record: ResumeRecord,
) {
  if (!storage)
    throw new MultipartResumeStorageError(
      "Resumable upload storage is unavailable. No upload was started.",
    );
  const serialized = JSON.stringify(record);
  try {
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized)
      throw new Error("The browser did not retain the upload record.");
  } catch (error) {
    throw new MultipartResumeStorageError(
      "Resumable upload storage could not be written. No new upload was started.",
      { cause: error },
    );
  }
}

function removeResumeRecord(storage: StorageLike | null, key: string) {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // A stale opaque hint cannot authorize or complete an upload.
  }
}

function clearStaleResumeRecord(storage: StorageLike | null, key: string) {
  if (!storage)
    throw new MultipartResumeStorageError(
      "The stale resumable upload record could not be cleared because browser storage is unavailable.",
    );
  try {
    storage.removeItem(key);
    if (storage.getItem(key) !== null)
      throw new Error("The browser retained the stale upload record.");
  } catch (error) {
    throw new MultipartResumeStorageError(
      "The stale resumable upload record could not be cleared. Clear this site's browser storage before retrying.",
      { cause: error },
    );
  }
}

function uploadDeclaration(file: File) {
  return {
    filename: file.name,
    contentType: file.type.toLowerCase(),
    sizeBytes: file.size,
  };
}

async function validateResumedParts(file: File, parts: AwsS3Part[]) {
  const validated: AwsS3Part[] = [];
  for (const part of parts) {
    if (
      !Number.isInteger(part.PartNumber) ||
      part.PartNumber! < 1 ||
      typeof part.ETag !== "string" ||
      !Number.isInteger(part.Size)
    )
      throw new Error("R2 returned invalid resumable part metadata.");
    const start = (part.PartNumber! - 1) * DIRECT_MULTIPART_PART_SIZE_BYTES;
    const end = Math.min(file.size, start + DIRECT_MULTIPART_PART_SIZE_BYTES);
    if (start >= file.size || part.Size !== end - start)
      throw new Error("R2 returned a part outside the selected file layout.");
    const selectedPartEtag = hex(
      md5(new Uint8Array(await file.slice(start, end).arrayBuffer())),
    );
    if (part.ETag.replace(/^"|"$/g, "").toLowerCase() !== selectedPartEtag)
      throw new Error(
        "The selected file does not match the parts already stored in R2. Cancel the saved upload before starting a replacement.",
      );
    validated.push(part);
  }
  return validated;
}

function preservingDestroy(uppy: Uppy<UploadMeta, UploadBody>, fileId: string) {
  const plugin = uppy.getPlugin("AwsS3Multipart");
  plugin?.resetUploaderReferences(fileId);
  uppy.clear();
  uppy.destroy();
}

export type ProgramCueMultipartSession = {
  upload(): Promise<ProgramCueUploadCompletion>;
  pauseResume(): boolean;
  cancel(): Promise<void>;
  markAttached(): void;
  disposePreservingUpload(): void;
};

export async function createProgramCueMultipartSession({
  file,
  assetKind,
  resumeScope,
  request,
  onProgress,
  onPauseChange,
  storage = browserStorage(),
}: {
  file: File;
  assetKind: string;
  resumeScope: string;
  request: ProgramCueMultipartRequest;
  onProgress?: (percentage: number) => void;
  onPauseChange?: (paused: boolean) => void;
  storage?: StorageLike | null;
}): Promise<ProgramCueMultipartSession> {
  if (!file.name || file.size < 1) throw new Error("Choose a non-empty file.");
  const storageKey = await resumableUploadStorageKey(
    resumeScope,
    assetKind,
    file,
  );
  let resumeRecord = readResumeRecord(storage, storageKey) ?? {
    idempotencyKey: crypto.randomUUID(),
    expiresAt: Math.floor(Date.now() / 1_000) + DEFAULT_RESUME_SECONDS,
  };
  writeResumeRecord(storage, storageKey, resumeRecord);

  const declaration = uploadDeclaration(file);
  const recovered = await request<{ upload: MultipartUploadIntent | null }>(
    "resume",
    declaration,
    { idempotencyKey: resumeRecord.idempotencyKey },
  );
  let activeVersionId = recovered.upload?.versionId ?? null;
  if (recovered.upload) {
    if (
      recovered.upload.partSizeBytes !== DIRECT_MULTIPART_PART_SIZE_BYTES ||
      recovered.upload.partCount !==
        Math.ceil(file.size / DIRECT_MULTIPART_PART_SIZE_BYTES)
    )
      throw new Error(
        "The saved upload does not match the browser multipart layout.",
      );
    resumeRecord = {
      ...resumeRecord,
      versionId: recovered.upload.versionId,
      expiresAt: recovered.upload.expiresAt,
    };
    writeResumeRecord(storage, storageKey, resumeRecord);
  } else if (resumeRecord.versionId) {
    clearStaleResumeRecord(storage, storageKey);
    throw new Error(
      "The saved upload identity is not available on the server. Its stale local resume record was cleared; start a new upload.",
    );
  }

  const uppy = new Uppy<UploadMeta, UploadBody>({
    id: `program-cue-${crypto.randomUUID()}`,
    autoProceed: false,
    allowMultipleUploadBatches: false,
    restrictions: {
      minNumberOfFiles: 1,
      maxNumberOfFiles: 1,
      maxFileSize: 1_073_741_824,
    },
  });
  let cancelRequested = false;
  let completionResult: ProgramCueUploadCompletion | null = null;
  uppy.use(AwsS3, {
    shouldUseMultipart: true,
    getChunkSize: () => DIRECT_MULTIPART_PART_SIZE_BYTES,
    limit: 3,
    retryDelays: [0, 1_000, 3_000, 5_000],
    allowedMetaFields: false,
    createMultipartUpload: async () => {
      const initiated = await request<{ upload: MultipartUploadIntent }>(
        "initiate",
        declaration,
        { idempotencyKey: resumeRecord.idempotencyKey },
      );
      if (cancelRequested) {
        await request("abort", { versionId: initiated.upload.versionId });
        removeResumeRecord(storage, storageKey);
        throw new DOMException("Upload cancelled.", "AbortError");
      }
      if (initiated.upload.partSizeBytes !== DIRECT_MULTIPART_PART_SIZE_BYTES)
        throw new Error(
          "The server and browser multipart chunk sizes do not match.",
        );
      activeVersionId = initiated.upload.versionId;
      resumeRecord = {
        ...resumeRecord,
        versionId: initiated.upload.versionId,
        expiresAt: initiated.upload.expiresAt,
      };
      writeResumeRecord(storage, storageKey, resumeRecord);
      return {
        uploadId: initiated.upload.versionId,
        key: initiated.upload.versionId,
      };
    },
    listParts: async (uppyFile, { uploadId, key, signal }) => {
      if (key !== uploadId)
        throw new Error("The multipart resume identity is invalid.");
      const listed = await request<{ parts: AwsS3Part[] }>(
        "list-parts",
        { versionId: uploadId },
        { signal },
      );
      if (!(uppyFile.data instanceof File))
        throw new Error("The selected browser file is unavailable for resume.");
      return validateResumedParts(uppyFile.data, listed.parts);
    },
    signPart: async (_file, { uploadId, key, partNumber, signal }) => {
      if (key !== uploadId)
        throw new Error("The multipart signing identity is invalid.");
      const signed = await request<{ part: { url: string } }>(
        "part-url",
        { versionId: uploadId, partNumber },
        { signal },
      );
      return { method: "PUT", url: signed.part.url };
    },
    completeMultipartUpload: async (
      _file,
      { uploadId, key, parts, signal },
    ) => {
      if (key !== uploadId)
        throw new Error("The multipart completion identity is invalid.");
      const normalized = parts.map((part) => {
        if (!Number.isInteger(part.PartNumber) || typeof part.ETag !== "string")
          throw new Error("Uppy returned invalid multipart completion data.");
        return { partNumber: part.PartNumber!, etag: part.ETag };
      });
      const completed = await request<{ upload: ProgramCueUploadCompletion }>(
        "complete",
        { versionId: uploadId, parts: normalized },
        { signal },
      );
      activeVersionId = completed.upload.versionId;
      completionResult = completed.upload;
      return {};
    },
    abortMultipartUpload: async (_file, { uploadId, key, signal }) => {
      if (key !== uploadId)
        throw new Error("The multipart abort identity is invalid.");
      await request("abort", { versionId: uploadId }, { signal });
      activeVersionId = null;
      removeResumeRecord(storage, storageKey);
    },
  });
  const fileId = uppy.addFile({
    name: file.name,
    type: file.type,
    data: file,
    source: "Program Cue",
    meta: {
      assetKind,
      idempotencyKey: resumeRecord.idempotencyKey,
    },
  });
  if (recovered.upload)
    uppy.setFileState(fileId, {
      s3Multipart: {
        uploadId: recovered.upload.versionId,
        key: recovered.upload.versionId,
      },
    } as never);
  uppy.on("upload-progress", (progressFile, progress) => {
    if (progressFile?.id !== fileId || !progress.bytesTotal) return;
    onProgress?.(
      Math.min(
        100,
        Math.round((progress.bytesUploaded / progress.bytesTotal) * 100),
      ),
    );
  });
  uppy.on("upload-pause", (pausedFile, paused) => {
    if (pausedFile?.id === fileId) onPauseChange?.(paused);
  });

  let disposed = false;
  const disposePreservingUpload = () => {
    if (disposed) return;
    disposed = true;
    preservingDestroy(uppy, fileId);
  };
  return {
    async upload() {
      if (disposed) throw new Error("This multipart upload session is closed.");
      const result = await uppy.upload();
      if (result?.successful?.length && completionResult)
        return completionResult;
      const failure = result?.failed?.[0]?.error;
      throw new Error(failure ?? "The resumable upload did not complete.");
    },
    pauseResume() {
      if (disposed) return false;
      return uppy.pauseResume(fileId) ?? false;
    },
    async cancel() {
      if (disposed) return;
      cancelRequested = true;
      uppy.pauseAll();
      uppy.getPlugin("AwsS3Multipart")?.resetUploaderReferences(fileId);
      if (activeVersionId)
        await request("abort", { versionId: activeVersionId });
      activeVersionId = null;
      removeResumeRecord(storage, storageKey);
      disposePreservingUpload();
    },
    markAttached() {
      removeResumeRecord(storage, storageKey);
    },
    disposePreservingUpload,
  };
}

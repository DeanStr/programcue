export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

export class FileScanPendingError extends Error {
  constructor() {
    super(
      "The upload is safely stored in quarantine. It cannot be downloaded or approved until a malware scanner reports it clean.",
    );
    this.name = "FileScanPendingError";
  }
}

export class FileVersionNotFoundError extends Error {
  constructor() {
    super("File version not found.");
    this.name = "FileVersionNotFoundError";
  }
}

export class FileScanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileScanStateError";
  }
}

export class FileScanConflictError extends Error {
  constructor() {
    super("This file version already has a different final scanner result.");
    this.name = "FileScanConflictError";
  }
}

export class FileErasureConfirmationError extends Error {
  constructor() {
    super("Confirm permanent deletion of every stored version of this file.");
    this.name = "FileErasureConfirmationError";
  }
}

export class FileErasureIncompleteError extends Error {
  constructor(
    public readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      "File access was revoked, but private-object erasure did not complete. Retry the same deletion.",
      options,
    );
    this.name = "FileErasureIncompleteError";
  }
}

export class FileDiscardIncompleteError extends Error {
  readonly committed = true;

  constructor(
    readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      "The unattached upload was revoked, but private-object cleanup did not complete. Retry attachment completion to finish cleanup.",
      options,
    );
    this.name = "FileDiscardIncompleteError";
  }
}

export class FileRetentionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileRetentionStateError";
  }
}

const R2_NO_SUCH_MULTIPART_UPLOAD_CODE = 10024;

export function isMissingR2MultipartUpload(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === R2_NO_SUCH_MULTIPART_UPLOAD_CODE
  );
}

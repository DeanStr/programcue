import type { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  FileAccessService,
  type StoredUpload,
  type UploadTarget,
} from "./file-access-service.server";
import {
  FileLifecycleService,
  type FileErasureInput,
} from "./file-lifecycle-service.server";
import {
  FileScanResultService,
  type scanResultSchema,
} from "./file-scan-result-service.server";

export {
  stableLogicalAssetId,
  uploadTargetSchema,
} from "./file-access-service.server";
export type {
  ParticipantTaskEvidenceVersion,
  StoredUpload,
  UploadTarget,
} from "./file-access-service.server";
export {
  FileAccessError,
  FileDiscardIncompleteError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  FileScanConflictError,
  FileScanPendingError,
  FileScanStateError,
  FileVersionNotFoundError,
  isMissingR2MultipartUpload,
} from "./file-service-errors";

/** Stable file-domain façade over access, scan, and retention lifecycles. */
export class FileService {
  private readonly access: FileAccessService;
  private readonly lifecycle: FileLifecycleService;
  private readonly scans: FileScanResultService;

  constructor(env: CloudflareEnvironment) {
    this.access = new FileAccessService(env);
    this.lifecycle = new FileLifecycleService(env);
    this.scans = new FileScanResultService(env);
  }

  assertParticipantTarget(viewer: Viewer, target: UploadTarget) {
    return this.access.assertParticipantTarget(viewer, target);
  }

  assertAdminTarget(viewer: Viewer, target: UploadTarget) {
    return this.access.assertAdminTarget(viewer, target);
  }

  discardUnattachedResourceUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
  ) {
    return this.access.discardUnattachedResourceUpload(viewer, upload);
  }

  discardUnattachedTaskUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
    taskId: string,
  ) {
    return this.access.discardUnattachedTaskUpload(viewer, upload, taskId);
  }

  recordScanResult(rawInput: z.input<typeof scanResultSchema>) {
    return this.scans.recordScanResult(rawInput);
  }

  previewAssetErasure(viewer: Viewer, assetId: string) {
    return this.lifecycle.previewAssetErasure(viewer, assetId);
  }

  eraseAsset(viewer: Viewer, input: FileErasureInput) {
    return this.lifecycle.eraseAsset(viewer, input);
  }

  getFileRetentionState(viewer: Viewer) {
    return this.lifecycle.getFileRetentionState(viewer);
  }

  setFileRetentionHold(
    viewer: Viewer,
    input: { hold: boolean; confirmed: boolean; reason: string },
  ) {
    return this.lifecycle.setFileRetentionHold(viewer, input);
  }

  eraseExpiredEventFiles(
    viewer: Viewer,
    input: { confirmed: boolean; limit?: number },
  ) {
    return this.lifecycle.eraseExpiredEventFiles(viewer, input);
  }

  participantDownload(
    viewer: Viewer,
    assetId: string,
    options: { inlineHeadshot?: boolean } = {},
  ) {
    return this.access.participantDownload(viewer, assetId, options);
  }

  administratorSpeakerFileDownload(
    viewer: Viewer,
    personId: string,
    assetId: string,
    options: { inlineHeadshot?: boolean } = {},
  ) {
    return this.access.administratorSpeakerFileDownload(
      viewer,
      personId,
      assetId,
      options,
    );
  }

  administratorTaskEvidenceDownload(
    viewer: Viewer,
    assetId: string,
    versionId: string,
  ) {
    return this.access.administratorTaskEvidenceDownload(
      viewer,
      assetId,
      versionId,
    );
  }

  participantTaskEvidenceDownload(
    viewer: Viewer,
    assetId: string,
    versionId: string,
  ) {
    return this.access.participantTaskEvidenceDownload(
      viewer,
      assetId,
      versionId,
    );
  }

  listParticipantTaskEvidenceVersions(viewer: Viewer, taskIds: string[]) {
    return this.access.listParticipantTaskEvidenceVersions(viewer, taskIds);
  }

  participantResourceDownload(viewer: Viewer, assetId: string) {
    return this.access.participantResourceDownload(viewer, assetId);
  }
}

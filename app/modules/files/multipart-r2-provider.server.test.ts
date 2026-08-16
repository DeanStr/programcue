import { describe, expect, it, vi } from "vitest";

import {
  MultipartR2Provider,
  type MultipartProviderRow,
} from "./multipart-r2-provider.server";

const row: MultipartProviderRow = {
  objectKey: "quarantine/event/asset/version/file.pdf",
  uploadId: "provider-upload-id",
  sizeBytes: 16,
  partSizeBytes: 10 * 1_048_576,
  contentType: "application/pdf",
  eventId: "event-id",
  assetId: "asset-id",
  versionId: "version-id",
};

describe("multipart R2 completion", () => {
  it("validates the canonical object returned by a strongly consistent head", async () => {
    const completionResult = {
      key: row.objectKey,
      size: row.sizeBytes,
      customMetadata: {},
    } as unknown as R2Object;
    const canonicalObject = {
      ...completionResult,
      customMetadata: {
        eventId: row.eventId,
        assetId: row.assetId,
        versionId: row.versionId,
        quarantine: "pending-scan",
      },
    } as unknown as R2Object;
    const complete = vi.fn().mockResolvedValue(completionResult);
    const head = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(canonicalObject);
    const environment = {
      FILES: {
        head,
        resumeMultipartUpload: vi.fn(() => ({ complete })),
      },
    } as unknown as CloudflareEnvironment;

    const completed = await new MultipartR2Provider(environment).complete(row, [
      { partNumber: 1, etag: "part-etag" },
    ]);

    expect(completed).toBe(canonicalObject);
    expect(complete).toHaveBeenCalledWith([
      { partNumber: 1, etag: "part-etag" },
    ]);
    expect(head).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  type MultipartProviderRow,
  MultipartR2Provider,
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

it("lists parts with a receiver-safe native fetch call", async () => {
  const fetcher = function (this: unknown) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return Promise.resolve(
      new Response(
        "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><Size>16</Size><ETag>real-part-etag</ETag></Part></ListPartsResult>",
      ),
    );
  } as typeof fetch;
  const environment = {
    R2_ACCOUNT_ID: "local-account",
    R2_BUCKET_NAME: "local-files",
    R2_ACCESS_KEY_ID: "local-key",
    R2_SECRET_ACCESS_KEY: "local-secret-0123456789",
  } as CloudflareEnvironment;
  await expect(
    new MultipartR2Provider(environment, { fetch: fetcher }).listParts(row),
  ).resolves.toEqual([{ PartNumber: 1, Size: 16, ETag: "real-part-etag" }]);
});

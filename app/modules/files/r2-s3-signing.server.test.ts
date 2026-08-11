import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  presignR2S3Request,
  R2S3ConfigurationError,
} from "./r2-s3-signing.server";

describe("R2 S3 request signing", () => {
  it("creates a bounded SigV4 UploadPart URL without exposing the secret", async () => {
    const url = new URL(
      await presignR2S3Request({
        env: env as unknown as CloudflareEnvironment,
        method: "PUT",
        objectKey: "private/events/event one/video.mp4",
        query: { partNumber: "7", uploadId: "upload/+id=" },
        expiresSeconds: 900,
        now: new Date("2026-08-10T12:34:56.000Z"),
      }),
    );
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("test-account-id.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(
      "/program-cue-test-files/private/events/event%20one/video.mp4",
    );
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260810T123456Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("partNumber")).toBe("7");
    expect(url.searchParams.get("uploadId")).toBe("upload/+id=");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.search).toMatch(
      /^\?X-Amz-Algorithm=.*&X-Amz-Credential=.*&X-Amz-Date=.*&X-Amz-Expires=.*&X-Amz-SignedHeaders=.*&partNumber=.*&uploadId=.*&X-Amz-Signature=/,
    );
    expect(url.toString()).not.toContain("test-r2-secret-key");
  });

  it("fails before signing when a required production credential is absent", async () => {
    await expect(
      presignR2S3Request({
        env: {
          ...(env as unknown as CloudflareEnvironment),
          R2_SECRET_ACCESS_KEY: "",
        },
        method: "GET",
        objectKey: "private/object",
      }),
    ).rejects.toBeInstanceOf(R2S3ConfigurationError);
  });
});

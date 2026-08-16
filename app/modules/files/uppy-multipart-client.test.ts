import { md5 } from "@noble/hashes/legacy.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProgramCueMultipartSession,
  MultipartResponseContractError,
  MultipartResumeStorageError,
  type ProgramCueMultipartOperation,
  type ProgramCueMultipartRequest,
  readProgramCueMultipartResponse,
  resumableUploadFingerprint,
  resumableUploadStorageKey,
} from "./uppy-multipart-client";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

class SuccessfulUploadRequest extends EventTarget {
  static openedUrls: string[] = [];
  readonly upload = new EventTarget();
  status = 200;
  responseText = "";
  responseType = "";
  timeout = 0;

  open(_method: string, url: string) {
    SuccessfulUploadRequest.openedUrls.push(url);
  }
  setRequestHeader() {}
  getAllResponseHeaders() {
    return 'etag: "uppy-part-etag"\r\n';
  }
  abort() {
    this.dispatchEvent(new Event("abort"));
  }
  send(body: Blob) {
    queueMicrotask(() => {
      const progress = Object.assign(new Event("progress"), {
        lengthComputable: true,
        loaded: body.size,
        total: body.size,
      });
      this.upload.dispatchEvent(progress);
      this.dispatchEvent(new Event("load"));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  SuccessfulUploadRequest.openedUrls = [];
});

describe("Program Cue Uppy multipart adapter", () => {
  it("fingerprints sampled file bytes as well as the authorized upload scope", async () => {
    const original = new File(["same bytes"], "pitch.mp4", {
      type: "video/mp4",
    });
    const same = new File(["same bytes"], "pitch.mp4", {
      type: "video/mp4",
    });
    const changed = new File(["other bytes"], "pitch.mp4", {
      type: "video/mp4",
    });
    await expect(
      resumableUploadFingerprint("submission:one", "video", original),
    ).resolves.toBe(
      await resumableUploadFingerprint("submission:one", "video", same),
    );
    await expect(
      resumableUploadFingerprint("submission:one", "video", changed),
    ).resolves.not.toBe(
      await resumableUploadFingerprint("submission:one", "video", original),
    );
    await expect(
      resumableUploadFingerprint("submission:two", "video", original),
    ).resolves.not.toBe(
      await resumableUploadFingerprint("submission:one", "video", original),
    );
  });

  it("retains the resume hint after completion until the caller persists its attachment", async () => {
    vi.stubGlobal("XMLHttpRequest", SuccessfulUploadRequest);
    const storage = new MemoryStorage();
    const operations: ProgramCueMultipartOperation[] = [];
    const request: ProgramCueMultipartRequest = async <T>(
      operation: ProgramCueMultipartOperation,
      body: Record<string, unknown>,
    ) => {
      operations.push(operation);
      if (operation === "resume") return { upload: null } as T;
      if (operation === "initiate")
        return {
          upload: {
            assetId: "asset-uppy",
            versionId: "version-uppy",
            partSizeBytes: 10 * 1_048_576,
            partCount: 1,
            expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          },
        } as T;
      if (operation === "part-url")
        return { part: { url: "https://r2.example.test/signed-part" } } as T;
      if (operation === "complete") {
        expect(body).toMatchObject({
          versionId: "version-uppy",
          parts: [{ partNumber: 1, etag: '"uppy-part-etag"' }],
        });
        return {
          upload: {
            assetId: "asset-uppy",
            versionId: "version-uppy",
            scanStatus: "pending",
          },
        } as T;
      }
      throw new Error(`Unexpected ${operation} request.`);
    };
    const session = await createProgramCueMultipartSession({
      file: new File(["video"], "pitch.mp4", { type: "video/mp4" }),
      assetKind: "video",
      resumeScope: "applicant:event:submission:video",
      request,
      storage,
    });
    expect(storage.values.size).toBe(1);
    await expect(session.upload()).resolves.toEqual({
      assetId: "asset-uppy",
      versionId: "version-uppy",
      scanStatus: "pending",
    });
    expect(operations).toEqual(["resume", "initiate", "part-url", "complete"]);
    expect(storage.values.size).toBe(1);
    session.markAttached();
    expect(storage.values.size).toBe(0);
    session.disposePreservingUpload();
  });

  it("reselects an interrupted file, lists R2 parts and uploads only the missing part", async () => {
    vi.stubGlobal("XMLHttpRequest", SuccessfulUploadRequest);
    const storage = new MemoryStorage();
    const file = new File([new Uint8Array(12 * 1_048_576)], "resume.mp4", {
      type: "video/mp4",
    });
    const scope = "applicant:event:submission:video";
    const existingEtag = Array.from(md5(new Uint8Array(10 * 1_048_576)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const storageKey = await resumableUploadStorageKey(scope, "video", file);
    storage.setItem(
      storageKey,
      JSON.stringify({
        idempotencyKey: "stable-browser-resume-key",
        versionId: "version-resume",
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      }),
    );
    const operations: ProgramCueMultipartOperation[] = [];
    const request: ProgramCueMultipartRequest = async <T>(
      operation: ProgramCueMultipartOperation,
      body: Record<string, unknown>,
      options?: { idempotencyKey?: string; signal?: AbortSignal },
    ) => {
      operations.push(operation);
      if (operation === "resume") {
        expect(options?.idempotencyKey).toBe("stable-browser-resume-key");
        return {
          upload: {
            assetId: "asset-resume",
            versionId: "version-resume",
            partSizeBytes: 10 * 1_048_576,
            partCount: 2,
            expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          },
        } as T;
      }
      if (operation === "list-parts")
        return {
          parts: [
            {
              PartNumber: 1,
              Size: 10 * 1_048_576,
              ETag: `"${existingEtag}"`,
            },
          ],
        } as T;
      if (operation === "part-url") {
        expect(body.partNumber).toBe(2);
        return {
          part: { url: "https://r2.example.test/signed-part-2" },
        } as T;
      }
      if (operation === "complete") {
        expect(body.parts).toEqual([
          { partNumber: 1, etag: `"${existingEtag}"` },
          { partNumber: 2, etag: '"uppy-part-etag"' },
        ]);
        return {
          upload: {
            assetId: "asset-resume",
            versionId: "version-resume",
            scanStatus: "pending",
          },
        } as T;
      }
      throw new Error(`Unexpected ${operation} request.`);
    };
    const session = await createProgramCueMultipartSession({
      file,
      assetKind: "video",
      resumeScope: scope,
      request,
      storage,
    });
    await expect(session.upload()).resolves.toMatchObject({
      versionId: "version-resume",
    });
    expect(operations).toEqual([
      "resume",
      "list-parts",
      "part-url",
      "complete",
    ]);
    expect(SuccessfulUploadRequest.openedUrls).toEqual([
      "https://r2.example.test/signed-part-2",
    ]);
    expect(storage.values.size).toBe(1);
    session.markAttached();
    expect(storage.values.size).toBe(0);
    session.disposePreservingUpload();
  });

  it("does not contact the server when durable resume storage is unavailable", async () => {
    const request = vi.fn(async () => {
      throw new Error("The request must not run.");
    }) as unknown as ProgramCueMultipartRequest;
    await expect(
      createProgramCueMultipartSession({
        file: new File(["video"], "pitch.mp4", { type: "video/mp4" }),
        assetKind: "video",
        resumeScope: "submission:no-storage",
        request,
        storage: null,
      }),
    ).rejects.toBeInstanceOf(MultipartResumeStorageError);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not replace a corrupt resume identity with a fresh upload", async () => {
    const storage = new MemoryStorage();
    const file = new File(["video"], "pitch.mp4", { type: "video/mp4" });
    const scope = "submission:corrupt-storage";
    storage.setItem(
      await resumableUploadStorageKey(scope, "video", file),
      "not-json",
    );
    const request = vi.fn(async () => {
      throw new Error("The request must not run.");
    }) as unknown as ProgramCueMultipartRequest;
    await expect(
      createProgramCueMultipartSession({
        file,
        assetKind: "video",
        resumeScope: scope,
        request,
        storage,
      }),
    ).rejects.toBeInstanceOf(MultipartResumeStorageError);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not contact the server when the new resume identity cannot be persisted", async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {};
    const request = vi.fn(async () => {
      throw new Error("The request must not run.");
    }) as unknown as ProgramCueMultipartRequest;
    await expect(
      createProgramCueMultipartSession({
        file: new File(["video"], "pitch.mp4", { type: "video/mp4" }),
        assetKind: "video",
        resumeScope: "submission:write-failure",
        request,
        storage,
      }),
    ).rejects.toBeInstanceOf(MultipartResumeStorageError);
    expect(request).not.toHaveBeenCalled();
  });

  it("clears a local resume identity that no longer exists on the server", async () => {
    const storage = new MemoryStorage();
    const file = new File(["video"], "missing-resume.mp4", {
      type: "video/mp4",
    });
    const scope = "submission:missing-server-resume";
    const storageKey = await resumableUploadStorageKey(scope, "video", file);
    storage.setItem(
      storageKey,
      JSON.stringify({
        idempotencyKey: "missing-server-resume-key",
        versionId: "missing-version",
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      }),
    );
    const request = vi.fn(async () => ({
      upload: null,
    })) as unknown as ProgramCueMultipartRequest;

    await expect(
      createProgramCueMultipartSession({
        file,
        assetKind: "video",
        resumeScope: scope,
        request,
        storage,
      }),
    ).rejects.toThrow(/stale local resume record was cleared/i);
    expect(storage.getItem(storageKey)).toBeNull();
    expect(request).toHaveBeenCalledOnce();

    const replacement = await createProgramCueMultipartSession({
      file,
      assetKind: "video",
      resumeScope: scope,
      request,
      storage,
    });
    expect(storage.getItem(storageKey)).not.toBeNull();
    replacement.disposePreservingUpload();
  });

  it("rejects malformed successful multipart HTTP responses", async () => {
    await expect(
      readProgramCueMultipartResponse(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "abort",
      ),
    ).rejects.toBeInstanceOf(MultipartResponseContractError);
    await expect(
      readProgramCueMultipartResponse(
        Response.json({ ok: true }, { status: 200 }),
        "abort",
      ),
    ).rejects.toBeInstanceOf(MultipartResponseContractError);
  });

  it("retains bounded server errors for unsuccessful multipart responses", async () => {
    await expect(
      readProgramCueMultipartResponse(
        Response.json(
          { error: "The upload is no longer active." },
          { status: 409 },
        ),
        "resume",
      ),
    ).rejects.toThrow("The upload is no longer active.");
  });
});

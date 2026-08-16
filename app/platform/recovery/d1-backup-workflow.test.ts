import { env } from "cloudflare:test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  D1_BACKUP_FORMAT,
  type D1BackupManifest,
  downloadD1Export,
  parseD1ExportEnvelope,
  readExistingBackupManifest,
  requestD1ExportState,
  requireProductionBackupRuntime,
  runD1BackupWorkflow,
  scheduleDailyD1Backup,
  storeBackupStream,
  utcBackupDate,
  verifyDailyD1Backup,
  writeBackupManifest,
} from "../../../workers/d1-backup-workflow";

const configuration = {
  accountId: "0123456789abcdef0123456789abcdef",
  databaseId: "12345678-1234-4234-8234-123456789abc",
  apiToken: "test-d1-export-token",
};
const signedUrl =
  "https://program-cue.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/export.sql?X-Amz-Signature=test";

function envelope(
  result: Record<string, unknown>,
  options: { success?: boolean; errors?: unknown[] } = {},
) {
  return {
    success: options.success ?? true,
    errors: options.errors ?? [],
    messages: [],
    result: {
      at_bookmark:
        "00000001-00000001-00004af0-4c272e70e7f7dc1d621ce046b88ad6c7",
      success: true,
      type: "export",
      ...result,
    },
  };
}

function backupBucket() {
  return (env as unknown as { BACKUPS: R2Bucket }).BACKUPS;
}

function exactLengthResponse(body: string) {
  return new Response(body, {
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
  });
}

function immediateWorkflowStep(retryOnceFor?: string) {
  let retried = false;
  return {
    do: vi.fn(
      async (
        _name: string,
        configOrCallback: unknown,
        possibleCallback?: unknown,
      ) => {
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : possibleCallback;
        if (typeof callback !== "function") {
          throw new Error("Test Workflow step callback is missing.");
        }
        const context = {
          attempt: 0,
          config:
            typeof configOrCallback === "object" && configOrCallback
              ? configOrCallback
              : {},
          step: { count: 1, name: _name },
        };
        try {
          return await callback(context);
        } catch (error) {
          if (_name !== retryOnceFor || retried) throw error;
          retried = true;
          return callback({ ...context, attempt: 1 });
        }
      },
    ),
    sleep: vi.fn(async () => undefined),
  } as unknown as WorkflowStep;
}

describe("scheduled D1 backup Workflow boundaries", () => {
  beforeEach(async () => {
    const bucket = backupBucket();
    const listed = await bucket.list({ prefix: "d1-logical/" });
    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
  });

  it("uses the scheduled UTC date as an idempotent Workflow instance identity", async () => {
    const createBatch = vi
      .fn()
      .mockResolvedValue([{ id: "d1-backup-2026-08-10" }]);
    const get = vi.fn();
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const scheduledTime = Date.parse("2026-08-10T02:17:00.000Z");

    await expect(
      scheduleDailyD1Backup(
        {
          D1_BACKUP_WORKFLOW: { createBatch, get } as unknown as Workflow<{
            backupDate: string;
            scheduledTime: number;
          }>,
          APP_ENV: "test",
          SOURCE_REVISION: "test-revision",
        },
        scheduledTime,
      ),
    ).resolves.toEqual({
      backupDate: "2026-08-10",
      instanceId: "d1-backup-2026-08-10",
      created: true,
    });
    expect(createBatch).toHaveBeenCalledWith([
      {
        id: "d1-backup-2026-08-10",
        params: { backupDate: "2026-08-10", scheduledTime },
      },
    ]);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining('"sourceRevision":"test-revision"'),
    );

    createBatch.mockRejectedValueOnce(
      new Error("A Workflow instance with this ID already exists."),
    );
    get.mockResolvedValueOnce({
      id: "d1-backup-2026-08-10",
      status: vi.fn().mockResolvedValue({ status: "complete" }),
    });
    await expect(
      scheduleDailyD1Backup(
        {
          D1_BACKUP_WORKFLOW: { createBatch, get } as unknown as Workflow<{
            backupDate: string;
            scheduledTime: number;
          }>,
          APP_ENV: "test",
          SOURCE_REVISION: "test-revision",
        },
        scheduledTime,
      ),
    ).resolves.toMatchObject({ created: false });
    expect(get).toHaveBeenCalledWith("d1-backup-2026-08-10");
    infoLog.mockRestore();
  });

  it("does not report scheduler success for an invalid batch result or an unverifiable create failure", async () => {
    const scheduledTime = Date.parse("2026-08-10T02:17:00.000Z");
    const createBatch = vi.fn().mockResolvedValue([]);
    const get = vi.fn().mockRejectedValue(new Error("Instance not found."));
    const workflow = { createBatch, get } as unknown as Workflow<{
      backupDate: string;
      scheduledTime: number;
    }>;

    await expect(
      scheduleDailyD1Backup({ D1_BACKUP_WORKFLOW: workflow }, scheduledTime),
    ).rejects.toThrow("could not be created or verified");

    createBatch.mockRejectedValueOnce(new Error("Workflow RPC unavailable."));
    await expect(
      scheduleDailyD1Backup({ D1_BACKUP_WORKFLOW: workflow }, scheduledTime),
    ).rejects.toThrow("could not be created or verified");
  });

  it.each(["errored", "terminated"] as const)(
    "does not deduplicate a daily backup whose existing Workflow is %s",
    async (status) => {
      const scheduledTime = Date.parse("2026-08-10T02:17:00.000Z");
      const createError = new Error(
        "A Workflow instance with this ID already exists.",
      );
      const createBatch = vi.fn().mockRejectedValue(createError);
      const get = vi.fn().mockResolvedValue({
        id: "d1-backup-2026-08-10",
        status: vi.fn().mockResolvedValue({ status }),
      });
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await expect(
        scheduleDailyD1Backup(
          {
            D1_BACKUP_WORKFLOW: { createBatch, get } as unknown as Workflow<{
              backupDate: string;
              scheduledTime: number;
            }>,
            APP_ENV: "test",
            SOURCE_REVISION: "test-revision",
          },
          scheduledTime,
        ),
      ).rejects.toThrow(`Workflow instance is ${status}`);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(`"instanceStatus":"${status}"`),
      );
      errorLog.mockRestore();
    },
  );

  it("rejects invalid scheduler timestamps instead of inventing a backup day", () => {
    expect(() => utcBackupDate(Number.NaN)).toThrow(
      "backup schedule timestamp must be finite",
    );
  });

  it("fails the daily monitor when private R2 lacks the expected backup and verifies exact stored evidence", async () => {
    const bucket = backupBucket();
    const backupDate = "2026-08-10";
    const scheduledTime = Date.parse(`${backupDate}T03:47:00.000Z`);
    const monitorEnvironment = {
      BACKUPS: bucket,
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
      D1_DATABASE_ID: configuration.databaseId,
      SOURCE_REVISION: "abc1234",
    };

    await expect(
      verifyDailyD1Backup(monitorEnvironment, scheduledTime),
    ).rejects.toThrow(`daily D1 backup for ${backupDate} is missing`);

    const backupKey = `d1-logical/${backupDate}/program-cue-${backupDate}.sql`;
    const sql = "CREATE TABLE monitor_evidence(id TEXT);\n";
    const stored = await storeBackupStream(bucket, new Blob([sql]).stream(), {
      backupKey,
      backupDate,
      databaseId: configuration.databaseId,
      bookmark: "bookmark-monitor",
      workflowInstanceId: `d1-backup-${backupDate}`,
      expectedBytes: new TextEncoder().encode(sql).byteLength,
    });
    const manifest: D1BackupManifest = {
      format: D1_BACKUP_FORMAT,
      backupDate,
      scheduledFor: `${backupDate}T02:17:00.000Z`,
      databaseId: configuration.databaseId,
      bookmark: "bookmark-monitor",
      sourceFilename: "export.sql",
      ...stored,
      workflowInstanceId: `d1-backup-${backupDate}`,
    };
    await writeBackupManifest(bucket, `${backupKey}.manifest.json`, manifest);
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    await expect(
      verifyDailyD1Backup(monitorEnvironment, scheduledTime),
    ).resolves.toEqual(manifest);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining('"event":"monitor-verified"'),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining('"sourceRevision":"abc1234"'),
    );
    infoLog.mockRestore();
  });

  it("restricts direct Workflow execution to the production runtime", () => {
    expect(() =>
      requireProductionBackupRuntime({
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "false",
      }),
    ).not.toThrow();
    expect(() =>
      requireProductionBackupRuntime({
        APP_ENV: "test",
        DEMO_MODE: "true",
        EVALUATION_MODE: "false",
      }),
    ).toThrow("restricted to the production runtime");
    expect(() => requireProductionBackupRuntime({})).toThrow(
      "explicit production runtime configuration",
    );
  });

  it("parses pending and complete Cloudflare polling responses strictly", () => {
    expect(parseD1ExportEnvelope(envelope({}))).toEqual({
      phase: "pending",
      bookmark: "00000001-00000001-00004af0-4c272e70e7f7dc1d621ce046b88ad6c7",
    });
    expect(parseD1ExportEnvelope(envelope({ status: "active" }))).toEqual({
      phase: "pending",
      bookmark: "00000001-00000001-00004af0-4c272e70e7f7dc1d621ce046b88ad6c7",
    });
    expect(
      parseD1ExportEnvelope(
        envelope({
          status: "complete",
          result: { filename: "export.sql", signed_url: signedUrl },
        }),
      ),
    ).toEqual({
      phase: "complete",
      bookmark: "00000001-00000001-00004af0-4c272e70e7f7dc1d621ce046b88ad6c7",
      filename: "export.sql",
      signedUrl,
    });
  });

  it("fails fast on provider error states and non-R2 download URLs", () => {
    expect(() =>
      parseD1ExportEnvelope(
        envelope({ status: "error", error: "export was cancelled" }),
      ),
    ).toThrow("Cloudflare D1 export failed: export was cancelled");
    expect(() =>
      parseD1ExportEnvelope(
        envelope({
          status: "complete",
          result: {
            filename: "export.sql",
            signed_url: "https://127.0.0.1/export.sql",
          },
        }),
      ),
    ).toThrow("outside the HTTPS R2 service domain");
    expect(() =>
      parseD1ExportEnvelope(
        envelope({
          at_bookmark: undefined,
          success: false,
          error: "Not currently exporting anything.",
        }),
      ),
    ).toThrow("Cloudflare D1 export failed: Not currently exporting anything.");
  });

  it("uses the documented initiate and bookmark-poll request bodies", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json(envelope({}));
      },
    );

    await requestD1ExportState(configuration, undefined, fetcher);
    await requestD1ExportState(configuration, "bookmark-one", fetcher);

    expect(requests.map((request) => request.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/d1/database/${configuration.databaseId}/export`,
      `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/d1/database/${configuration.databaseId}/export`,
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${configuration.apiToken}`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await expect(requests[0]?.json()).resolves.toEqual({
      output_format: "polling",
    });
    await expect(requests[1]?.json()).resolves.toEqual({
      current_bookmark: "bookmark-one",
      output_format: "polling",
    });
  });

  it("does not retry malformed credentials as a pretend provider success", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { success: false, errors: [{ code: 9109, message: "Invalid token" }] },
        { status: 403 },
      ),
    );

    await expect(
      requestD1ExportState(configuration, undefined, fetcher),
    ).rejects.toMatchObject({
      name: "NonRetryableError",
      message: expect.stringContaining("9109: Invalid token"),
    });
  });

  it("rejects an oversized export API response before parsing it", async () => {
    await expect(
      requestD1ExportState(configuration, undefined, async () =>
        Response.json(envelope({}), {
          headers: { "content-length": String(256 * 1024 + 1) },
        }),
      ),
    ).rejects.toThrow("response exceeded the 256 KiB limit");
  });

  it("bounds export API and signed-download waits with retryable timeout failures", async () => {
    const timeout = new DOMException("Timed out", "TimeoutError");
    await expect(
      requestD1ExportState(configuration, undefined, async () => {
        throw timeout;
      }),
    ).rejects.toThrow("export request timed out");

    const fetcher = vi.fn().mockRejectedValueOnce(timeout);
    await expect(
      downloadD1Export(
        {
          phase: "complete",
          bookmark: "bookmark-one",
          filename: "export.sql",
          signedUrl,
        },
        fetcher,
      ),
    ).rejects.toThrow("export download timed out");
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("downloads the completed signed export as a stream without polling again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        exactLengthResponse("CREATE TABLE evidence(id TEXT);"),
      );

    const download = await downloadD1Export(
      {
        phase: "complete",
        bookmark: "00000001-00000001-00004af0-4c272e70e7f7dc1d621ce046b88ad6c7",
        filename: "export.sql",
        signedUrl,
      },
      fetcher,
    );
    expect(download.bytes).toBe(31);
    expect(download.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(download.body).text()).toBe(
      "CREATE TABLE evidence(id TEXT);",
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails before storage when the signed export omits its exact length", async () => {
    const response = new Response("CREATE TABLE evidence(id TEXT);");
    response.headers.delete("content-length");

    await expect(
      downloadD1Export(
        {
          phase: "complete",
          bookmark: "bookmark-one",
          filename: "export.sql",
          signedUrl,
        },
        vi.fn().mockResolvedValueOnce(response),
      ),
    ).rejects.toThrow("did not declare an exact content length");
  });

  it("streams bytes to private R2 and writes an immutable verifiable manifest", async () => {
    const bucket = backupBucket();
    const backupDate = "2026-08-10";
    const backupKey = `d1-logical/${backupDate}/program-cue-${backupDate}.sql`;
    const manifestKey = `${backupKey}.manifest.json`;
    const sql =
      "CREATE TABLE evidence(id TEXT);\nINSERT INTO evidence VALUES ('ok');\n";
    const stored = await storeBackupStream(bucket, new Blob([sql]).stream(), {
      backupKey,
      backupDate,
      databaseId: configuration.databaseId,
      bookmark: "bookmark-one",
      workflowInstanceId: `d1-backup-${backupDate}`,
      expectedBytes: new TextEncoder().encode(sql).byteLength,
    });

    expect(stored).toMatchObject({
      backupKey,
      bytes: new TextEncoder().encode(sql).byteLength,
      sha256:
        "8d04ec2d5b105a3daf4a9d31986d6505c988fd26be2b65b9de8dcd9d43dedc31",
    });
    expect(await (await bucket.get(backupKey))?.text()).toBe(sql);
    await expect(
      storeBackupStream(bucket, new Blob([sql]).stream(), {
        backupKey,
        backupDate,
        databaseId: configuration.databaseId,
        bookmark: "bookmark-one",
        workflowInstanceId: `d1-backup-${backupDate}`,
        expectedBytes: new TextEncoder().encode(sql).byteLength,
      }),
    ).resolves.toEqual(stored);
    await expect(
      storeBackupStream(bucket, new Blob([`${sql}-- different\n`]).stream(), {
        backupKey,
        backupDate,
        databaseId: configuration.databaseId,
        bookmark: "bookmark-one",
        workflowInstanceId: `d1-backup-${backupDate}`,
        expectedBytes: new TextEncoder().encode(`${sql}-- different\n`)
          .byteLength,
      }),
    ).rejects.toMatchObject({
      name: "NonRetryableError",
      message: expect.stringContaining("different immutable R2 object"),
    });
    expect(await (await bucket.get(backupKey))?.text()).toBe(sql);

    const manifest: D1BackupManifest = {
      format: D1_BACKUP_FORMAT,
      backupDate,
      scheduledFor: "2026-08-10T02:17:00.000Z",
      databaseId: configuration.databaseId,
      bookmark: "bookmark-one",
      sourceFilename: "export.sql",
      ...stored,
      workflowInstanceId: `d1-backup-${backupDate}`,
    };
    await expect(
      writeBackupManifest(bucket, manifestKey, manifest),
    ).resolves.toEqual(manifest);
    await expect(
      writeBackupManifest(bucket, manifestKey, manifest),
    ).resolves.toEqual(manifest);
    await expect(
      readExistingBackupManifest(bucket, manifestKey, {
        backupDate,
        databaseId: configuration.databaseId,
        backupKey,
      }),
    ).resolves.toEqual(manifest);
  });

  it("cancels an existing recovery body when the fresh export cannot be digested", async () => {
    let existingBodyCancelled = false;
    const existingBody = new ReadableStream<Uint8Array>({
      cancel() {
        existingBodyCancelled = true;
      },
    });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: existingBody,
        etag: "existing-etag",
        uploaded: new Date("2026-08-13T02:17:00Z"),
      }),
    } as unknown as R2Bucket;
    const brokenSource = new TransformStream<Uint8Array, Uint8Array>();
    const sourceWriter = brokenSource.writable.getWriter();

    const stored = storeBackupStream(bucket, brokenSource.readable, {
      backupKey: "d1-logical/2026-08-13/program-cue-2026-08-13.sql",
      backupDate: "2026-08-13",
      databaseId: configuration.databaseId,
      bookmark: "bookmark-recovery",
      workflowInstanceId: "d1-backup-2026-08-13",
      expectedBytes: 100,
    });
    const rejected = expect(stored).rejects.toThrow(
      "Fresh export stream failed",
    );
    await sourceWriter.abort(new Error("Fresh export stream failed."));
    await rejected;
    expect(existingBodyCancelled).toBe(true);
  });

  it("does not pull the complete export while the R2 consumer is paused", async () => {
    const chunkCount = 128;
    let sourcePulls = 0;
    let releaseUpload!: () => void;
    let observedFirstChunk!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const firstChunkObserved = new Promise<void>((resolve) => {
      observedFirstChunk = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sourcePulls === chunkCount) {
          controller.close();
          return;
        }
        sourcePulls += 1;
        controller.enqueue(Uint8Array.of(sourcePulls % 251));
      },
    });
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(async (_key: string, value: unknown) => {
        if (!(value instanceof ReadableStream)) {
          throw new Error("The backup upload was not a readable stream.");
        }
        const reader = value.getReader();
        let bytes = 0;
        const first = await reader.read();
        bytes += first.value?.byteLength ?? 0;
        observedFirstChunk();
        await uploadReleased;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
        }
        return {
          size: bytes,
          etag: "backpressure-etag",
          uploaded: new Date("2026-08-13T02:17:00.000Z"),
        } as R2Object;
      }),
    } as unknown as R2Bucket;
    const storedPromise = storeBackupStream(bucket, source, {
      backupKey: "d1-logical/2026-08-13/program-cue-2026-08-13.sql",
      backupDate: "2026-08-13",
      databaseId: configuration.databaseId,
      bookmark: "bookmark-backpressure",
      workflowInstanceId: "d1-backup-2026-08-13",
      expectedBytes: chunkCount,
    });

    await firstChunkObserved;
    expect(sourcePulls).toBeLessThan(chunkCount);
    releaseUpload();
    await expect(storedPromise).resolves.toMatchObject({
      bytes: chunkCount,
      objectEtag: "backpressure-etag",
    });
  });

  it("aborts the digest pump when a conditional R2 write retains the stream lock", async () => {
    const chunkCount = 1_000_000;
    let sourcePulls = 0;
    let sourceCancelled = false;
    let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        sourcePulls += 1;
        controller.enqueue(Uint8Array.of(sourcePulls % 251));
        if (sourcePulls === chunkCount) controller.close();
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const bucket = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(async (_key: string, value: unknown) => {
        if (!(value instanceof ReadableStream)) {
          throw new Error("The backup upload was not a readable stream.");
        }
        uploadReader = value.getReader();
        void uploadReader.closed.catch(() => undefined);
        return null;
      }),
    } as unknown as R2Bucket;

    await expect(
      storeBackupStream(bucket, source, {
        backupKey: "d1-logical/2026-08-13/program-cue-2026-08-13.sql",
        backupDate: "2026-08-13",
        databaseId: configuration.databaseId,
        bookmark: "bookmark-conflict",
        workflowInstanceId: "d1-backup-2026-08-13",
        expectedBytes: chunkCount,
      }),
    ).rejects.toThrow("reserved concurrently");
    expect(sourceCancelled).toBe(true);
    expect(sourcePulls).toBeLessThan(chunkCount);
    uploadReader?.releaseLock();
  });

  it("rejects an empty export before reserving its immutable daily key", async () => {
    const bucket = backupBucket();
    const backupDate = "2026-08-10";
    const backupKey = `d1-logical/${backupDate}/program-cue-${backupDate}.sql`;
    const input = {
      backupKey,
      backupDate,
      databaseId: configuration.databaseId,
      bookmark: "bookmark-empty-retry",
      workflowInstanceId: `d1-backup-${backupDate}`,
      expectedBytes: 0,
    };

    await expect(
      storeBackupStream(bucket, new Blob([]).stream(), input),
    ).rejects.toThrow("Cloudflare returned an empty D1 logical export");
    await expect(bucket.get(backupKey)).resolves.toBeNull();

    await expect(
      storeBackupStream(
        bucket,
        new Blob(["CREATE TABLE recovered(id TEXT);\n"]).stream(),
        { ...input, expectedBytes: 33 },
      ),
    ).resolves.toMatchObject({ backupKey, bytes: 33 });
  });

  it("runs the durable initiate, poll, download, storage and manifest sequence", async () => {
    const bucket = backupBucket();
    const scheduledTime = Date.parse("2026-08-11T02:17:00.000Z");
    const event: WorkflowEvent<{
      backupDate: string;
      scheduledTime: number;
    }> = {
      instanceId: "d1-backup-2026-08-11",
      workflowName: "program-cue-d1-backup",
      timestamp: new Date(scheduledTime),
      payload: { backupDate: "2026-08-11", scheduledTime },
    };
    let apiCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.cloudflare.com/")) {
        apiCalls += 1;
        return Response.json(
          apiCalls === 1
            ? envelope({ status: "active" })
            : apiCalls === 2
              ? envelope({ status: "active" })
              : envelope({
                  status: "complete",
                  result: { filename: "export.sql", signed_url: signedUrl },
                }),
        );
      }
      if (url === signedUrl) {
        return exactLengthResponse(
          "CREATE TABLE workflow_evidence(id TEXT);\n",
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    try {
      const environment = {
        BACKUPS: bucket,
        CLOUDFLARE_ACCOUNT_ID: configuration.accountId,
        D1_DATABASE_ID: configuration.databaseId,
        D1_REST_API_TOKEN: configuration.apiToken,
      };
      const step = immediateWorkflowStep();
      const output = await runD1BackupWorkflow(environment, event, step);

      expect(output).toMatchObject({
        format: D1_BACKUP_FORMAT,
        backupDate: "2026-08-11",
        workflowInstanceId: "d1-backup-2026-08-11",
      });
      expect(apiCalls).toBe(3);
      expect(step.sleep).toHaveBeenCalledWith(
        "wait before D1 export poll",
        "1 second",
      );
      expect(
        await bucket.head(
          "d1-logical/2026-08-11/program-cue-2026-08-11.sql.manifest.json",
        ),
      ).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("downloads a fresh stream when the retryable R2 storage step retries", async () => {
    const bucket = backupBucket();
    const backupDate = "2026-08-13";
    const scheduledTime = Date.parse(`${backupDate}T02:17:00.000Z`);
    let exportApiCalls = 0;
    let signedDownloads = 0;
    let sqlPutAttempts = 0;
    const flakyBucket = {
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const [key] = args;
        if (key.endsWith(".sql")) {
          sqlPutAttempts += 1;
          if (sqlPutAttempts === 1) {
            throw new Error("Simulated transient R2 write failure.");
          }
        }
        return bucket.put(...args);
      },
    } as unknown as R2Bucket;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.cloudflare.com/")) {
        exportApiCalls += 1;
        return Response.json(
          exportApiCalls === 1
            ? envelope({})
            : envelope({
                status: "complete",
                result: { filename: "export.sql", signed_url: signedUrl },
              }),
        );
      }
      if (url === signedUrl) {
        signedDownloads += 1;
        return exactLengthResponse(
          `CREATE TABLE retry_evidence(id TEXT);\n-- download ${signedDownloads}\n`,
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    try {
      const output = await runD1BackupWorkflow(
        {
          BACKUPS: flakyBucket,
          CLOUDFLARE_ACCOUNT_ID: configuration.accountId,
          D1_DATABASE_ID: configuration.databaseId,
          D1_REST_API_TOKEN: configuration.apiToken,
        },
        {
          instanceId: `d1-backup-${backupDate}`,
          workflowName: "program-cue-d1-backup",
          timestamp: new Date(scheduledTime),
          payload: { backupDate, scheduledTime },
        },
        immediateWorkflowStep("download and stream D1 export to private R2"),
      );

      expect(output).toMatchObject({ backupDate });
      expect(sqlPutAttempts).toBe(2);
      expect(signedDownloads).toBe(2);
      expect(
        await bucket.get(
          `d1-logical/${backupDate}/program-cue-${backupDate}.sql`,
        ),
      ).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails a Workflow with a specific non-retryable configuration error", async () => {
    const scheduledTime = Date.parse("2026-08-12T02:17:00.000Z");
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const environment = {
      BACKUPS: backupBucket(),
      APP_ENV: "test",
      SOURCE_REVISION: "test-revision",
    };

    await expect(
      runD1BackupWorkflow(
        environment,
        {
          instanceId: "d1-backup-2026-08-12",
          workflowName: "program-cue-d1-backup",
          timestamp: new Date(scheduledTime),
          payload: { backupDate: "2026-08-12", scheduledTime },
        },
        immediateWorkflowStep(),
      ),
    ).rejects.toMatchObject({
      name: "NonRetryableError",
      message: expect.stringContaining("CLOUDFLARE_ACCOUNT_ID"),
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"event":"failed"'),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"sourceRevision":"test-revision"'),
    );
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain(
      "CLOUDFLARE_ACCOUNT_ID",
    );
    errorLog.mockRestore();
  });
});

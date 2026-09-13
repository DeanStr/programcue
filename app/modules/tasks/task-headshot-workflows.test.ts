import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "~/modules/files/direct-upload.test-helper";
import {
  CANONICAL_EVENT_FILE_POLICY,
  FILE_SIZE_MIB,
} from "~/modules/files/file-policy";
import { FileService } from "~/modules/files/file-service.server";
import { MultipartUploadService } from "~/modules/files/multipart-upload.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  admin,
  createFileTask,
  speaker,
  submitter,
  testPdfFile,
} from "./task-participant-workflows.test-support";
import { TaskService } from "./task-service.server";

it("collects private headshot task versions with image limits and clean-scan approval", async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoSpeakerData(testEnv);
  // Image requests must keep their own limit even when document limits are lower.
  await testEnv.DB.prepare(
    "UPDATE events SET file_policy_json = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({
        ...CANONICAL_EVENT_FILE_POLICY,
        supportingDocumentMaximumBytes: FILE_SIZE_MIB,
      }),
      speaker.eventId,
    )
    .run();
  const taskId = await createFileTask(
    testEnv,
    "Final print headshot",
    "headshot",
  );
  const target = {
    targetType: "task",
    targetId: taskId,
    assetKind: "task_evidence",
  } as const;
  const tasks = new TaskService(testEnv);
  const files = new FileService(testEnv);
  await expect(
    completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      testPdfFile("wrong.pdf"),
    ),
  ).rejects.toThrow("extension is not allowed");
  await expect(
    completeTestDirectUpload(
      testEnv,
      submitter,
      target,
      new File(
        [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        "private.png",
        { type: "image/png" },
      ),
    ),
  ).rejects.toThrow("does not belong");

  await expect(
    completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File(["%PDF-1.7 fake image"], "disguised.png", { type: "image/png" }),
    ),
  ).rejects.toThrow(/signature|contents|content/);

  const uploads = [];
  for (const marker of [1, 2]) {
    const bytes = new Uint8Array(marker === 2 ? FILE_SIZE_MIB + 1 : 9);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, marker]);
    const upload = await completeTestDirectUpload(
      testEnv,
      speaker,
      target,
      new File([bytes], `headshot-${marker}.png`, { type: "image/png" }),
    );
    uploads.push(upload);
    await tasks.attachCompletedFileEvidence(speaker, {
      taskId,
      assetId: upload.assetId,
      versionId: upload.versionId,
    });
    const task = (await tasks.getAdminWorkspace(admin)).tasks.find(
      (item) => item.id === taskId,
    )!;
    expect(task.status).toBe("submitted");
    await expect(
      tasks.administerTask(admin, {
        taskId,
        revision: task.revision,
        intent: "approve",
        reason: "",
      }),
    ).rejects.toThrow("still quarantined");
    await expect(
      files.administratorTaskEvidenceDownload(
        admin,
        upload.assetId,
        upload.versionId,
      ),
    ).rejects.toThrow();
    await files.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        testEnv,
        speaker.eventId,
        upload.versionId,
      )),
      eventId: speaker.eventId,
      versionId: upload.versionId,
      provider: "test-scanner",
      callbackId: `callback-${upload.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    const download = await files.administratorTaskEvidenceDownload(
      admin,
      upload.assetId,
      upload.versionId,
    );
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  }
  expect(uploads[1]).toMatchObject({
    assetId: uploads[0].assetId,
    versionNumber: 2,
  });
  expect(
    await files.listParticipantTaskEvidenceVersions(speaker, [taskId]),
  ).toEqual([
    expect.objectContaining({
      versionNumber: 2,
      current: true,
      downloadAvailable: true,
    }),
    expect.objectContaining({
      versionNumber: 1,
      current: false,
      downloadAvailable: true,
    }),
  ]);
  const task = (await tasks.getAdminWorkspace(admin)).tasks.find(
    (item) => item.id === taskId,
  )!;
  await tasks.administerTask(admin, {
    taskId,
    revision: task.revision,
    intent: "approve",
    reason: "",
  });
  expect(
    (await tasks.getAdminWorkspace(admin)).tasks.find(
      (item) => item.id === taskId,
    )?.status,
  ).toBe("completed");

  const limitTask = await createFileTask(
    testEnv,
    "Headshot size limit",
    "headshot",
  );
  const directEnv = {
    ...testEnv,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
  await expect(
    new MultipartUploadService(directEnv).initiate(speaker, {
      target: { ...target, targetId: limitTask },
      filename: "too-large.png",
      contentType: "image/png",
      sizeBytes: CANONICAL_EVENT_FILE_POLICY.headshotMaximumBytes + 1,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toThrow(
    `${CANONICAL_EVENT_FILE_POLICY.headshotMaximumBytes / FILE_SIZE_MIB} MB event limit`,
  );
});

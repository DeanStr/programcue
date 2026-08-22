import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptTestFileScanDispatch,
  completeTestDirectUpload,
} from "~/modules/files/direct-upload.test-helper";
import { FileService } from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "./task-evidence-attachment";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const taskId = "task-demo-slides";
const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId,
  demo: true,
};

function context(environment: CloudflareEnvironment = workerEnv) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(
  body: BodyInit | null,
  options: {
    method?: string;
    role?: "administrator" | "speaker" | "submitter";
    selectedEventId?: string;
    contentType?: string;
  } = {},
) {
  const method = options.method ?? "POST";
  const headers = new Headers({
    cookie: [
      `program_cue_demo_identity=${options.role ?? "speaker"}`,
      `program_cue_event=${options.selectedEventId ?? eventId}`,
    ].join("; "),
  });
  if (options.contentType !== null)
    headers.set("content-type", options.contentType ?? "application/json");
  return new Request("http://localhost/files/task-evidence", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : body,
  });
}

function jsonRequest(body: unknown, options?: Parameters<typeof request>[1]) {
  return request(JSON.stringify(body), options);
}

async function invoke(
  routeRequest: Request,
  environment: CloudflareEnvironment = workerEnv,
) {
  return action({
    request: routeRequest,
    params: {},
    context: context(environment),
  } as never);
}

function environmentWithChannel(deliveries: unknown[]) {
  const stub = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      deliveries.push(JSON.parse(String(init?.body)));
      return Response.json({ accepted: true });
    },
  };
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return stub;
    },
  };
  return {
    ...workerEnv,
    DB: workerEnv.DB,
    FILES: workerEnv.FILES,
    EVENT_CHANNEL: namespace,
  } as unknown as CloudflareEnvironment;
}

beforeEach(async () => {
  await ensureDemoSpeakerData(workerEnv);
});

describe("task-evidence attachment resource", () => {
  it("is POST-only and advertises the supported method without caching", async () => {
    const getResponse = loader();
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(getResponse.headers.get("cache-control")).toBe("no-store");

    const putResponse = await invoke(
      jsonRequest(
        { taskId: "task", assetId: "asset", versionId: "version" },
        { method: "PUT" },
      ),
    );
    expect(putResponse.status).toBe(405);
    expect(putResponse.headers.get("allow")).toBe("POST");
  });

  it("requires a participant role and isolates mutations to the selected event", async () => {
    const denied = await invoke(
      jsonRequest(
        { taskId: "task", assetId: "asset", versionId: "version" },
        { role: "administrator" },
      ),
    );
    expect(denied.status).toBe(403);

    const submitter = await invoke(
      jsonRequest(
        { taskId: "", assetId: "asset", versionId: "version" },
        { role: "submitter" },
      ),
    );
    expect(submitter.status).toBe(422);

    const isolatedEventId = `evt-task-evidence-${crypto.randomUUID()}`;
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, last_updated_by_person_id
         )
         SELECT ?, organisation_id, 'Task evidence isolated event', ?, timezone,
                starts_at, ends_at, file_policy_json, last_updated_by_person_id
           FROM events WHERE id = ?`,
      ).bind(isolatedEventId, `task-evidence-${crypto.randomUUID()}`, eventId),
      workerEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `membership-${crypto.randomUUID()}`,
        speaker.organisationId,
        isolatedEventId,
        speaker.personId,
      ),
    ]);
    const crossEvent = await invoke(
      jsonRequest(
        { taskId, assetId: "asset-from-other-event", versionId: "version" },
        { selectedEventId: isolatedEventId },
      ),
    );
    expect(crossEvent.status).toBe(409);
    expect(await crossEvent.json()).toEqual({
      error: "File task not found or not owned by this speaker.",
    });
  });

  it("rejects malformed, invalid and oversized JSON bodies with bounded errors", async () => {
    const malformed = await invoke(request("{not-json"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "That request could not be read. Reload the page and try again.",
    });

    const invalid = await invoke(
      jsonRequest({ taskId: "", assetId: "asset", versionId: "version" }),
    );
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toHaveProperty("error");

    const oversized = await invoke(
      jsonRequest({
        taskId: "task",
        assetId: "a".repeat(17_000),
        versionId: "version",
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: "Attachment request exceeds 16 KB.",
    });
  });

  it("commits the exact completed upload before reporting realtime degradation and broadcasts safe retries", async () => {
    const upload = await completeTestDirectUpload(
      workerEnv,
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      new File(
        [new TextEncoder().encode("%PDF-1.7\nroute evidence")],
        "route-evidence.pdf",
        { type: "application/pdf" },
      ),
    );
    const input = {
      taskId,
      assetId: upload.assetId,
      versionId: upload.versionId,
    };

    const degraded = await invoke(jsonRequest(input));
    expect(degraded.status).toBe(207);
    expect(degraded.headers.get("cache-control")).toBe("private, no-store");
    const degradedBody = await degraded.json();
    expect(degradedBody).toMatchObject({
      ok: false,
      committed: true,
      message:
        "Your change was saved, but other open views could not be updated automatically. Refresh them before continuing.",
    });
    expect(JSON.stringify(degradedBody)).not.toContain("EVENT_CHANNEL");
    expect(
      await workerEnv.DB.prepare(
        `SELECT status, json_extract(evidence_json, '$.fileVersionId') AS versionId
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(taskId, eventId)
        .first(),
    ).toEqual({ status: "submitted", versionId: upload.versionId });
    expect(
      await workerEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_evidence
          WHERE task_id = ? AND event_id = ? AND status = 'submitted'`,
      )
        .bind(taskId, eventId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await workerEnv.DB.prepare(
        `SELECT entity_type AS entityType, entity_id AS entityId, change_type AS changeType
           FROM event_changes
          WHERE event_id = ? AND entity_id = ?
          ORDER BY sequence DESC LIMIT 1`,
      )
        .bind(eventId, taskId)
        .first(),
    ).toEqual({
      entityType: "task_instance",
      entityId: taskId,
      changeType: "progress",
    });

    const deliveries: unknown[] = [];
    const repeated = await invoke(
      jsonRequest(input),
      environmentWithChannel(deliveries),
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      ok: true,
      message: "This exact file version was already attached to the task.",
    });
    expect(deliveries).toEqual([
      expect.objectContaining({
        type: "event-change",
        eventId,
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      }),
    ]);
    expect(
      await workerEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_evidence WHERE task_id = ? AND event_id = ?",
      )
        .bind(taskId, eventId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("discards a completed upload when the task changes before attachment", async () => {
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `DELETE FROM task_evidence WHERE task_id = ? AND event_id = ?`,
      ).bind(taskId, eventId),
      workerEnv.DB.prepare(
        `UPDATE task_instances
            SET status = 'not_started', evidence_json = NULL,
                submitted_at = NULL, completed_at = NULL,
                revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(taskId, eventId),
    ]);
    const upload = await completeTestDirectUpload(
      workerEnv,
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      new File(
        [new TextEncoder().encode("%PDF-1.7\nstale task evidence")],
        "stale-task-evidence.pdf",
        { type: "application/pdf" },
      ),
    );
    const stored = await workerEnv.DB.prepare(
      `SELECT object_key AS objectKey FROM file_versions
        WHERE id = ? AND event_id = ? AND asset_id = ?`,
    )
      .bind(upload.versionId, eventId, upload.assetId)
      .first<{ objectKey: string }>();
    expect(stored).not.toBeNull();
    await workerEnv.DB.prepare(
      `UPDATE task_instances
          SET status = 'waived', revision = revision + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(taskId, eventId)
      .run();

    const conflicted = await invoke(
      jsonRequest({
        taskId,
        assetId: upload.assetId,
        versionId: upload.versionId,
      }),
    );
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({
      discarded: true,
      error: expect.stringContaining("unattached upload was discarded"),
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT asset.status, version.upload_status AS uploadStatus,
                version.deleted_at AS deletedAt
           FROM file_assets asset
           JOIN file_versions version
             ON version.asset_id = asset.id AND version.event_id = asset.event_id
          WHERE asset.id = ? AND asset.event_id = ? AND version.id = ?`,
      )
        .bind(upload.assetId, eventId, upload.versionId)
        .first(),
    ).toMatchObject({ status: "deleted", uploadStatus: "failed" });
    expect(await workerEnv.FILES.get(stored!.objectKey)).toBeNull();
  });

  it("discards only a raced replacement when canonical evidence becomes inconsistent", async () => {
    const files = new FileService(workerEnv);
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        "DELETE FROM task_evidence WHERE task_id = ? AND event_id = ?",
      ).bind(taskId, eventId),
      workerEnv.DB.prepare(
        `UPDATE task_instances
            SET status = 'not_started', evidence_json = NULL,
                submitted_at = NULL, completed_at = NULL,
                revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(taskId, eventId),
    ]);
    const first = await completeTestDirectUpload(
      workerEnv,
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      new File(["%PDF-1.7 first"], "slides-v1.pdf", {
        type: "application/pdf",
      }),
    );
    const firstAttachment = await invoke(
      jsonRequest({
        taskId,
        assetId: first.assetId,
        versionId: first.versionId,
      }),
    );
    expect([200, 207]).toContain(firstAttachment.status);
    await files.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        workerEnv,
        eventId,
        first.versionId,
      )),
      eventId,
      versionId: first.versionId,
      provider: "test-scanner",
      callbackId: `callback-${first.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });

    const replacement = await completeTestDirectUpload(
      workerEnv,
      speaker,
      {
        targetType: "task",
        targetId: taskId,
        assetKind: "task_evidence",
      },
      new File(["%PDF-1.7 second"], "slides-v2.pdf", {
        type: "application/pdf",
      }),
    );
    expect(replacement.assetId).toBe(first.assetId);
    const replacementRow = await workerEnv.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(replacement.versionId)
      .first<{ objectKey: string }>();
    await files.recordScanResult({
      ...(await acceptTestFileScanDispatch(
        workerEnv,
        eventId,
        replacement.versionId,
      )),
      eventId,
      versionId: replacement.versionId,
      provider: "test-scanner",
      callbackId: `callback-${replacement.versionId}`,
      status: "clean",
      result: { verdict: "clean" },
    });
    expect(
      await workerEnv.DB.prepare(
        "SELECT current_version_id AS currentVersionId FROM file_assets WHERE id = ?",
      )
        .bind(first.assetId)
        .first(),
    ).toEqual({ currentVersionId: replacement.versionId });

    await workerEnv.DB.prepare(
      `UPDATE task_evidence
          SET status = 'superseded'
        WHERE task_id = ? AND event_id = ?
          AND file_asset_id = ?
          AND json_extract(evidence_json, '$.fileVersionId') = ?`,
    )
      .bind(taskId, eventId, first.assetId, first.versionId)
      .run();
    const conflicted = await invoke(
      jsonRequest({
        taskId,
        assetId: replacement.assetId,
        versionId: replacement.versionId,
      }),
    );
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({ discarded: true });

    expect(
      await workerEnv.DB.prepare(
        `SELECT asset.status, asset.current_version_id AS currentVersionId,
                first.deleted_at AS firstDeletedAt,
                first.replaced_at AS firstReplacedAt,
                replacement.deleted_at AS replacementDeletedAt
           FROM file_assets asset
           JOIN file_versions first
             ON first.id = ? AND first.asset_id = asset.id
           JOIN file_versions replacement
             ON replacement.id = ? AND replacement.asset_id = asset.id
          WHERE asset.id = ? AND asset.event_id = ?`,
      )
        .bind(first.versionId, replacement.versionId, first.assetId, eventId)
        .first(),
    ).toMatchObject({
      status: "active",
      currentVersionId: first.versionId,
      firstDeletedAt: null,
      firstReplacedAt: null,
      replacementDeletedAt: expect.any(Number),
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_evidence
          WHERE task_id = ? AND file_asset_id = ?
            AND json_extract(evidence_json, '$.fileVersionId') = ?`,
      )
        .bind(taskId, first.assetId, first.versionId)
        .first(),
    ).toEqual({ count: 1 });
    expect(await workerEnv.FILES.get(replacementRow!.objectKey)).toBeNull();
  });
});

import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { apiRequestHash } from "~/platform/api/api.server";
import {
  ApiParticipantService,
  participantProfilePatchSchema,
} from "~/platform/api/api-participant-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_IDENTITIES,
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  action as participantResourceAction,
  loader as participantResourceLoader,
} from "~/routes/api-participant-resources";

const testEnv = {
  ...(env as unknown as CloudflareEnvironment),
  OPERATIONS_QUEUE: { send: async () => undefined },
} as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const organisationId = "org-future-events";

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

function participantHeaders(
  role: "speaker" | "submitter",
  extras: HeadersInit = {},
) {
  return new Headers({
    cookie: `program_cue_demo_identity=${role}`,
    ...Object.fromEntries(new Headers(extras)),
  });
}

function participantViewer(role: "speaker" | "submitter"): Viewer {
  return {
    ...DEMO_IDENTITIES[role],
    role,
    organisationId,
    eventId,
    demo: true,
  };
}

async function insertParticipantClaim(input: {
  id: string;
  personId: string;
  scope: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  await testEnv.DB.prepare(
    `INSERT INTO idempotency_records (
       id, organisation_id, event_id, actor_id, scope, idempotency_key,
       request_hash, status, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
               unixepoch() + 2592000, unixepoch())`,
  )
    .bind(
      input.id,
      organisationId,
      eventId,
      `person:${input.personId}`,
      input.scope,
      input.idempotencyKey,
      input.requestHash,
    )
    .run();
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
});

afterEach(() => vi.restoreAllMocks());

describe("participant API resources", () => {
  it("checks repository authority for participant domain reads but not private files", async () => {
    await ensureDemoSpeakerData(testEnv);
    await ensureDemoProgramme(testEnv);
    const viewer = participantViewer("speaker");
    const reads: string[] = [];
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        reads.push(scope.eventId);
        return null;
      },
    } as unknown as AirtableProviderBoundary;
    const service = new ApiParticipantService(testEnv, { airtable });

    await service.profile(viewer);
    await service.list(viewer, "sessions", { limit: 10 });
    expect(reads).toEqual([viewer.eventId, viewer.eventId]);

    await service.list(viewer, "files", { limit: 10 });
    expect(reads).toEqual([viewer.eventId, viewer.eventId]);
  });

  it("returns only the authenticated participant's bounded event records", async () => {
    await ensureDemoSpeakerData(testEnv);
    await ensureDemoProgramme(testEnv);
    const suffix = crypto.randomUUID();
    const ownedAssetId = `participant-owned-${suffix}`;
    const ownedVersionId = `participant-owned-version-${suffix}`;
    const foreignAssetId = `participant-foreign-${suffix}`;
    const foreignVersionId = `participant-foreign-version-${suffix}`;
    const linkTaskId = `participant-link-task-${suffix}`;
    const unavailableResourcePageId = `unavailable-resource-${suffix}`;
    const unavailableResourceTemplateId = `resource-ack:${unavailableResourcePageId}`;
    const unavailableResourceTaskId = `${unavailableResourceTemplateId}:${DEMO_IDENTITIES.speaker.personId}`;
    const destinationUrl = `https://example.test/participant-brief/${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'pending',
                   unixepoch(), unixepoch())`,
      ).bind(
        ownedAssetId,
        eventId,
        DEMO_IDENTITIES.speaker.personId,
        DEMO_IDENTITIES.speaker.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           created_by_person_id, released_at
         ) VALUES (?, ?, ?, 1, ?, 'speaker.jpg', 'image/jpeg', 'image/jpeg',
                   1024, 'uploaded', 'valid', 'clean', ?, unixepoch())`,
      ).bind(
        ownedVersionId,
        eventId,
        ownedAssetId,
        `private/test/${ownedVersionId}`,
        DEMO_IDENTITIES.speaker.personId,
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, status = 'active'
          WHERE id = ? AND event_id = ?`,
      ).bind(ownedVersionId, ownedAssetId, eventId),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'pending',
                   unixepoch(), unixepoch())`,
      ).bind(
        foreignAssetId,
        eventId,
        DEMO_IDENTITIES.submitter.personId,
        DEMO_IDENTITIES.submitter.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           created_by_person_id, released_at
         ) VALUES (?, ?, ?, 1, ?, 'foreign.jpg', 'image/jpeg', 'image/jpeg',
                   2048, 'uploaded', 'valid', 'clean', ?, unixepoch())`,
      ).bind(
        foreignVersionId,
        eventId,
        foreignAssetId,
        `private/test/${foreignVersionId}`,
        DEMO_IDENTITIES.submitter.personId,
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, status = 'active'
          WHERE id = ? AND event_id = ?`,
      ).bind(foreignVersionId, foreignAssetId, eventId),
      testEnv.DB.prepare(
        `INSERT INTO task_templates (
           id, event_id, name, target_type, task_type, impact, evidence_mode,
           due_anchor, auto_assign_on_acceptance, configuration_json, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Unavailable resource acknowledgement', 'speaker',
                   'acknowledgement', 'medium', 'checkbox', 'none', 0, ?,
                   'active', unixepoch(), unixepoch())`,
      ).bind(
        unavailableResourceTemplateId,
        eventId,
        JSON.stringify({ resourcePageId: unavailableResourcePageId }),
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, template_id, target_type, target_id, owner_person_id,
           title, task_type, impact, evidence_mode, configuration_json, status,
           readiness_state, readiness_percent, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'speaker', ?, ?, 'Read unavailable resource',
                   'acknowledgement', 'medium', 'checkbox', ?, 'not_started',
                   'on_track', 0, 1, unixepoch(), unixepoch())`,
      ).bind(
        unavailableResourceTaskId,
        eventId,
        unavailableResourceTemplateId,
        DEMO_IDENTITIES.speaker.personId,
        DEMO_IDENTITIES.speaker.personId,
        JSON.stringify({ resourcePageId: unavailableResourcePageId }),
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           description, task_type, impact, evidence_mode, configuration_json,
           status, readiness_state, readiness_percent, revision,
           created_at, updated_at
         ) VALUES (?, ?, 'speaker', ?, ?, 'Read the participant brief',
                   'Open and review the organiser-provided brief.', 'link_visit',
                   'medium', 'checkbox', ?, 'not_started', 'on_track', 0, 1,
                   unixepoch(), unixepoch())`,
      ).bind(
        linkTaskId,
        eventId,
        DEMO_IDENTITIES.speaker.personId,
        DEMO_IDENTITIES.speaker.personId,
        JSON.stringify({ destinationUrl }),
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instance_dependencies (
           task_id, depends_on_task_id, created_at
         ) VALUES (?, ?, unixepoch())`,
      ).bind(linkTaskId, unavailableResourceTaskId),
    ]);

    for (const resource of [
      "profile",
      "submissions",
      "sessions",
      "files",
      "tasks",
    ] as const) {
      const response = await participantResourceLoader({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/${resource}?${resource === "profile" ? "" : "limit=20"}`,
          { headers: participantHeaders("speaker") },
        ),
        params: { eventId, resource },
        context: routeContext(),
      } as never);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty(resource);
      expect(body).toHaveProperty("correlationId");
    }

    const filesResponse = await participantResourceLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/files?limit=20`,
        { headers: participantHeaders("speaker") },
      ),
      params: { eventId, resource: "files" },
      context: routeContext(),
    } as never);
    const files = (
      (await filesResponse.json()) as { files: Array<{ id: string }> }
    ).files;
    expect(files.map((file) => file.id)).toContain(ownedAssetId);
    expect(files.map((file) => file.id)).not.toContain(foreignAssetId);

    const tasksResponse = await participantResourceLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/tasks?limit=20`,
        { headers: participantHeaders("speaker") },
      ),
      params: { eventId, resource: "tasks" },
      context: routeContext(),
    } as never);
    const tasks = (
      (await tasksResponse.json()) as {
        tasks: Array<{
          id: string;
          status: string;
          readinessState: string;
          configuration: Record<string, unknown>;
          dependencies: Array<{ id: string; title: string }>;
        }>;
      }
    ).tasks;
    expect(tasks.find((task) => task.id === linkTaskId)?.configuration).toEqual(
      { destinationUrl },
    );
    expect(tasks.find((task) => task.id === linkTaskId)?.dependencies).toEqual([
      {
        id: `restricted-prerequisite:${linkTaskId}`,
        taskId: linkTaskId,
        title: "a prerequisite managed by the event team",
        status: "blocked",
      },
    ]);
    expect(tasks.find((task) => task.id === linkTaskId)).toMatchObject({
      status: "blocked",
      readinessState: "blocked",
    });
    expect(tasks.map((task) => task.id)).not.toContain(
      unavailableResourceTaskId,
    );

    const forbidden = await participantResourceLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/profile`,
        {
          headers: participantHeaders("speaker", {
            cookie: "program_cue_demo_identity=administrator",
          }),
        },
      ),
      params: { eventId, resource: "profile" },
      context: routeContext(),
    } as never);
    expect(forbidden.status).toBe(403);
  });

  it("returns the canonical session-review evidence required for completion", async () => {
    await ensureDemoSpeakerData(testEnv);
    await ensureDemoProgramme(testEnv);
    const viewer = participantViewer("speaker");
    const suffix = crypto.randomUUID();
    const templateId = `session-review-api-template-${suffix}`;
    const taskId = `session-review-api-task-${suffix}`;
    const relationship = await testEnv.DB.prepare(
      `SELECT relationship.session_id AS sessionId
         FROM session_speakers relationship
         JOIN sessions session
           ON session.id = relationship.session_id
          AND session.event_id = relationship.event_id
        WHERE relationship.event_id = ? AND relationship.person_id = ?
          AND relationship.participation_status IN ('pending','confirmed')
          AND session.status NOT IN ('cancelled','archived')
        LIMIT 1`,
    )
      .bind(eventId, viewer.personId)
      .first<{ sessionId: string }>();
    if (!relationship) throw new Error("Active demo session is missing.");
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO task_templates (
           id, event_id, name, description, target_type, task_type, impact,
           evidence_mode, due_anchor, due_offset_minutes, fixed_due_at,
           auto_assign_on_acceptance, configuration_json, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Review session details', 'Review shared details.',
                   'session', 'acknowledgement', 'high', 'checkbox', 'none',
                   NULL, NULL, 1, '{"preset":"session_details_review_v1"}',
                   'active', unixepoch(), unixepoch())`,
      ).bind(templateId, eventId),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, template_id, target_type, target_id, owner_person_id,
           title, description, task_type, impact, evidence_mode,
           configuration_json, status, readiness_state, readiness_percent,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', ?, NULL, 'Review session details',
                   'Review shared details.', 'acknowledgement', 'high',
                   'checkbox', '{"preset":"session_details_review_v1"}',
                   'not_started', 'on_track', 0, 1, unixepoch(), unixepoch())`,
      ).bind(taskId, eventId, templateId, relationship.sessionId),
    ]);

    const taskPage = await new ApiParticipantService(testEnv).list(
      viewer,
      "tasks",
      { limit: 100 },
    );
    if (!Array.isArray(taskPage.tasks))
      throw new Error("Participant task page is invalid.");
    const task = taskPage.tasks.find((candidate) => candidate.id === taskId) as
      | {
          sessionDetailsReview?: {
            fields: {
              title: string;
              description: string | null;
              format: string;
              durationMinutes: number;
              trackId: string | null;
              trackName: string | null;
            };
            sessionRevision: number;
            fingerprint: string;
          };
        }
      | undefined;
    expect(task?.sessionDetailsReview).toEqual({
      fields: {
        title: expect.any(String),
        description: expect.toSatisfy(
          (value: unknown) => value === null || typeof value === "string",
        ),
        format: expect.any(String),
        durationMinutes: expect.any(Number),
        trackId: expect.toSatisfy(
          (value: unknown) => value === null || typeof value === "string",
        ),
        trackName: expect.toSatisfy(
          (value: unknown) => value === null || typeof value === "string",
        ),
      },
      sessionRevision: expect.any(Number),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    await testEnv.DB.prepare(
      `UPDATE task_instances
          SET status = 'completed', readiness_state = 'on_track',
              readiness_percent = 100, evidence_json = '{"confirmed":true}',
              completed_at = unixepoch(), completed_by_person_id = ?,
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(viewer.personId, taskId, eventId)
      .run();
    await expect(
      new ApiParticipantService(testEnv).list(viewer, "tasks", { limit: 100 }),
    ).rejects.toThrow(/missing its canonical review evidence/i);
  });

  it("hides task-evidence file metadata after exact-session participation is declined", async () => {
    await ensureDemoSpeakerData(testEnv);
    const viewer = participantViewer("speaker");
    const suffix = crypto.randomUUID();
    const sessionId = `declined-file-session-${suffix}`;
    const taskId = `declined-file-task-${suffix}`;
    const assetId = `declined-file-asset-${suffix}`;
    const versionId = `declined-file-version-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility, revision, created_at, updated_at
         ) VALUES (?, ?, 'Declined file session', ?, 'presentation', 30,
                   'unscheduled', 'private', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, sessionId),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_revision, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'pending', 1, 'private')`,
      ).bind(sessionId, eventId, viewer.personId),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, evidence_mode, configuration_json, status,
           readiness_state, readiness_percent, revision, created_at, updated_at
         ) VALUES (?, ?, 'session', ?, ?, 'Upload session evidence',
                   'file_upload', 'high', 'admin_approval',
                   '{"fileScope":"session_deliverable"}', 'submitted',
                   'at_risk', 75, 1, unixepoch(), unixepoch())`,
      ).bind(taskId, eventId, sessionId, viewer.personId),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'pending',
                   unixepoch(), unixepoch())`,
      ).bind(assetId, eventId, viewer.personId, taskId),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           created_by_person_id, released_at
         ) VALUES (?, ?, ?, 1, ?, 'session-evidence.pdf', 'application/pdf',
                   'application/pdf', 2048, 'uploaded', 'valid', 'clean', ?,
                   unixepoch())`,
      ).bind(
        versionId,
        eventId,
        assetId,
        `private/test/${versionId}`,
        viewer.personId,
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, status = 'active'
          WHERE id = ? AND event_id = ?`,
      ).bind(versionId, assetId, eventId),
      testEnv.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, file_asset_id,
           evidence_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, '{}', 'submitted', unixepoch())`,
      ).bind(
        `declined-file-evidence-${suffix}`,
        eventId,
        taskId,
        viewer.personId,
        assetId,
      ),
    ]);
    const service = new ApiParticipantService(testEnv);
    const visibleFiles = await service.list(viewer, "files", {
      limit: 100,
    });
    if (!Array.isArray(visibleFiles.files))
      throw new Error("Participant file page is invalid.");
    expect(visibleFiles.files.map((file) => file.id)).toContain(assetId);

    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'declined', participation_revision = 2,
              participation_confirmed_at = NULL,
              participation_declined_at = unixepoch(),
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(eventId, sessionId, viewer.personId)
      .run();

    const declinedFiles = await service.list(viewer, "files", {
      limit: 100,
    });
    if (!Array.isArray(declinedFiles.files))
      throw new Error("Participant file page is invalid.");
    expect(declinedFiles.files.map((file) => file.id)).not.toContain(assetId);
  });

  it("updates an own profile once and rejects cross-origin browser mutation", async () => {
    await ensureDemoSpeakerData(testEnv);
    const submissionId = `profile-name-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, submitter_person_id, submitter_email,
           public_reference, title, status
         ) VALUES (?, ?, ?, ?, ?, 'Profile name synchronization', 'draft')`,
      ).bind(
        submissionId,
        eventId,
        DEMO_IDENTITIES.speaker.personId,
        DEMO_IDENTITIES.speaker.email,
        submissionId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO submission_speakers (
           id, event_id, submission_id, person_id, email, display_name,
           position, invitation_status, is_primary, claimed_at
         ) VALUES (?, ?, ?, ?, ?, 'Stale claimed name', 0, 'claimed', 1,
                   unixepoch())`,
      ).bind(
        `profile-speaker-${submissionId}`,
        eventId,
        submissionId,
        DEMO_IDENTITIES.speaker.personId,
        DEMO_IDENTITIES.speaker.email,
      ),
    ]);
    const profileRow = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(DEMO_IDENTITIES.speaker.personId)
      .first<{ revision: number }>();
    const body = {
      revision: profileRow!.revision,
      name: "Priya Shah API",
      biography:
        "Priya designs inclusive event technology and calm attendee experiences for global event teams.",
    };
    const invoke = (origin: string, idempotencyKey: string) =>
      participantResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/profile`,
          {
            method: "PATCH",
            headers: participantHeaders("speaker", {
              origin,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            }),
            body: JSON.stringify(body),
          },
        ),
        params: { eventId, resource: "profile" },
        context: routeContext(),
      } as never);

    const blocked = await invoke("https://attacker.test", "profile-block-123");
    expect(blocked.status).toBe(403);

    const first = await invoke("https://programcue.test", "profile-save-123");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      replayed: false,
      profile: { name: body.name, revision: body.revision + 1 },
    });
    const replay = await invoke("https://programcue.test", "profile-save-123");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND actor_person_id = ?
            AND action = 'participant.profile.updated'`,
      )
        .bind(eventId, DEMO_IDENTITIES.speaker.personId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT display_name AS displayName
           FROM submission_speakers WHERE submission_id = ?`,
      )
        .bind(submissionId)
        .first(),
    ).resolves.toEqual({ displayName: body.name });
  });

  it("projects participant profile updates through the selected repository authority", async () => {
    await ensureDemoSpeakerData(testEnv);
    const viewer = participantViewer("speaker");
    const endpoint = await new WebhookService(testEnv).create(
      {
        ...DEMO_IDENTITIES.administrator,
        role: "administrator",
        organisationId,
        eventId,
        demo: true,
      },
      {
        name: `Participant profile ${crypto.randomUUID()}`,
        url: "https://hooks.example.com/participant-profile",
        eventTypes: ["speaker.updated"],
      },
    );
    const current = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(viewer.personId)
      .first<{ revision: number }>();
    const biography = `Priya keeps participant profile edits synchronized with the selected event repository authority. ${"Detailed biography content. ".repeat(90)}`;
    expect(biography.length).toBeGreaterThan(2_000);
    const input = participantProfilePatchSchema.parse({
      revision: current!.revision,
      name: `Priya Authority ${crypto.randomUUID().slice(0, 8)}`,
      biography,
    });
    const commands: Array<{ operation: string; eventId: string }> = [];
    const airtable = {
      executeIdempotent: async <T>(
        scope: { eventId: string },
        command: { operation: string },
        execute: () => Promise<T>,
      ) => {
        commands.push({ operation: command.operation, eventId: scope.eventId });
        return execute();
      },
      assertReadable: async () => null,
    } as unknown as AirtableProviderBoundary;
    const operationId = crypto.randomUUID();

    await expect(
      new ApiParticipantService(testEnv, { airtable }).updateProfile(
        viewer,
        input,
        "profile-authority-test",
        operationId,
      ),
    ).resolves.toMatchObject({
      profile: {
        name: input.name,
        biography: input.biography,
        revision: input.revision + 1,
      },
    });
    expect(commands).toEqual([
      {
        operation: "participant.profile.update",
        eventId: viewer.eventId,
      },
    ]);
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE id = ? AND action = 'participant.profile.updated'`,
      )
        .bind(`participant-profile:${operationId}`)
        .first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM event_changes
          WHERE event_id = ? AND entity_type = 'person' AND entity_id = ?
            AND change_type = 'updated' AND correlation_id = ?`,
      )
        .bind(eventId, viewer.personId, operationId)
        .first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT event_type AS eventType FROM webhook_deliveries
          WHERE endpoint_id = ? AND entity_id = ?`,
      )
        .bind(endpoint.id, viewer.personId)
        .first(),
    ).resolves.toEqual({ eventType: "speaker.updated" });
  });

  it("converges concurrent profile retries without a second revision or audit", async () => {
    await ensureDemoSpeakerData(testEnv);
    const current = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(DEMO_IDENTITIES.speaker.personId)
      .first<{ revision: number }>();
    const suffix = crypto.randomUUID();
    const body = {
      revision: current!.revision,
      name: `Priya Concurrent ${suffix.slice(0, 8)}`,
      biography:
        "Priya coordinates reliable, inclusive event programmes across several concurrent delivery teams.",
    };
    const invoke = () =>
      participantResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/profile`,
          {
            method: "PATCH",
            headers: participantHeaders("speaker", {
              origin: "https://programcue.test",
              "content-type": "application/json",
              "idempotency-key": `profile-concurrent-${suffix}`,
            }),
            body: JSON.stringify(body),
          },
        ),
        params: { eventId, resource: "profile" },
        context: routeContext(),
      } as never);

    const responses = await Promise.all([invoke(), invoke()]);
    const statuses = responses.map((response) => response.status);
    expect(statuses).toContain(200);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(
      true,
    );
    const stored = await testEnv.DB.prepare(
      `SELECT profile_revision AS revision, last_operation_id AS operationId
         FROM people WHERE id = ?`,
    )
      .bind(DEMO_IDENTITIES.speaker.personId)
      .first<{ revision: number; operationId: string }>();
    expect(stored?.revision).toBe(body.revision + 1);
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE id = ? AND action = 'participant.profile.updated'`,
      )
        .bind(`participant-profile:${stored!.operationId}`)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("lets only the idempotency claimant execute while an identical request is in progress", async () => {
    const service = new ApiParticipantService(testEnv);
    const viewer = participantViewer("speaker");
    const suffix = crypto.randomUUID();
    let releaseOperation!: () => void;
    let signalStarted!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operationStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let operationCount = 0;
    const operation = async () => {
      operationCount += 1;
      signalStarted();
      await operationGate;
      return { ok: true };
    };
    const recover = async () => ({ response: null, progressed: false });
    const args = [
      viewer,
      "participant.test.concurrent",
      `participant-concurrent-${suffix}`,
      await apiRequestHash({ suffix }),
      operation,
      recover,
    ] as const;

    const owner = service.runCommand(...args);
    await operationStarted;
    await expect(service.runCommand(...args)).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_IN_PROGRESS",
    });
    expect(operationCount).toBe(1);
    releaseOperation();
    await expect(owner).resolves.toEqual({
      response: { ok: true },
      replayed: false,
    });
    await expect(service.runCommand(...args)).resolves.toEqual({
      response: { ok: true },
      replayed: true,
    });
    expect(operationCount).toBe(1);
  });

  it("bounds participant idempotency replay storage", async () => {
    const service = new ApiParticipantService(testEnv);
    const viewer = participantViewer("speaker");
    const idempotencyKey = `participant-large-result-${crypto.randomUUID()}`;
    const requestHash = await apiRequestHash({ idempotencyKey });

    await expect(
      service.runCommand(
        viewer,
        "participant.test.large-result",
        idempotencyKey,
        requestHash,
        async () => ({ content: "x".repeat(64 * 1_024) }),
        async () => ({ response: null, progressed: false }),
      ),
    ).rejects.toThrow("cannot exceed 64 KB");
    await expect(
      testEnv.DB.prepare(
        `SELECT id FROM idempotency_records
          WHERE event_id = ? AND actor_id = ? AND scope = ?
            AND idempotency_key = ?`,
      )
        .bind(
          viewer.eventId,
          `person:${viewer.personId}`,
          "participant.test.large-result",
          idempotencyKey,
        )
        .first(),
    ).resolves.toBeNull();
  });

  it("recovers a profile commit left between the domain batch and response persistence", async () => {
    await ensureDemoSpeakerData(testEnv);
    const viewer = participantViewer("speaker");
    const endpoint = await new WebhookService(testEnv).create(
      {
        ...DEMO_IDENTITIES.administrator,
        role: "administrator",
        organisationId,
        eventId,
        demo: true,
      },
      {
        name: `Profile recovery ${crypto.randomUUID()}`,
        url: "https://hooks.example.com/profile-recovery",
        eventTypes: ["speaker.updated"],
      },
    );
    const current = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(viewer.personId)
      .first<{ revision: number }>();
    const input = participantProfilePatchSchema.parse({
      revision: current!.revision,
      name: `Priya Recovered ${crypto.randomUUID().slice(0, 8)}`,
      biography:
        "Priya recovers durable participant changes without creating duplicate profile history or audit records.",
    });
    const operationId = crypto.randomUUID();
    const idempotencyKey = `profile-crash-${crypto.randomUUID()}`;
    await insertParticipantClaim({
      id: operationId,
      personId: viewer.personId,
      scope: "participant.profile.update",
      idempotencyKey,
      requestHash: await apiRequestHash(input),
    });
    await new ApiParticipantService(testEnv).updateProfile(
      viewer,
      input,
      "profile-crash-window",
      operationId,
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'queue_failed', dispatched_at = NULL
          WHERE event_id = ? AND type = 'webhook.deliver'
            AND id IN (
              SELECT item.operation_id FROM operation_items item
              JOIN webhook_deliveries delivery
                ON delivery.id = item.entity_id
               AND item.entity_type = 'webhook_delivery'
             WHERE delivery.event_type = 'speaker.updated'
               AND delivery.entity_id = ?
               AND delivery.idempotency_key =
                   'webhook:' || delivery.endpoint_id || ':' || ?
            )`,
      ).bind(
        viewer.eventId,
        viewer.personId,
        `speaker.updated:${viewer.personId}:${operationId}`,
      ),
      testEnv.DB.prepare(
        `UPDATE webhook_deliveries
            SET status = 'failed'
          WHERE event_type = 'speaker.updated' AND entity_id = ?
            AND idempotency_key =
                'webhook:' || endpoint_id || ':' || ?`,
      ).bind(
        viewer.personId,
        `speaker.updated:${viewer.personId}:${operationId}`,
      ),
      testEnv.DB.prepare(
        `UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ?`,
      ).bind(endpoint.id),
    ]);

    const recovered = await participantResourceAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/profile`,
        {
          method: "PATCH",
          headers: participantHeaders("speaker", {
            origin: "https://programcue.test",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          }),
          body: JSON.stringify(input),
        },
      ),
      params: { eventId, resource: "profile" },
      context: routeContext(),
    } as never);
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      replayed: true,
      profile: { name: input.name, revision: input.revision + 1 },
      webhookWarning:
        "The profile was saved, but one or more outbound webhooks need a queue retry.",
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, response_json IS NOT NULL AS hasResponse
           FROM idempotency_records WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "completed", hasResponse: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE id = ? AND action = 'participant.profile.updated'`,
      )
        .bind(`participant-profile:${operationId}`)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("fails fast when a committed profile mutation is missing its atomic change cursor", async () => {
    await ensureDemoSpeakerData(testEnv);
    const viewer = participantViewer("speaker");
    const current = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(viewer.personId)
      .first<{ revision: number }>();
    const input = participantProfilePatchSchema.parse({
      revision: current!.revision,
      name: `Integrity ${crypto.randomUUID().slice(0, 8)}`,
      biography:
        "This profile mutation deliberately loses its required event cursor for an integrity test.",
    });
    const operationId = crypto.randomUUID();
    await new ApiParticipantService(testEnv).updateProfile(
      viewer,
      input,
      operationId,
      operationId,
    );
    await testEnv.DB.prepare(
      `DELETE FROM event_changes
        WHERE event_id = ? AND entity_type = 'person' AND entity_id = ?
          AND correlation_id = ?`,
    )
      .bind(viewer.eventId, viewer.personId, operationId)
      .run();

    await expect(
      new ApiParticipantService(testEnv).recoverProfileUpdate(
        viewer,
        input,
        operationId,
      ),
    ).rejects.toThrow(/missing its required event change cursor/i);
  });
});

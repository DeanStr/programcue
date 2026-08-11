import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Applicant } from "~/modules/submissions/submission-repository.server";
import {
  ApiParticipantService,
  participantProfilePatchSchema,
} from "~/platform/api/api-participant-service.server";
import { apiRequestHash } from "~/platform/api/api.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_IDENTITIES,
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import { action as directSessionAction } from "~/routes/api-direct-sessions";
import { action as evaluationAdvanceAction } from "~/routes/api-evaluation-advance";
import {
  action as participantResourceAction,
  loader as participantResourceLoader,
} from "~/routes/api-participant-resources";
import { action as participantSubmissionAction } from "~/routes/api-participant-submission-command";

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
    cookie: `program_cue_demo_role=${role}`,
    ...Object.fromEntries(new Headers(extras)),
  });
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createApiKey(scope: "sessions:write" | "evaluation:write") {
  const suffix = crypto.randomUUID();
  const keyId = `participant-api-key-${suffix}`;
  const token = `pc_api_participant_${suffix}`;
  await testEnv.DB.prepare(
    `INSERT INTO api_keys (
       id, organisation_id, event_id, name, key_prefix, key_hash,
       scopes_json, created_at
     ) VALUES (?, ?, ?, ?, 'pc_api_', ?, ?, unixepoch())`,
  )
    .bind(
      keyId,
      organisationId,
      eventId,
      `Participant API ${suffix}`,
      await hash(token),
      JSON.stringify([scope]),
    )
    .run();
  return { keyId, token };
}

function submitterApplicant(): Extract<Applicant, { verified: true }> {
  return {
    personId: DEMO_IDENTITIES.submitter.personId,
    email: DEMO_IDENTITIES.submitter.email,
    name: DEMO_IDENTITIES.submitter.name,
    verified: true,
    anonymousDraftId: null,
    biography: "",
    profileRevision: 1,
  };
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

function participantSubmissionRequest(input: {
  submissionId: string;
  command: "submit" | "withdraw";
  idempotencyKey: string;
  body: unknown;
}) {
  return participantSubmissionAction({
    request: new Request(
      `https://programcue.test/api/v1/events/${eventId}/participant/submissions/${input.submissionId}/${input.command}`,
      {
        method: "POST",
        headers: participantHeaders("submitter", {
          origin: "https://programcue.test",
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        }),
        body: JSON.stringify(input.body),
      },
    ),
    params: {
      eventId,
      submissionId: input.submissionId,
      command: input.command,
    },
    context: routeContext(),
  } as never);
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

    const forbidden = await participantResourceLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/profile`,
        {
          headers: participantHeaders("speaker", {
            cookie: "program_cue_demo_role=administrator",
          }),
        },
      ),
      params: { eventId, resource: "profile" },
      context: routeContext(),
    } as never);
    expect(forbidden.status).toBe(403);
  });

  it("updates an own profile once and rejects cross-origin browser mutation", async () => {
    await ensureDemoSpeakerData(testEnv);
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
  });

  it("projects participant profile updates through the selected repository authority", async () => {
    await ensureDemoSpeakerData(testEnv);
    const viewer = participantViewer("speaker");
    const current = await testEnv.DB.prepare(
      "SELECT profile_revision AS revision FROM people WHERE id = ?",
    )
      .bind(viewer.personId)
      .first<{ revision: number }>();
    const input = participantProfilePatchSchema.parse({
      revision: current!.revision,
      name: `Priya Authority ${crypto.randomUUID().slice(0, 8)}`,
      biography:
        "Priya keeps participant profile edits synchronized with the selected event repository authority.",
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
      profile: { name: input.name, revision: input.revision + 1 },
    });
    expect(commands).toEqual([
      {
        operation: "participant.profile.update",
        eventId: viewer.eventId,
      },
    ]);
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
});

describe("participant submission commands", () => {
  it("does not terminalize queued notifications when the Queue binding is missing", async () => {
    const submissionId = `missing-queue-submission-${crypto.randomUUID()}`;
    const operationId = `missing-queue-operation-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'submission.notification', ?, ?, 'queued', '{}',
                 1, 0, 0, 0, unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        organisationId,
        eventId,
        DEMO_IDENTITIES.submitter.personId,
        `submission-confirmation:${submissionId}`,
        crypto.randomUUID(),
      )
      .run();
    const unavailableEnvironment = {
      ...testEnv,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;

    await expect(
      new ApiParticipantService(
        unavailableEnvironment,
      ).resumeSubmissionNotifications(
        participantViewer("submitter"),
        submissionId,
      ),
    ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
    await expect(
      testEnv.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "queued", lastError: null });
  });

  it("submits and withdraws only an owned application with exact replay", async () => {
    await ensureDemoSubmissionForm(testEnv);
    const applicant: Applicant = {
      personId: DEMO_IDENTITIES.submitter.personId,
      email: DEMO_IDENTITIES.submitter.email,
      name: DEMO_IDENTITIES.submitter.name,
      verified: true,
      anonymousDraftId: null,
      biography: "",
      profileRevision: 1,
    };
    const submissionId = await new SubmissionService(testEnv).createDraft(
      "form",
      applicant,
    );
    const draft = await testEnv.DB.prepare(
      `SELECT revision FROM submissions WHERE id = ? AND event_id = ?`,
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    const submitBody = {
      confirmed: true,
      revision: draft!.revision,
      answers: {
        title: "A participant API session",
        description:
          "A practical session explaining how participant APIs improve reliable event operations.",
        category: "AI & Innovation",
        format: "Presentation",
        video: "https://example.com/pitch",
      },
      speakers: [
        {
          name: applicant.name,
          email: applicant.email,
          biography:
            "A verified participant presenting practical event operations.",
        },
      ],
      uploads: {},
    };
    const invoke = (
      command: "submit" | "withdraw",
      idempotencyKey: string,
      body: unknown,
    ) =>
      participantSubmissionAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/submissions/${submissionId}/${command}`,
          {
            method: "POST",
            headers: participantHeaders("submitter", {
              origin: "https://programcue.test",
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            }),
            body: JSON.stringify(body),
          },
        ),
        params: { eventId, submissionId, command },
        context: routeContext(),
      } as never);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(
      EventRealtimeService.prototype,
      "notifyCommittedChange",
    ).mockRejectedValue(
      new Error("realtime provider credential must-not-cross-api-boundary"),
    );

    const submitted = await invoke(
      "submit",
      "participant-submit-123",
      submitBody,
    );
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.json();
    expect(submittedBody).toMatchObject({
      replayed: false,
      submission: { id: submissionId, status: "submitted" },
      warnings: expect.arrayContaining([
        "The submission committed, but live invalidation failed.",
      ]),
    });
    expect(JSON.stringify(submittedBody)).not.toContain(
      "must-not-cross-api-boundary",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "must-not-cross-api-boundary",
    );
    const submitReplay = await invoke(
      "submit",
      "participant-submit-123",
      submitBody,
    );
    await expect(submitReplay.json()).resolves.toMatchObject({
      replayed: true,
    });

    const current = await testEnv.DB.prepare(
      `SELECT revision, status FROM submissions WHERE id = ? AND event_id = ?`,
    )
      .bind(submissionId, eventId)
      .first<{ revision: number; status: string }>();
    expect(current?.status).toBe("submitted");
    const withdrawBody = { confirmed: true, revision: current!.revision };
    const withdrawn = await invoke(
      "withdraw",
      "participant-withdraw-123",
      withdrawBody,
    );
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toMatchObject({
      replayed: false,
      submission: { id: submissionId, status: "withdrawn" },
    });
    const withdrawReplay = await invoke(
      "withdraw",
      "participant-withdraw-123",
      withdrawBody,
    );
    await expect(withdrawReplay.json()).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND entity_id = ?
            AND action IN ('submission.submitted','submission.withdrawn')`,
      )
        .bind(eventId, submissionId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 });
  });

  it("recovers a submitted domain commit and persists the complete downstream result once", async () => {
    await ensureDemoSubmissionForm(testEnv);
    const applicant = submitterApplicant();
    const submissionId = await new SubmissionService(testEnv).createDraft(
      "form",
      applicant,
    );
    const draft = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    const body = {
      confirmed: true as const,
      revision: draft!.revision,
      answers: {
        title: "Recovering a participant API submission",
        description:
          "A practical explanation of durable application commands and idempotent downstream event orchestration.",
        category: "AI & Innovation",
        format: "Presentation",
        video: "https://example.com/recovery",
      },
      speakers: [
        {
          name: applicant.name,
          email: applicant.email,
          biography:
            "A verified submitter demonstrating reliable event workflow recovery.",
        },
      ],
      uploads: {},
    };
    const operationId = crypto.randomUUID();
    const idempotencyKey = `submit-crash-${crypto.randomUUID()}`;
    await insertParticipantClaim({
      id: operationId,
      personId: applicant.personId,
      scope: "participant.submission.submit",
      idempotencyKey,
      requestHash: await apiRequestHash({ submissionId, ...body }),
    });
    const endpointId = `participant-submit-hook-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'Participant submit events',
                 'https://hooks.example.com/participant-submit', 'test-only',
                 '["submission.submitted"]', 'active', ?)`,
    )
      .bind(endpointId, organisationId, eventId, applicant.personId)
      .run();

    await new SubmissionService(testEnv).submitDraftForParticipantApi(
      "form",
      applicant,
      { ...body, submissionId },
      operationId,
    );

    const recovered = await participantSubmissionRequest({
      submissionId,
      command: "submit",
      idempotencyKey,
      body,
    });
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as Record<
      string,
      unknown
    > & {
      notifications: unknown[];
      webhookDeliveries: unknown[];
    };
    expect(recoveredBody).toMatchObject({
      replayed: true,
      submission: { id: submissionId, status: "submitted" },
    });
    expect(recoveredBody.notifications).toHaveLength(1);
    expect(recoveredBody.webhookDeliveries).toHaveLength(1);

    const replay = await participantSubmissionRequest({
      submissionId,
      command: "submit",
      idempotencyKey,
      body,
    });
    const replayBody = (await replay.json()) as Record<string, unknown>;
    const {
      replayed: _recoveredReplay,
      correlationId: _recoveredCorrelation,
      ...recoveredResult
    } = recoveredBody;
    const {
      replayed: _replayReplay,
      correlationId: _replayCorrelation,
      ...replayedResult
    } = replayBody;
    expect(replayedResult).toEqual(recoveredResult);

    const counts = await testEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM submission_revisions
           WHERE submission_id = ? AND save_kind = 'submitted') AS revisionCount,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND entity_id = ?
             AND action = 'submission.submitted') AS auditCount,
         (SELECT COUNT(*) FROM event_changes
           WHERE event_id = ? AND entity_id = ?
             AND correlation_id = ?) AS changeCount,
         (SELECT COUNT(*) FROM webhook_deliveries
           WHERE endpoint_id = ? AND entity_id = ?) AS webhookCount`,
    )
      .bind(
        submissionId,
        eventId,
        submissionId,
        eventId,
        submissionId,
        operationId,
        endpointId,
        submissionId,
      )
      .first<{
        revisionCount: number;
        auditCount: number;
        changeCount: number;
        webhookCount: number;
      }>();
    expect(counts).toEqual({
      revisionCount: 1,
      auditCount: 1,
      changeCount: 1,
      webhookCount: 1,
    });
  });

  it("keeps a committed submission retryable until its webhook intent is recorded", async () => {
    await ensureDemoSubmissionForm(testEnv);
    const applicant = submitterApplicant();
    const submissionId = await new SubmissionService(testEnv).createDraft(
      "form",
      applicant,
    );
    const draft = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    const body = {
      confirmed: true as const,
      revision: draft!.revision,
      answers: {
        title: "Recovering an unrecorded participant webhook",
        description:
          "A complete application proving exact retries resume outbound webhook intent after a committed participant submission.",
        category: "AI & Innovation",
        format: "Presentation",
        video: "https://example.com/webhook-recovery",
      },
      speakers: [
        {
          name: applicant.name,
          email: applicant.email,
          biography:
            "A verified submitter testing durable participant webhook recovery.",
        },
      ],
      uploads: {},
    };
    const idempotencyKey = `submit-webhook-recovery-${crypto.randomUUID()}`;
    const endpointId = `participant-recovery-hook-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'Participant recovery events',
                 'https://hooks.example.com/participant-recovery', 'test-only',
                 '["submission.submitted"]', 'active', ?)`,
    )
      .bind(endpointId, organisationId, eventId, applicant.personId)
      .run();

    const webhook = vi
      .spyOn(WebhookService.prototype, "queueEvent")
      .mockRejectedValue(new Error("Temporary webhook persistence failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await participantSubmissionRequest({
      submissionId,
      command: "submit",
      idempotencyKey,
      body,
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "Temporary webhook persistence failure",
    );
    webhook.mockRestore();

    await expect(
      testEnv.DB.prepare(
        `SELECT submission.status, command.status AS commandStatus
           FROM submissions submission
           JOIN idempotency_records command
             ON command.event_id = submission.event_id
            AND command.actor_id = ?
            AND command.scope = 'participant.submission.submit'
            AND command.idempotency_key = ?
          WHERE submission.id = ? AND submission.event_id = ?`,
      )
        .bind(
          `person:${applicant.personId}`,
          idempotencyKey,
          submissionId,
          eventId,
        )
        .first(),
    ).resolves.toEqual({ status: "submitted", commandStatus: "processing" });

    const recovered = await participantSubmissionRequest({
      submissionId,
      command: "submit",
      idempotencyKey,
      body,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      replayed: true,
      submission: { id: submissionId, status: "submitted" },
      webhookDeliveries: expect.arrayContaining([
        expect.objectContaining({ endpointId }),
      ]),
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT command.status,
                (SELECT COUNT(*) FROM webhook_deliveries delivery
                  WHERE delivery.endpoint_id = ?
                    AND delivery.entity_id = ?) AS webhookCount
           FROM idempotency_records command
          WHERE command.event_id = ? AND command.actor_id = ?
            AND command.scope = 'participant.submission.submit'
            AND command.idempotency_key = ?`,
      )
        .bind(
          endpointId,
          submissionId,
          eventId,
          `person:${applicant.personId}`,
          idempotencyKey,
        )
        .first(),
    ).resolves.toEqual({ status: "completed", webhookCount: 1 });
  });

  it("recovers a withdrawal commit without replaying submission notifications", async () => {
    await ensureDemoSubmissionForm(testEnv);
    const applicant = submitterApplicant();
    const service = new SubmissionService(testEnv);
    const submissionId = await service.createDraft("form", applicant);
    const draft = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    await service.submitDraft("form", applicant, {
      submissionId,
      revision: draft!.revision,
      answers: {
        title: "A withdrawal recovery example",
        description:
          "A complete application used to verify durable withdrawal recovery behavior.",
        category: "AI & Innovation",
        format: "Presentation",
        video: "https://example.com/withdrawal",
      },
      speakers: [
        {
          name: applicant.name,
          email: applicant.email,
          biography:
            "A verified submitter testing reliable withdrawal recovery.",
        },
      ],
      uploads: {},
    });
    const submitted = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    const body = { confirmed: true as const, revision: submitted!.revision };
    const operationId = crypto.randomUUID();
    const idempotencyKey = `withdraw-crash-${crypto.randomUUID()}`;
    await insertParticipantClaim({
      id: operationId,
      personId: applicant.personId,
      scope: "participant.submission.withdraw",
      idempotencyKey,
      requestHash: await apiRequestHash({ submissionId, ...body }),
    });
    const endpointId = `participant-withdraw-hook-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'Participant withdraw events',
                 'https://hooks.example.com/participant-withdraw', 'test-only',
                 '["submission.withdrawn"]', 'active', ?)`,
    )
      .bind(endpointId, organisationId, eventId, applicant.personId)
      .run();
    await service.withdrawSubmissionForParticipantApi(
      "form",
      applicant,
      { submissionId, revision: body.revision },
      operationId,
    );

    const recovered = await participantSubmissionRequest({
      submissionId,
      command: "withdraw",
      idempotencyKey,
      body,
    });
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as {
      replayed: boolean;
      notifications: unknown[];
      webhookDeliveries: unknown[];
      submission: { status: string; revision: number };
    };
    expect(recoveredBody).toMatchObject({
      replayed: true,
      submission: {
        status: "withdrawn",
        revision: body.revision + 1,
      },
      notifications: [],
    });
    expect(recoveredBody.webhookDeliveries).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM submission_revisions
             WHERE submission_id = ? AND save_kind = 'withdrawn') AS revisionCount,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND entity_id = ?
               AND action = 'submission.withdrawn') AS auditCount,
           (SELECT COUNT(*) FROM event_changes
             WHERE event_id = ? AND entity_id = ?
               AND correlation_id = ?) AS changeCount,
           (SELECT COUNT(*) FROM webhook_deliveries
             WHERE endpoint_id = ? AND entity_id = ?) AS webhookCount`,
      )
        .bind(
          submissionId,
          eventId,
          submissionId,
          eventId,
          submissionId,
          operationId,
          endpointId,
          submissionId,
        )
        .first(),
    ).resolves.toEqual({
      revisionCount: 1,
      auditCount: 1,
      changeCount: 1,
      webhookCount: 1,
    });
  });
});

describe("administration command and evaluation webhook parity", () => {
  it("creates one direct session for an API key and audits the non-human actor", async () => {
    const apiKey = await createApiKey("sessions:write");
    const body = {
      title: "API-created direct session",
      description:
        "A bounded direct-session command created by an integration.",
      format: "presentation",
      speakers: [
        {
          name: "API Speaker",
          email: `api-speaker-${crypto.randomUUID()}@example.com`,
          biography: "Speaker created through the direct-session API command.",
        },
      ],
    };
    const invoke = () =>
      directSessionAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/sessions/direct`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey.token}`,
              "content-type": "application/json",
              "idempotency-key": "direct-session-api-123",
            },
            body: JSON.stringify(body),
          },
        ),
        params: { eventId },
        context: routeContext(),
      } as never);

    const first = await invoke();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      session: { id: string };
      replayed: boolean;
      changeCursor: number | null;
    };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.changeCursor).toEqual(expect.any(Number));
    const replay = await invoke();
    const replayBody = (await replay.json()) as {
      session: { id: string };
      replayed: boolean;
      changeCursor: number | null;
    };
    expect(replayBody).toMatchObject({
      session: { id: firstBody.session.id },
      replayed: true,
      changeCursor: firstBody.changeCursor,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT actor_person_id AS actorPersonId, actor_id AS actorId
           FROM audit_events
          WHERE event_id = ? AND entity_id = ?
            AND action = 'session.direct.created'`,
      )
        .bind(eventId, firstBody.session.id)
        .first(),
    ).resolves.toEqual({
      actorPersonId: null,
      actorId: `api_key:${apiKey.keyId}`,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE event_id = ? AND title = ?`,
      )
        .bind(eventId, body.title)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM event_changes
          WHERE event_id = ? AND entity_type = 'session' AND entity_id = ?
            AND correlation_id = ?`,
      )
        .bind(
          eventId,
          firstBody.session.id,
          `api-direct-session:${firstBody.session.id}`,
        )
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("queues round.advanced with the API-key actor and stable event key", async () => {
    const apiKey = await createApiKey("evaluation:write");
    vi.spyOn(EvaluationService.prototype, "advanceRound").mockResolvedValue({
      advancedSubmissionCount: 2,
      assignmentCount: 4,
    });
    const queue = vi
      .spyOn(WebhookService.prototype, "queueEvent")
      .mockResolvedValue([]);
    const input = {
      fromRoundId: "round-one",
      fromRoundRevision: 3,
      toRoundId: "round-two",
      toRoundRevision: 4,
      submissionIds: ["submission-one", "submission-two"],
      evaluatorPersonIds: [DEMO_IDENTITIES.evaluator.personId],
      teamId: null,
      confirmed: true,
    };
    const response = await evaluationAdvanceAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/evaluation/rounds/advance`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey.token}`,
            "content-type": "application/json",
            "idempotency-key": "round-advance-api-123",
            "x-correlation-id": "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
          },
          body: JSON.stringify(input),
        },
      ),
      params: { eventId },
      context: routeContext(),
    } as never);
    expect(response.status).toBe(200);
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId,
        eventId,
        personId: null,
        actorId: `api_key:${apiKey.keyId}`,
      }),
      expect.objectContaining({
        eventType: "round.advanced",
        entityId: "round-two",
        idempotencyKey: "round.advanced:round-two:5",
        correlationId: "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
        data: expect.objectContaining({
          advancedSubmissionCount: 2,
          assignmentCount: 4,
        }),
      }),
    );
  });
});

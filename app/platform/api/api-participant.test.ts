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

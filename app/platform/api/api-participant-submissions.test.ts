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
    cookie: `program_cue_demo_identity=${role}`,
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
        category: ["AI & Innovation"],
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
        category: ["AI & Innovation"],
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
        category: ["AI & Innovation"],
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
        category: ["AI & Innovation"],
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

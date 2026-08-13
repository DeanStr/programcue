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
import { currentEventCookie } from "~/platform/auth/current-event.server";
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
import { action as participantApplicationsAction } from "~/routes/participant-applications";

const testEnv = {
  ...(env as unknown as CloudflareEnvironment),
  OPERATIONS_QUEUE: { send: async () => undefined },
  EVENT_CHANNEL: {
    idFromName(name: string) {
      return name;
    },
    get() {
      return { fetch: async () => Response.json({ accepted: true }) };
    },
  },
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
  command: "submit" | "withdraw" | "invite-co-speaker";
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

function participantApplicationsRequest(
  body: URLSearchParams,
  origin: string | null = "https://programcue.test",
  authenticated = true,
) {
  const eventCookie = currentEventCookie(eventId, testEnv).split(";", 1)[0];
  const headers = new Headers();
  if (authenticated) {
    headers.set(
      "cookie",
      `program_cue_demo_identity=submitter; ${eventCookie}`,
    );
  }
  if (origin !== null) headers.set("origin", origin);
  return participantApplicationsAction({
    request: new Request("https://programcue.test/participant/applications", {
      method: "POST",
      headers,
      body,
    }),
    params: {},
    context: routeContext(),
  } as never);
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
});

afterEach(() => vi.restoreAllMocks());

describe("participant submission commands", () => {
  it("rejects cross-origin participant application mutations before authentication or side effects", async () => {
    const applicationId = `cross-origin-application-${crypto.randomUUID()}`;
    const email = `cross-origin-${crypto.randomUUID()}@example.com`;
    const idempotencyKey = `cross-origin-${crypto.randomUUID()}`;
    for (const origin of [null, "null", "https://attacker.example"]) {
      const response = await participantApplicationsRequest(
        new URLSearchParams({
          _intent: "invite_co_speaker",
          applicationId,
          revision: "1",
          idempotencyKey,
          confirmed: "true",
          name: "Cross-origin speaker",
          email,
          roleLabel: "Co-speaker",
        }),
        origin,
        false,
      );
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(403);
    }

    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM submission_speakers WHERE email = ? COLLATE NOCASE)
             AS speakerCount,
           (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?)
             AS idempotencyCount`,
      )
        .bind(email, idempotencyKey)
        .first(),
    ).resolves.toEqual({ speakerCount: 0, idempotencyCount: 0 });
  });

  it("adds one unclaimed co-speaker to an accepted proposal with exact API replay", async () => {
    await ensureDemoSubmissionForm(testEnv);
    const applicant = submitterApplicant();
    const submissions = new SubmissionService(testEnv);
    const submissionId = await submissions.createDraft("form", applicant);
    const draft = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    await submissions.submitDraft("form", applicant, {
      submissionId,
      revision: draft!.revision,
      answers: {
        title: "An accepted proposal with a later co-author",
        description:
          "A practical proposal used to prove the accepted participant list remains safely editable before publication.",
        category: ["AI & Innovation"],
        format: "Presentation",
        video: "https://example.com/accepted-co-author",
      },
      speakers: [
        {
          name: applicant.name,
          email: applicant.email,
          biography: "A verified primary speaker.",
        },
      ],
    });
    const sessionId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE submissions
            SET status = 'accepted', revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(submissionId, eventId),
      testEnv.DB.prepare(
        `INSERT INTO submission_decisions (
           id, event_id, submission_id, revision_number, status, decision,
           decided_by_person_id, notification_feedback_json,
           effect_preview_json, idempotency_key, published_at
         ) VALUES (?, ?, ?, 1, 'published', 'accepted', ?, '[]', '{}', ?,
                   unixepoch())`,
      ).bind(
        decisionId,
        eventId,
        submissionId,
        DEMO_IDENTITIES.administrator.personId,
        `api-accepted:${decisionId}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, source_submission_id, title, slug, description,
           format, duration_minutes, status, visibility, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'Accepted API proposal', ?, '', 'presentation', 60,
                   'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, submissionId, `api-accepted-${sessionId}`),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'Primary speaker', 'confirmed', unixepoch(),
                   'public')`,
      ).bind(sessionId, eventId, DEMO_IDENTITIES.submitter.personId),
      testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Participant invitations', 'Program Cue',
                   'submissions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      ).bind(`participant-invite-sender-${crypto.randomUUID()}`, eventId),
      testEnv.DB.prepare(
        `UPDATE sender_profiles SET status = 'verified', updated_at = unixepoch()
          WHERE event_id = ? AND provider = 'resend'`,
      ).bind(eventId),
    ]);
    const accepted = await testEnv.DB.prepare(
      "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
    )
      .bind(submissionId, eventId)
      .first<{ revision: number }>();
    const body = {
      confirmed: true,
      revision: accepted!.revision,
      name: "API Co-author",
      email: `api-co-author-${crypto.randomUUID()}@example.com`,
      roleLabel: "Co-author",
    };
    const endpointId = `participant-co-speaker-hook-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'Participant co-speaker updates',
                 'https://hooks.example.com/participant-co-speaker', 'test-only',
                 '["submission.updated"]', 'active', ?)`,
    )
      .bind(
        endpointId,
        organisationId,
        eventId,
        DEMO_IDENTITIES.submitter.personId,
      )
      .run();
    const idempotencyKey = `invite-co-author-${crypto.randomUUID()}`;
    const unconfirmed = await participantSubmissionRequest({
      submissionId,
      command: "invite-co-speaker",
      idempotencyKey: `unconfirmed-co-author-${crypto.randomUUID()}`,
      body: { ...body, confirmed: false },
    });
    expect(unconfirmed.status).toBe(422);
    const invited = await participantSubmissionRequest({
      submissionId,
      command: "invite-co-speaker",
      idempotencyKey,
      body,
    });
    expect(invited.status).toBe(200);
    const invitedBody = (await invited.json()) as {
      replayed: boolean;
      speaker: { id: string; roleLabel: string; invitationStatus: string };
      submission: { revision: number };
      invitation: { operationId: string; status: string };
      webhookDeliveries: Array<{ endpointId: string }>;
      changeCursor: number;
      warnings: string[];
    };
    expect(invitedBody).toMatchObject({
      replayed: false,
      speaker: {
        roleLabel: "Co-author",
        invitationStatus: "sent",
      },
      submission: { revision: accepted!.revision + 1 },
      webhookDeliveries: [{ endpointId }],
      warnings: [],
    });
    expect(invitedBody.changeCursor).toBeGreaterThan(0);
    await expect(
      submissions.recoverAcceptedCoSpeakerInvitation(
        participantViewer("submitter"),
        submissionId,
        invitedBody.invitation.operationId,
      ),
    ).resolves.toMatchObject({
      submission: { revision: accepted!.revision + 1 },
      speaker: {
        id: invitedBody.speaker.id,
        invitationStatus: "sent",
      },
      invitation: { status: "queued" },
    });

    const realtimeFailure = vi
      .spyOn(testEnv.EVENT_CHANNEL!, "get")
      .mockReturnValue({
        fetch: async () => {
          throw new Error("realtime unavailable");
        },
      } as never);
    const replay = await participantSubmissionRequest({
      submissionId,
      command: "invite-co-speaker",
      idempotencyKey,
      body,
    });
    expect(replay.status).toBe(207);
    await expect(replay.json()).resolves.toMatchObject({
      replayed: true,
      speaker: { id: invitedBody.speaker.id },
      webhookDeliveries: [{ endpointId }],
      changeCursor: invitedBody.changeCursor,
      warnings: ["The submission committed, but live invalidation failed."],
    });
    realtimeFailure.mockRestore();
    const recoveryInput = {
      submissionId,
      revision: invitedBody.submission.revision,
      name: "Recovered API co-presenter",
      email: `recovered-api-co-presenter-${crypto.randomUUID()}@example.com`,
      roleLabel: "Co-presenter" as const,
      confirmed: true as const,
    };
    const recoveryOperationId = crypto.randomUUID();
    const recoveryIdempotencyKey = `recovered-co-presenter-${crypto.randomUUID()}`;
    await insertParticipantClaim({
      id: recoveryOperationId,
      personId: DEMO_IDENTITIES.submitter.personId,
      scope: "participant.submission.invite_co_speaker",
      idempotencyKey: recoveryIdempotencyKey,
      requestHash: await apiRequestHash(recoveryInput),
    });
    const recoveredDomain = await submissions.inviteAcceptedCoSpeaker(
      participantViewer("submitter"),
      recoveryInput,
      recoveryOperationId,
    );
    const recovered = await participantSubmissionRequest({
      submissionId,
      command: "invite-co-speaker",
      idempotencyKey: recoveryIdempotencyKey,
      body: {
        confirmed: recoveryInput.confirmed,
        revision: recoveryInput.revision,
        name: recoveryInput.name,
        email: recoveryInput.email,
        roleLabel: recoveryInput.roleLabel,
      },
    });
    expect(
      recovered.status,
      JSON.stringify(await recovered.clone().json()),
    ).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      replayed: true,
      speaker: { id: recoveredDomain.speaker.id },
      webhookDeliveries: [{ endpointId }],
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM event_changes change
             WHERE change.event_id = ? AND change.entity_type = 'submission'
               AND change.entity_id = ? AND change.change_type = 'updated'
               AND change.correlation_id = ?) AS changeCount,
           (SELECT COUNT(*) FROM webhook_deliveries delivery
             WHERE delivery.endpoint_id = ?
               AND delivery.event_type = 'submission.updated'
               AND delivery.entity_id = ?
               AND delivery.idempotency_key = ?) AS webhookCount`,
      )
        .bind(
          eventId,
          submissionId,
          recoveryOperationId,
          endpointId,
          submissionId,
          `webhook:${endpointId}:submission.updated:${recoveryOperationId}`,
        )
        .first(),
    ).resolves.toEqual({ changeCount: 1, webhookCount: 1 });
    const changedReplay = await participantSubmissionRequest({
      submissionId,
      command: "invite-co-speaker",
      idempotencyKey,
      body: { ...body, name: "Changed co-author" },
    });
    expect(changedReplay.status).toBe(409);

    const listed = await participantResourceLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/participant/submissions?limit=100`,
        { headers: participantHeaders("submitter") },
      ),
      params: { eventId, resource: "submissions" },
      context: routeContext(),
    } as never);
    const listedBody = (await listed.json()) as {
      submissions: Array<{
        id: string;
        speakers: Array<{
          id: string;
          roleLabel: string;
          invitationStatus: string;
        }>;
      }>;
    };
    expect(
      listedBody.submissions.find(
        (submission) => submission.id === submissionId,
      )?.speakers,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: invitedBody.speaker.id,
          roleLabel: "Co-author",
          invitationStatus: "sent",
        }),
      ]),
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM submission_speakers speaker
             WHERE speaker.submission_id = ? AND speaker.email = ? COLLATE NOCASE) AS speakerCount,
           (SELECT COUNT(*) FROM audit_events audit
             WHERE audit.event_id = ? AND audit.entity_id = ?
               AND audit.action = 'submission.speaker.added_after_acceptance') AS auditCount,
           (SELECT COUNT(*) FROM event_changes change
             WHERE change.event_id = ? AND change.entity_type = 'submission'
               AND change.entity_id = ? AND change.change_type = 'updated'
               AND change.correlation_id = ?) AS changeCount,
           (SELECT COUNT(*) FROM webhook_deliveries delivery
             WHERE delivery.endpoint_id = ? AND delivery.event_type = 'submission.updated'
               AND delivery.entity_id = ?
               AND delivery.idempotency_key = ?) AS webhookCount`,
      )
        .bind(
          submissionId,
          body.email,
          eventId,
          invitedBody.speaker.id,
          eventId,
          submissionId,
          invitedBody.invitation.operationId,
          endpointId,
          submissionId,
          `webhook:${endpointId}:submission.updated:${invitedBody.invitation.operationId}`,
        )
        .first(),
    ).resolves.toEqual({
      speakerCount: 1,
      auditCount: 1,
      changeCount: 1,
      webhookCount: 1,
    });

    const browserIdempotencyKey = `browser-co-speaker-${crypto.randomUUID()}`;
    const browserEmail = `browser-co-speaker-${crypto.randomUUID()}@example.com`;
    const browserInput = {
      _intent: "invite_co_speaker",
      applicationId: submissionId,
      revision: String(recoveredDomain.submission.revision),
      idempotencyKey: browserIdempotencyKey,
      confirmed: "true",
      name: "Browser co-speaker",
      email: browserEmail,
      roleLabel: "Co-speaker",
    };
    const queueFailure = vi
      .spyOn(testEnv.OPERATIONS_QUEUE!, "send")
      .mockRejectedValue(new Error("queue unavailable"));
    const browserResult = await participantApplicationsRequest(
      new URLSearchParams(browserInput),
    );
    if (browserResult instanceof Response) {
      throw new Error(
        `Participant application invite returned ${browserResult.status}.`,
      );
    }
    expect(browserResult.init?.status ?? 200).toBe(207);
    expect(browserResult.data).toMatchObject({
      ok: false,
      partial: true,
      applicationId: submissionId,
    });
    expect(browserResult.data.message).toContain(
      "Browser co-speaker was added as co-speaker",
    );
    expect(browserResult.data.message).toContain(
      "invitation delivery could not be queued",
    );
    expect(browserResult.data.message).toContain(
      "one or more outbound webhooks require attention",
    );

    const browserReplay = await participantApplicationsRequest(
      new URLSearchParams(browserInput),
    );
    if (browserReplay instanceof Response) {
      throw new Error(
        `Participant application replay returned ${browserReplay.status}.`,
      );
    }
    expect(browserReplay.init?.status ?? 200).toBe(207);
    expect(browserReplay.data).toEqual(browserResult.data);
    queueFailure.mockRestore();

    const browserOperation = await testEnv.DB.prepare(
      `SELECT id FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ?
          AND actor_id = ? AND scope = ? AND idempotency_key = ?`,
    )
      .bind(
        organisationId,
        eventId,
        `person:${DEMO_IDENTITIES.submitter.personId}`,
        "participant.submission.invite_co_speaker",
        browserIdempotencyKey,
      )
      .first<{ id: string }>();
    expect(browserOperation).not.toBeNull();
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM submission_speakers speaker
             WHERE speaker.submission_id = ? AND speaker.email = ? COLLATE NOCASE)
             AS speakerCount,
           (SELECT COUNT(*) FROM event_changes change
             WHERE change.event_id = ? AND change.entity_type = 'submission'
               AND change.entity_id = ? AND change.change_type = 'updated'
               AND change.correlation_id = ?) AS changeCount,
           (SELECT COUNT(*) FROM webhook_deliveries delivery
             WHERE delivery.endpoint_id = ? AND delivery.event_type = 'submission.updated'
               AND delivery.entity_id = ? AND delivery.idempotency_key = ?)
             AS webhookCount`,
      )
        .bind(
          submissionId,
          browserEmail,
          eventId,
          submissionId,
          browserOperation!.id,
          endpointId,
          submissionId,
          `webhook:${endpointId}:submission.updated:${browserOperation!.id}`,
        )
        .first(),
    ).resolves.toEqual({ speakerCount: 1, changeCount: 1, webhookCount: 1 });
  });

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

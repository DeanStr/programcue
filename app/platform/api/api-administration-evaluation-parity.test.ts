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

describe("administration command and evaluation webhook parity", () => {
  it("creates one direct session for an API key and audits the non-human actor", async () => {
    const apiKey = await createApiKey("sessions:write");
    const body = {
      title: "API-created direct session",
      description:
        "A bounded direct-session command created by an integration.",
      format: "presentation",
      trackId: "demo-track-ai",
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

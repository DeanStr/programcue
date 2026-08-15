import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import { CommunicationTemplateService } from "~/modules/communications/communication-template-service.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_IDENTITIES, ensureDemoData } from "~/platform/demo/seed.server";
import { action as communicationAction } from "~/routes/api-communication-command";
import { action as evaluationPersonAction } from "~/routes/api-evaluation-person-command";
import { action as operationAction } from "~/routes/api-operation-command";

const testEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const organisationId = "org-future-events";

function context(environment: CloudflareEnvironment = testEnv) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

function headers(role: "administrator" | "evaluator", extra: HeadersInit = {}) {
  return new Headers({
    cookie: `program_cue_demo_identity=${role}`,
    origin: "https://programcue.test",
    "content-type": "application/json",
    ...Object.fromEntries(new Headers(extra)),
  });
}

function viewer(role: "administrator" | "evaluator"): Viewer {
  return {
    ...DEMO_IDENTITIES[role],
    role,
    organisationId,
    eventId,
    demo: true,
  };
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
});

afterEach(() => vi.restoreAllMocks());

describe("authenticated-person API commands", () => {
  it("previews and schedules one exact-replay communication", async () => {
    const admin = viewer("administrator");
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, 'API sender', 'Program Cue', 'events@example.com',
                 'reply@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
    )
      .bind(`api-sender-${crypto.randomUUID()}`, eventId)
      .run();
    const environment = {
      ...testEnv,
      RESEND_API_KEY: "test-resend-key",
      OPERATIONS_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as CloudflareEnvironment;
    const templates = new CommunicationTemplateService(testEnv);
    const saved = await templates.saveTemplate(admin, {
      name: `API scheduled message ${crypto.randomUUID()}`,
      category: "ad_hoc",
      subject: "Programme update",
      content: {
        body: "The programme has an important update.",
        physicalAddress: "1 Programme Way, London",
      },
    });
    await templates.publishTemplate(admin, saved.versionId);
    const previewBody = {
      templateVersionId: saved.versionId,
      audienceType: "event_administrators" as const,
      manualRecipients: "",
      kind: "transactional" as const,
    };
    const { kind: _previewKind, ...previewWithoutKind } = previewBody;
    const missingPreviewKind = await communicationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/communications/preview`,
        {
          method: "POST",
          headers: headers("administrator"),
          body: JSON.stringify(previewWithoutKind),
        },
      ),
      params: { eventId, command: "preview" },
      context: context(environment),
    } as never);
    expect(missingPreviewKind.status).toBe(422);
    await expect(missingPreviewKind.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const preview = await communicationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/communications/preview`,
        {
          method: "POST",
          headers: headers("administrator"),
          body: JSON.stringify(previewBody),
        },
      ),
      params: { eventId, command: "preview" },
      context: context(environment),
    } as never);
    expect(preview.status).toBe(200);
    const previewResult = (await preview.json()) as {
      result: {
        confirmation: {
          recipientFingerprint: string;
          deliverableFingerprint: string;
          suppressedCount: number;
        };
      };
    };
    const idempotencyKey = `communication-api-${crypto.randomUUID()}`;
    const scheduleBody = {
      ...previewBody,
      ...previewResult.result.confirmation,
      idempotencyKey,
      scheduledAt: Math.floor(Date.now() / 1_000) + 3_600,
    };
    const {
      kind: _sendKind,
      scheduledAt: _scheduledAt,
      ...sendWithoutKind
    } = scheduleBody;
    const missingSendKind = await communicationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/communications/send`,
        {
          method: "POST",
          headers: headers("administrator", {
            "idempotency-key": idempotencyKey,
          }),
          body: JSON.stringify(sendWithoutKind),
        },
      ),
      params: { eventId, command: "send" },
      context: context(environment),
    } as never);
    expect(missingSendKind.status).toBe(422);
    await expect(missingSendKind.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const { kind: _scheduleKind, ...scheduleWithoutKind } = scheduleBody;
    const missingScheduleKind = await communicationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/communications/schedule`,
        {
          method: "POST",
          headers: headers("administrator", {
            "idempotency-key": idempotencyKey,
          }),
          body: JSON.stringify(scheduleWithoutKind),
        },
      ),
      params: { eventId, command: "schedule" },
      context: context(environment),
    } as never);
    expect(missingScheduleKind.status).toBe(422);
    await expect(missingScheduleKind.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const schedule = () =>
      communicationAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/communications/schedule`,
          {
            method: "POST",
            headers: headers("administrator", {
              "idempotency-key": idempotencyKey,
            }),
            body: JSON.stringify(scheduleBody),
          },
        ),
        params: { eventId, command: "schedule" },
        context: context(environment),
      } as never);
    const first = await schedule();
    expect(first.status, await first.clone().text()).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      result: { status: "scheduled", duplicate: false },
    });
    const replay = await schedule();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      result: { status: "scheduled", duplicate: true },
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM communications
          WHERE event_id = ? AND idempotency_key = ?`,
      )
        .bind(eventId, idempotencyKey)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("binds review conflicts to the signed-in evaluator and exact URL event", async () => {
    await ensureDemoEvaluationData(testEnv);
    const assignment = await testEnv.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND evaluator_person_id = ? AND status = 'assigned'
        ORDER BY id LIMIT 1`,
    )
      .bind(eventId, DEMO_IDENTITIES.evaluator.personId)
      .first<{ id: string }>();
    expect(assignment).toBeTruthy();
    const invoke = (origin: string) =>
      evaluationPersonAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/me/conflict`,
          {
            method: "POST",
            headers: headers("evaluator", { origin }),
            body: JSON.stringify({
              assignmentId: assignment!.id,
              reason:
                "I have a current professional conflict with this applicant.",
            }),
          },
        ),
        params: { eventId, command: "conflict" },
        context: context(),
      } as never);
    expect((await invoke("https://attacker.test")).status).toBe(403);
    const response = await invoke("https://programcue.test");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      assignmentId: assignment!.id,
      status: "recused",
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT status FROM evaluator_assignments WHERE id = ? AND event_id = ?",
      )
        .bind(assignment!.id, eventId)
        .first(),
    ).resolves.toEqual({ status: "recused" });
  });

  it("submits a review with the required conflict attestation", async () => {
    await ensureDemoEvaluationData(testEnv);
    const evaluator = viewer("evaluator");
    const service = new EvaluationService(testEnv);
    const workspace = await service.getReviewerWorkspace(evaluator);
    expect(workspace.selected).toBeTruthy();
    const scores = Object.fromEntries(
      workspace.criteria.map((criterion) => {
        if (criterion.inputType === "yes_no") return [criterion.id, "yes"];
        if (criterion.inputType === "dropdown")
          return [criterion.id, criterion.options[0]];
        if (criterion.inputType === "free_text")
          return [criterion.id, "Reviewed through the person API."];
        return [criterion.id, 4];
      }),
    );
    const invoke = (body: Record<string, unknown>) =>
      evaluationPersonAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/me/review`,
          {
            method: "POST",
            headers: headers("evaluator"),
            body: JSON.stringify(body),
          },
        ),
        params: { eventId, command: "review" },
        context: context(),
      } as never);
    const input = {
      assignmentId: workspace.selected!.id,
      revision: workspace.review?.revision ?? 0,
      scores,
      recommendation: "accept",
      confidence: 4,
      submitterFeedback: "A strong and relevant proposal.",
      privateNotes: "Reviewed through the authenticated-person API.",
      intent: "submit",
    };

    const unattested = await invoke(input);
    expect(unattested.status).toBe(422);
    await expect(unattested.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });

    const response = await invoke({ ...input, conflictAffirmed: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const payload = (await response.json()) as {
      reviewId: string;
      revision: number;
    };
    expect(payload).toMatchObject({
      reviewId: expect.any(String),
      revision: 1,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, conflict_affirmed_at AS conflictAffirmedAt
           FROM reviews WHERE id = ? AND event_id = ?`,
      )
        .bind(payload.reviewId, eventId)
        .first<{ status: string; conflictAffirmedAt: number | null }>(),
    ).resolves.toEqual({
      status: "submitted",
      conflictAffirmedAt: expect.any(Number),
    });
  });

  it("requeues a failed calendar sync through the durable operation contract", async () => {
    const operationId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'calendar.sync', ?, ?, 'failed', ?,
                 1, 0, 1, 0, 'provider timeout', unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        organisationId,
        eventId,
        DEMO_IDENTITIES.administrator.personId,
        `calendar-retry-${operationId}`,
        `calendar-correlation-${operationId}`,
        JSON.stringify({
          type: "calendar.sync",
          operationId,
          eventId,
          organisationId,
        }),
      )
      .run();
    const send = vi.fn(async () => undefined);
    const environment = {
      ...testEnv,
      OPERATIONS_QUEUE: { send },
    } as unknown as CloudflareEnvironment;
    const response = await operationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/operations/${operationId}/retry`,
        {
          method: "POST",
          headers: headers("administrator"),
          body: JSON.stringify({ confirmed: true }),
        },
      ),
      params: { eventId, operationId, command: "retry" },
      context: context(environment),
    } as never);
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      operationId,
      status: "queued",
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "queued", lastError: null });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { defaultRecommendationChoices } from "~/modules/evaluations/evaluation-recommendation-choices";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentService,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment.server";
import {
  AiConfigurationError,
  type AiModelProvider,
  AiProviderError,
  type OpenAiResponse,
  type OpenAiResponsesRequest,
} from "./openai-responses-provider.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  ...admin,
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
};

const committeeChair: Viewer = {
  ...admin,
  personId: "person-demo-chair",
  name: "Priya Shah",
  email: "priya.chair@example.com",
  role: "committee_chair",
};

const ROUND_ID = "demo-evaluation-round";
const SUBMISSION_ID = "demo-evaluation-submission-calm";
const generatedAt = new Date("2026-08-13T12:00:00Z");

function structuredResponse(
  value: unknown,
  id = `workers-ai-response-${crypto.randomUUID()}`,
): OpenAiResponse {
  return {
    id,
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(value),
          },
        ],
      },
    ],
  };
}

function workersAiProvider(
  create: (request: OpenAiResponsesRequest) => Promise<OpenAiResponse>,
): AiModelProvider {
  return {
    providerName: "Workers AI",
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    create,
  };
}

function validAssessment() {
  return {
    score: 4.25,
    rationale:
      "The proposal gives a concrete incident cadence and handoff checklist for fragmented run-of-show decisions. Its facilitated scenario and reusable operating template support practical audience value, although the abstract does not quantify prior outcomes.",
  };
}

function generationInput(generationIntentId = crypto.randomUUID()) {
  return {
    generationIntentId,
    roundId: ROUND_ID,
    submissionId: SUBMISSION_ID,
    confirmed: true,
  };
}

beforeEach(async () => {
  await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_review_assessments WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare(
      `DELETE FROM operation_jobs
        WHERE event_id = ? AND type = 'ai.review_assessment.generate'`,
    ).bind(admin.eventId),
    env.DB.prepare(
      "UPDATE evaluation_rounds SET blinded_reviewing = 1, revision = 1 WHERE id = ? AND event_id = ?",
    ).bind(ROUND_ID, admin.eventId),
    env.DB.prepare(
      "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
    ).bind(admin.eventId, admin.organisationId),
  ]);
});

describe("persisted AI first-pass review assessments", () => {
  it("requires explicit confirmation before generation or override work", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    const unconfirmedGeneration = generationInput() as Record<string, unknown>;
    delete unconfirmedGeneration.confirmed;
    await expect(
      service.generate(admin, unconfirmedGeneration),
    ).rejects.toThrow(/confirm the AI first-pass assessment/i);
    expect(create).not.toHaveBeenCalled();

    const generated = await service.generate(admin, generationInput());
    await expect(
      service.override(admin, {
        assessmentId: generated.id,
        expectedRevision: generated.revision,
        score: 3.5,
        rationale:
          "This unconfirmed override must not modify the effective advisory score.",
      }),
    ).rejects.toThrow(/confirm the human assessment of AI/i);
    expect(
      await env.DB.prepare(
        `SELECT override_score AS overrideScore, revision
           FROM ai_review_assessments WHERE id = ?`,
      )
        .bind(generated.id)
        .first<{ overrideScore: number | null; revision: number }>(),
    ).toEqual({ overrideScore: null, revision: generated.revision });
  });

  it("rejects a terminal proposal without archived decision provenance", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    await env.DB.prepare(
      `UPDATE submissions SET status = 'accepted'
        WHERE id = ? AND event_id = ?`,
    )
      .bind(SUBMISSION_ID, admin.eventId)
      .run();
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    try {
      await expect(
        service.generate(admin, generationInput()),
      ).rejects.toMatchObject({ status: 404 });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare(
        `UPDATE submissions SET status = 'assigned'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(SUBMISSION_ID, admin.eventId)
        .run();
    }
  });

  it("grounds strict structured output in the blind projection and persists provider attribution", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment(), "response-1"));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        now: () => generatedAt,
      },
    );

    const assessment = await service.generate(admin, generationInput());

    expect(assessment).toMatchObject({
      roundId: ROUND_ID,
      submissionId: SUBMISSION_ID,
      score: 4.25,
      overridden: false,
      provider: "workers_ai",
      providerLabel: "Workers AI",
      model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      providerResponseId: "response-1",
      submissionRevisionNumber: 1,
      sourceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      modelInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptVersion: 1,
      revision: 1,
    });
    expect(assessment.rationale).toContain("run-of-show");

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0];
    expect(request.textFormat?.name).toBe("program_cue_ai_review_assessment");
    expect(request.maxOutputTokens).toBe(4_000);
    expect(request.textFormat?.schema).toMatchObject({
      properties: { rationale: { maxLength: 2_000 } },
    });
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain("fragmented run-of-show decisions");
    expect(request.input).not.toContain("Alex Morgan");
    expect(request.input).not.toContain("alex.submitter@example.com");
    expect(request.input).toContain('"blinded":true');

    const persisted = await env.DB.prepare(
      `SELECT score, rationale, provider, model,
              provider_response_id AS responseId,
              submission_revision_id AS submissionRevisionId,
              source_snapshot_sha256 AS sourceSnapshotSha256,
              model_input_sha256 AS modelInputSha256,
              prompt_version AS promptVersion,
              override_score AS overrideScore, revision
         FROM ai_review_assessments WHERE id = ?`,
    )
      .bind(assessment.id)
      .first<{
        score: number;
        rationale: string;
        provider: string;
        model: string;
        responseId: string;
        submissionRevisionId: string;
        sourceSnapshotSha256: string;
        modelInputSha256: string;
        promptVersion: number;
        overrideScore: number | null;
        revision: number;
      }>();
    expect(persisted).toMatchObject({
      score: 4.25,
      rationale: validAssessment().rationale,
      provider: "workers_ai",
      model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      responseId: "response-1",
      submissionRevisionId: `demo-evaluation-submission-revision-${SUBMISSION_ID}`,
      sourceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      modelInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptVersion: 1,
      overrideScore: null,
      revision: 1,
    });

    const operation = await env.DB.prepare(
      `SELECT status, result_json AS resultJson
         FROM operation_jobs
        WHERE id = (SELECT last_operation_id
                      FROM ai_review_assessments WHERE id = ?)`,
    )
      .bind(assessment.id)
      .first<{ status: string; resultJson: string }>();
    expect(operation?.status).toBe("completed");
    expect(JSON.parse(operation!.resultJson)).toMatchObject({
      assessmentId: assessment.id,
      score: 4.25,
      provider: "workers_ai",
    });

    const actions = await env.DB.prepare(
      `SELECT action, actor_kind AS actorKind, origin,
              actor_person_id AS actorPersonId, actor_id AS actorId
         FROM audit_events
        WHERE event_id = ? AND correlation_id = (
          SELECT correlation_id FROM operation_jobs
           WHERE id = (SELECT last_operation_id
                         FROM ai_review_assessments WHERE id = ?)
        ) ORDER BY action`,
    )
      .bind(admin.eventId, assessment.id)
      .all<{
        action: string;
        actorKind: string;
        origin: string;
        actorPersonId: string | null;
        actorId: string | null;
      }>();
    expect(actions.results.map(({ action }) => action)).toEqual([
      "ai.review_assessment.generated",
      "ai.review_assessment.requested",
    ]);
    expect(
      actions.results.find(
        ({ action }) => action === "ai.review_assessment.requested",
      ),
    ).toMatchObject({
      actorKind: "person",
      origin: "admin_ui",
      actorPersonId: admin.personId,
      actorId: null,
    });
    expect(
      actions.results.find(
        ({ action }) => action === "ai.review_assessment.generated",
      ),
    ).toMatchObject({
      actorKind: "agent",
      origin: "admin_ui",
      actorPersonId: admin.personId,
      actorId: "program_cue_agent",
    });
  });

  it("sends proposal evidence to the provider in authored section order", async () => {
    const row = await env.DB.prepare(
      `SELECT submitted_snapshot_json AS snapshotJson
         FROM submissions WHERE id = ? AND event_id = ?`,
    )
      .bind(SUBMISSION_ID, admin.eventId)
      .first<{ snapshotJson: string }>();
    if (!row) throw new Error("The evaluation demo snapshot was not created.");
    const snapshot = JSON.parse(row.snapshotJson) as {
      schema: {
        sections: Array<{ id: string; title: string; description: string }>;
        fields: Array<{ id: string; sectionId: string }>;
      };
    };
    snapshot.schema.sections = [
      { id: "outcomes", title: "Outcomes", description: "" },
      { id: "proposal", title: "Proposal", description: "" },
    ];
    snapshot.schema.fields = snapshot.schema.fields.map((field) => ({
      ...field,
      sectionId: field.id === "audience_takeaway" ? "outcomes" : "proposal",
    }));
    await env.DB.prepare(
      `UPDATE submissions SET submitted_snapshot_json = ?
        WHERE id = ? AND event_id = ?`,
    )
      .bind(JSON.stringify(snapshot), SUBMISSION_ID, admin.eventId)
      .run();

    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    await service.generate(admin, generationInput());

    const providerInput = create.mock.calls[0]![0].input;
    expect(providerInput.indexOf('"label":"Audience takeaway"')).toBeLessThan(
      providerInput.indexOf('"label":"Session overview"'),
    );
  });

  it("rejects invalid provider output without storing a fallback score", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(
        structuredResponse({
          score: 8,
          rationale:
            "This text is long enough to prove that only the invalid score caused contract rejection.",
        }),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    await expect(
      service.generate(admin, generationInput()),
    ).rejects.toBeInstanceOf(AiProviderError);

    const assessmentCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ai_review_assessments WHERE event_id = ?",
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(assessmentCount?.count).toBe(0);
    const operation = await env.DB.prepare(
      `SELECT status, last_error AS lastError
         FROM operation_jobs
        WHERE event_id = ? AND type = 'ai.review_assessment.generate'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(admin.eventId)
      .first<{ status: string; lastError: string }>();
    expect(operation).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/score-and-rationale contract/i),
    });
    const failureAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events audit
         JOIN operation_jobs operation
           ON operation.correlation_id = audit.correlation_id
        WHERE audit.event_id = ?
          AND audit.action = 'ai.review_assessment.failed'
          AND operation.type = 'ai.review_assessment.generate'`,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(failureAudit?.count).toBe(1);
  });

  it("creates an explicitly acknowledged attempt linked to the retained failed operation", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockRejectedValueOnce(
        new AiProviderError(
          "Workers AI request failed with status 503.",
          503,
          "provider-request-503",
        ),
      )
      .mockResolvedValueOnce(
        structuredResponse(validAssessment(), "retry-provider-response"),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create), now: () => generatedAt },
    );
    const failedInput = generationInput();

    await expect(service.generate(admin, failedInput)).rejects.toThrow(
      /status 503/i,
    );
    await expect(
      service.generate(admin, {
        ...generationInput(),
        retryFailedOperationId: failedInput.generationIntentId,
      }),
    ).rejects.toThrow(/acknowledge.*duplicate provider request or charge/i);
    expect(create).toHaveBeenCalledTimes(1);

    const failedAttempts = await service.listGenerationAttempts(admin);
    expect(failedAttempts).toEqual([
      expect.objectContaining({
        status: "failed",
        operationId: failedInput.generationIntentId,
        roundId: ROUND_ID,
        submissionId: SUBMISSION_ID,
        lastError: expect.stringMatching(/status 503/i),
        providerRequestId: "provider-request-503",
      }),
    ]);
    await expect(
      service.listGenerationAttempts(committeeChair),
    ).rejects.toMatchObject({ status: 403 });

    const retryInput = {
      ...generationInput(),
      retryFailedOperationId: failedInput.generationIntentId,
      duplicateRiskAcknowledged: true as const,
    };
    await expect(service.generate(admin, retryInput)).resolves.toMatchObject({
      providerResponseId: "retry-provider-response",
      score: 4.25,
    });
    expect(create).toHaveBeenCalledTimes(2);
    await expect(service.generate(admin, retryInput)).resolves.toMatchObject({
      providerResponseId: "retry-provider-response",
    });
    expect(create).toHaveBeenCalledTimes(2);

    const operations = await env.DB.prepare(
      `SELECT id, idempotency_key AS idempotencyKey, status,
              json_extract(payload_json, '$.retryOfOperationId') AS retryOfOperationId
         FROM operation_jobs
        WHERE event_id = ? AND type = 'ai.review_assessment.generate'
        ORDER BY id`,
    )
      .bind(admin.eventId)
      .all<{
        id: string;
        idempotencyKey: string;
        status: string;
        retryOfOperationId: string | null;
      }>();
    expect(operations.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: failedInput.generationIntentId,
          status: "failed",
          retryOfOperationId: null,
        }),
        expect.objectContaining({
          id: retryInput.generationIntentId,
          idempotencyKey: `ai-review-assessment-attempt:${retryInput.generationIntentId}`,
          status: "completed",
          retryOfOperationId: failedInput.generationIntentId,
        }),
      ]),
    );
  });

  it("allows a fresh attempt for a new immutable revision with unchanged content", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockRejectedValueOnce(
        new AiProviderError("Workers AI request failed with status 503.", 503),
      )
      .mockResolvedValueOnce(
        structuredResponse(validAssessment(), "same-content-revision-response"),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    await expect(service.generate(admin, generationInput())).rejects.toThrow(
      /status 503/i,
    );
    const revision = await env.DB.prepare(
      `SELECT revision.id, revision.form_version_id AS formVersionId,
              revision.revision_number AS revisionNumber,
              revision.answers_json AS answersJson,
              revision.speaker_snapshot_json AS speakerSnapshotJson
         FROM submission_revisions revision
        WHERE revision.event_id = ? AND revision.submission_id = ?
          AND revision.save_kind = 'submitted'
        ORDER BY revision.revision_number DESC, revision.id DESC
        LIMIT 1`,
    )
      .bind(admin.eventId, SUBMISSION_ID)
      .first<{
        id: string;
        formVersionId: string;
        revisionNumber: number;
        answersJson: string;
        speakerSnapshotJson: string;
      }>();
    if (!revision)
      throw new Error("Submitted revision fixture is unavailable.");
    const nextRevisionId = `same-content-revision-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE submissions SET revision = revision + 1
          WHERE id = ? AND event_id = ? AND revision = ?`,
      ).bind(SUBMISSION_ID, admin.eventId, revision.revisionNumber),
      env.DB.prepare(
        `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind,
           saved_by_person_id, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, unixepoch())`,
      ).bind(
        nextRevisionId,
        admin.eventId,
        SUBMISSION_ID,
        revision.formVersionId,
        revision.revisionNumber + 1,
        revision.answersJson,
        revision.speakerSnapshotJson,
        admin.personId,
        nextRevisionId,
      ),
    ]);

    try {
      await expect(
        service.generate(admin, generationInput()),
      ).resolves.toMatchObject({
        submissionRevisionId: nextRevisionId,
        submissionRevisionNumber: revision.revisionNumber + 1,
        providerResponseId: "same-content-revision-response",
      });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM ai_review_assessments WHERE submission_revision_id = ?",
        ).bind(nextRevisionId),
        env.DB.prepare(
          "DELETE FROM submission_revisions WHERE id = ? AND event_id = ?",
        ).bind(nextRevisionId, admin.eventId),
        env.DB.prepare(
          `UPDATE submissions SET revision = ?
            WHERE id = ? AND event_id = ? AND revision = ?`,
        ).bind(
          revision.revisionNumber,
          SUBMISSION_ID,
          admin.eventId,
          revision.revisionNumber + 1,
        ),
      ]);
    }
  });

  it("allows only one explicit retry attempt to reach the provider", async () => {
    let releaseRetry!: (response: OpenAiResponse) => void;
    let markRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const pendingRetry = new Promise<OpenAiResponse>((resolve) => {
      releaseRetry = resolve;
    });
    let providerCall = 0;
    const create = vi.fn(async () => {
      providerCall += 1;
      if (providerCall === 1) {
        throw new AiProviderError(
          "Workers AI was temporarily unavailable.",
          503,
        );
      }
      markRetryStarted();
      return pendingRetry;
    });
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const failedInput = generationInput();
    await expect(service.generate(admin, failedInput)).rejects.toThrow(
      /temporarily unavailable/i,
    );
    const retry = (generationIntentId = crypto.randomUUID()) => ({
      ...generationInput(generationIntentId),
      retryFailedOperationId: failedInput.generationIntentId,
      duplicateRiskAcknowledged: true as const,
    });

    const firstRetry = service.generate(admin, retry());
    await retryStarted;
    await expect(service.listGenerationAttempts(admin)).resolves.toEqual([
      expect.objectContaining({
        status: "running",
        retryOfOperationId: failedInput.generationIntentId,
        requestedByName: expect.any(String),
        submissionId: SUBMISSION_ID,
      }),
    ]);
    await expect(service.generate(admin, retry())).rejects.toThrow(
      /already running/i,
    );
    expect(create).toHaveBeenCalledTimes(2);

    releaseRetry(
      structuredResponse(validAssessment(), "single-retry-response"),
    );
    await expect(firstRetry).resolves.toMatchObject({
      providerResponseId: "single-retry-response",
    });
    expect(create).toHaveBeenCalledTimes(2);
    await expect(service.listGenerationAttempts(admin)).resolves.toEqual([]);
  });

  it("fails fast when a completed operation has no persisted assessment", async () => {
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(async () =>
          structuredResponse(validAssessment(), "missing-assessment-response"),
        ),
      },
    );
    const generated = await service.generate(admin, generationInput());
    await env.DB.prepare("DELETE FROM ai_review_assessments WHERE id = ?")
      .bind(generated.id)
      .run();

    await expect(service.listGenerationAttempts(admin)).rejects.toThrow(
      /completed.*missing.*persisted assessment/i,
    );
  });

  it("omits retained AI attempt history after its assessments are deleted", async () => {
    const retainedEventId = `retained-ai-event-${crypto.randomUUID()}`;
    const retainedViewer = { ...admin, eventId: retainedEventId };
    await env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         participant_retention_completed_at, file_policy_json
       ) VALUES (?, ?, 'Retained AI event', ?, 'UTC', 1, 2, unixepoch(), ?)`,
    )
      .bind(
        retainedEventId,
        admin.organisationId,
        retainedEventId,
        CANONICAL_EVENT_FILE_POLICY_JSON,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         result_json, progress_total, progress_completed, completed_at
       ) VALUES (?, ?, ?, ?, 'ai.review_assessment.generate', ?, ?,
                 'completed', '{}', '{}', 1, 1, unixepoch())`,
    )
      .bind(
        `retained-ai-operation-${crypto.randomUUID()}`,
        admin.organisationId,
        retainedEventId,
        admin.personId,
        `retained-ai-intent-${crypto.randomUUID()}`,
        crypto.randomUUID(),
      )
      .run();
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
    );

    try {
      await expect(
        service.listGenerationAttempts(retainedViewer),
      ).resolves.toEqual([]);
    } finally {
      await env.DB.prepare("DELETE FROM events WHERE id = ?")
        .bind(retainedEventId)
        .run();
    }
  });

  it("fails fast when durable retry lineage references a missing parent", async () => {
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(async () => {
          throw new AiProviderError("Workers AI request failed.", 503);
        }),
      },
    );
    const failedInput = generationInput();
    await expect(service.generate(admin, failedInput)).rejects.toThrow(
      /request failed/i,
    );
    await env.DB.prepare(
      `UPDATE operation_jobs
          SET payload_json = json_set(
                payload_json,
                '$.retryOfOperationId',
                'missing-ai-assessment-operation'
              )
        WHERE id = ?`,
    )
      .bind(failedInput.generationIntentId)
      .run();

    await expect(service.listGenerationAttempts(admin)).rejects.toThrow(
      /references missing operation/i,
    );
  });

  it("rejects a stale retry once the failed operation has a retry child", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockRejectedValueOnce(
        new AiProviderError("Workers AI initial request failed.", 503),
      )
      .mockRejectedValueOnce(
        new AiProviderError("Workers AI retry request failed.", 503),
      )
      .mockResolvedValueOnce(
        structuredResponse(validAssessment(), "latest-retry-response"),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const initialInput = generationInput();
    await expect(service.generate(admin, initialInput)).rejects.toThrow(
      /initial request failed/i,
    );
    const firstRetryInput = {
      ...generationInput(),
      retryFailedOperationId: initialInput.generationIntentId,
      duplicateRiskAcknowledged: true as const,
    };
    await expect(service.generate(admin, firstRetryInput)).rejects.toThrow(
      /retry request failed/i,
    );

    await expect(
      service.generate(admin, {
        ...generationInput(),
        retryFailedOperationId: initialInput.generationIntentId,
        duplicateRiskAcknowledged: true,
      }),
    ).rejects.toThrow(/newer retry already exists/i);
    expect(create).toHaveBeenCalledTimes(2);

    const [latestFailure] = await service.listGenerationAttempts(admin);
    if (!latestFailure) throw new Error("Expected the failed retry leaf.");
    expect(latestFailure.operationId).toBe(firstRetryInput.generationIntentId);
    await expect(
      service.generate(admin, {
        ...generationInput(),
        retryFailedOperationId: latestFailure.operationId,
        duplicateRiskAcknowledged: true,
      }),
    ).resolves.toMatchObject({
      providerResponseId: "latest-retry-response",
    });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("reconciles an expired explicit retry before another provider attempt", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockRejectedValueOnce(
        new AiProviderError("Workers AI was temporarily unavailable.", 503),
      )
      .mockResolvedValueOnce(
        structuredResponse(validAssessment(), "unpersisted-retry-response"),
      )
      .mockResolvedValueOnce(
        structuredResponse(validAssessment(), "recovered-retry-response"),
      );
    let interruptBeforePersistence = true;
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        beforeProviderResultPersisted: () => {
          if (!interruptBeforePersistence) return;
          interruptBeforePersistence = false;
          throw new Error("Simulated Worker exit before retry persistence.");
        },
      },
    );
    const initialInput = generationInput();
    await expect(service.generate(admin, initialInput)).rejects.toThrow(
      /temporarily unavailable/i,
    );

    const interruptedRetry = {
      ...generationInput(),
      retryFailedOperationId: initialInput.generationIntentId,
      duplicateRiskAcknowledged: true as const,
    };
    await expect(service.generate(admin, interruptedRetry)).rejects.toThrow(
      /simulated Worker exit/i,
    );
    expect(create).toHaveBeenCalledTimes(2);
    await env.DB.prepare(
      "UPDATE operation_jobs SET claim_expires_at = 0 WHERE id = ?",
    )
      .bind(interruptedRetry.generationIntentId)
      .run();

    await expect(
      service.reconcileGenerationAttempt(admin, {
        operationId: interruptedRetry.generationIntentId,
      }),
    ).resolves.toEqual({
      status: "failed",
      operationId: interruptedRetry.generationIntentId,
    });
    expect(create).toHaveBeenCalledTimes(2);

    const [latestFailure] = await service.listGenerationAttempts(admin);
    expect(latestFailure?.operationId).toBe(
      interruptedRetry.generationIntentId,
    );
    await expect(
      service.generate(admin, {
        ...generationInput(),
        retryFailedOperationId: latestFailure?.operationId,
        duplicateRiskAcknowledged: true,
      }),
    ).resolves.toMatchObject({
      providerResponseId: "recovered-retry-response",
    });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("keeps the AI result immutable while a CAS-protected human override persists separately", async () => {
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(async () =>
          structuredResponse(validAssessment(), "response-override"),
        ),
        now: () => generatedAt,
      },
    );
    const generated = await service.generate(admin, generationInput());

    const overridden = await service.override(admin, {
      assessmentId: generated.id,
      expectedRevision: generated.revision,
      score: 3.5,
      rationale:
        "Human override after committee review of the evidence and rubric weighting.",
      confirmed: true,
    });

    expect(overridden).toMatchObject({
      score: 4.25,
      overrideScore: 3.5,
      overridden: true,
      overrideByPersonId: admin.personId,
      revision: 2,
    });
    expect(overridden.rationale).toBe(validAssessment().rationale);
    expect(overridden.overrideRationale).toMatch(/committee review/i);

    const listed = await service.listForEvent(admin);
    expect(listed).toEqual([
      expect.objectContaining({
        id: generated.id,
        score: 4.25,
        overrideScore: 3.5,
      }),
    ]);
    await expect(service.listGenerationAttempts(admin)).resolves.toEqual([]);

    await expect(
      service.override(admin, {
        assessmentId: generated.id,
        expectedRevision: 1,
        score: 2,
        rationale: "A stale browser must not replace the persisted override.",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(AiReviewAssessmentConflictError);

    await expect(
      env.DB.prepare("UPDATE ai_review_assessments SET score = 1 WHERE id = ?")
        .bind(generated.id)
        .run(),
    ).rejects.toThrow(/first-pass assessment fields are immutable/i);

    const overrideAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND action = 'ai.review_assessment.overridden'
          AND entity_id = ?`,
    )
      .bind(admin.eventId, generated.id)
      .first<{ count: number }>();
    expect(overrideAudit?.count).toBe(1);
  });

  it("rechecks committee-chair decision authority inside the assessment transaction", async () => {
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(async () =>
          structuredResponse(validAssessment(), "chair-authority-response"),
        ),
      },
    );
    const generated = await service.generate(admin, generationInput());
    await expect(
      service.override(committeeChair, {
        assessmentId: generated.id,
        expectedRevision: generated.revision,
        score: 4,
        rationale:
          "A chair without explicit decision authority cannot assess this advisory.",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await env.DB.prepare(
      `UPDATE evaluation_plans SET decision_role = 'committee_chair'
        WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
    )
      .bind(admin.eventId)
      .run();
    const racingService = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        beforeOverridePersisted: async () => {
          await env.DB.prepare(
            `UPDATE evaluation_plans SET decision_role = 'administrator'
              WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
          )
            .bind(admin.eventId)
            .run();
        },
      },
    );
    await expect(
      racingService.override(committeeChair, {
        assessmentId: generated.id,
        expectedRevision: generated.revision,
        score: 4,
        rationale:
          "Authority revoked before persistence must stop this chair assessment.",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      env.DB.prepare(
        `SELECT override_score AS overrideScore, revision
           FROM ai_review_assessments WHERE id = ?`,
      )
        .bind(generated.id)
        .first(),
    ).resolves.toEqual({ overrideScore: null, revision: generated.revision });
  });

  it("replays the exact completed generation intent without another provider call", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const input = generationInput();
    const first = await service.generate(admin, input);

    const replay = await service.generate(admin, input);
    expect(replay.id).toBe(first.id);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("replays a completed intent after its review cycle is archived", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(
        structuredResponse(validAssessment(), "archived-cycle-response"),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const input = generationInput();
    const generated = await service.generate(admin, input);

    const cycle = await new EvaluationService(
      env as unknown as CloudflareEnvironment,
    ).startReviewCycle(admin, {
      currentPlanId: "demo-evaluation-plan",
      currentPlanRevision: 1,
      expectedRunningAssessmentOperationCount: 0,
      expectedUnfinishedAssignmentCount: 2,
      expectedUnfinishedReviewCount: 0,
      planName: "Archived AI replay cycle",
      round: {
        name: "Fresh review",
        opensAt: null,
        closesAt: null,
        anonymous: true,
        recommendationChoices: defaultRecommendationChoices(),
        criteria: [
          {
            name: "Programme fit",
            description: "Fit for the current programme.",
            inputType: "scale_5",
            options: [],
            weightPercent: 100,
            required: true,
          },
        ],
      },
      confirmed: true,
    });

    try {
      const replay = await service.generate(admin, input);
      expect(replay.id).toBe(generated.id);
      expect(replay.providerResponseId).toBe("archived-cycle-response");
      expect(create).toHaveBeenCalledTimes(1);

      await expect(
        service.override(admin, {
          assessmentId: generated.id,
          expectedRevision: generated.revision,
          score: 3,
          rationale:
            "An archived review cycle must remain immutable after a later cycle starts.",
          confirmed: true,
        }),
      ).rejects.toBeInstanceOf(AiReviewAssessmentStateError);
      expect(await service.listForEvent(admin)).toEqual([
        expect.objectContaining({
          id: generated.id,
          revision: generated.revision,
          overrideScore: null,
        }),
      ]);
    } finally {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = ? AND event_id = ?",
        ).bind(cycle.planId, admin.eventId),
        env.DB.prepare(
          `UPDATE evaluation_plans
              SET status = 'active', revision = 1, updated_at = unixepoch()
            WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `UPDATE evaluation_rounds
              SET status = 'active', revision = 1, updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        ).bind(ROUND_ID, admin.eventId),
      ]);
    }
  });

  it("lets only one concurrent target reservation call the provider", async () => {
    let releaseProvider!: (response: OpenAiResponse) => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const response = new Promise<OpenAiResponse>((resolve) => {
      releaseProvider = resolve;
    });
    const create = vi.fn(async () => {
      providerStarted();
      return response;
    });
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const firstInput = generationInput();
    const first = service.generate(admin, firstInput);
    await started;

    const [sameIntent, distinctIntent] = await Promise.allSettled([
      service.generate(admin, firstInput),
      service.generate(admin, generationInput()),
    ]);
    expect(sameIntent).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/already running/i),
      }),
    });
    expect(distinctIntent).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/already running/i),
      }),
    });
    expect(create).toHaveBeenCalledTimes(1);

    releaseProvider(structuredResponse(validAssessment(), "one-provider-call"));
    await expect(first).resolves.toMatchObject({
      providerResponseId: "one-provider-call",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("resumes a staged provider result after a crash without calling the provider again", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(
        structuredResponse(validAssessment(), "staged-provider-response"),
      );
    let crashOnce = true;
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        now: () => generatedAt,
        afterProviderResultPersisted: () => {
          if (crashOnce) {
            crashOnce = false;
            throw new Error("simulated Worker exit after provider staging");
          }
        },
      },
    );
    const input = generationInput();

    await expect(service.generate(admin, input)).rejects.toThrow(
      /simulated Worker exit/i,
    );
    const staged = await env.DB.prepare(
      `SELECT status, json_extract(result_json, '$.phase') AS phase
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(input.generationIntentId)
      .first<{ status: string; phase: string }>();
    expect(staged).toEqual({
      status: "running",
      phase: "provider_completed",
    });

    const recovered = await service.reconcileGenerationAttempt(admin, {
      operationId: input.generationIntentId,
    });
    expect(recovered).toMatchObject({
      status: "completed",
      assessment: { providerResponseId: "staged-provider-response" },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(input.generationIntentId)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("fails an expired unstaged claim as indeterminate and never dispatches again", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(
        structuredResponse(validAssessment(), "unpersisted-provider-response"),
      );
    let crashOnce = true;
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        now: () => generatedAt,
        beforeProviderResultPersisted: () => {
          if (crashOnce) {
            crashOnce = false;
            throw new Error("simulated Worker exit before provider staging");
          }
        },
      },
    );
    const input = generationInput();

    await expect(service.generate(admin, input)).rejects.toThrow(
      /simulated Worker exit/i,
    );
    await env.DB.prepare(
      "UPDATE operation_jobs SET claim_expires_at = 0 WHERE id = ?",
    )
      .bind(input.generationIntentId)
      .run();

    await expect(service.generate(admin, input)).rejects.toThrow(
      /outcome is indeterminate/i,
    );
    await expect(service.generate(admin, generationInput())).rejects.toThrow(
      /will not call the provider again/i,
    );
    expect(create).toHaveBeenCalledTimes(1);
    const failed = await env.DB.prepare(
      `SELECT status, claim_token AS claimToken,
              json_extract(result_json, '$.phase') AS phase,
              json_extract(result_json, '$.retrySafe') AS retrySafe
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(input.generationIntentId)
      .first<{
        status: string;
        claimToken: string | null;
        phase: string;
        retrySafe: number;
      }>();
    expect(failed).toEqual({
      status: "failed",
      claimToken: null,
      phase: "failed",
      retrySafe: 0,
    });
  });

  it("fails closed when the round changes during provider execution", async () => {
    let driftOnce = true;
    const create = vi.fn(async () => {
      if (driftOnce) {
        driftOnce = false;
        await env.DB.prepare(
          "UPDATE evaluation_rounds SET revision = revision + 1 WHERE id = ? AND event_id = ?",
        )
          .bind(ROUND_ID, admin.eventId)
          .run();
      }
      return structuredResponse(validAssessment());
    });
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const driftedInput = generationInput();

    await expect(service.generate(admin, driftedInput)).rejects.toBeInstanceOf(
      AiReviewAssessmentConflictError,
    );
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ai_review_assessments WHERE event_id = ?",
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
    await expect(service.generate(admin, driftedInput)).rejects.toBeInstanceOf(
      AiReviewAssessmentStateError,
    );
    expect(create).toHaveBeenCalledTimes(1);

    const retry = await service.generate(admin, generationInput());
    expect(retry).toMatchObject({
      roundRevision: 2,
      scorecardId: expect.any(String),
      score: 4.25,
    });
    expect(create).toHaveBeenCalledTimes(2);
    const operations = await env.DB.prepare(
      `SELECT status FROM operation_jobs
        WHERE event_id = ? AND type = 'ai.review_assessment.generate'
        ORDER BY created_at, id`,
    )
      .bind(admin.eventId)
      .all<{ status: string }>();
    expect(operations.results.map(({ status }) => status).sort()).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("does not save an assessment if the exact submitted snapshot changes during generation", async () => {
    const original = await env.DB.prepare(
      `SELECT submitted_snapshot_json AS snapshotJson
         FROM submissions WHERE id = ? AND event_id = ?`,
    )
      .bind(SUBMISSION_ID, admin.eventId)
      .first<{ snapshotJson: string }>();
    if (!original) throw new Error("AI test submission is unavailable.");
    const create = vi.fn(async () => {
      await env.DB.prepare(
        `UPDATE submissions
            SET submitted_snapshot_json = json_set(
              submitted_snapshot_json,
              '$.answers.session_overview',
              'Changed while the provider was running.'
            )
          WHERE id = ? AND event_id = ?`,
      )
        .bind(SUBMISSION_ID, admin.eventId)
        .run();
      return structuredResponse(validAssessment());
    });
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );

    try {
      await expect(
        service.generate(admin, generationInput()),
      ).rejects.toBeInstanceOf(AiReviewAssessmentConflictError);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM ai_review_assessments
            WHERE event_id = ? AND submission_id = ?`,
        )
          .bind(admin.eventId, SUBMISSION_ID)
          .first(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      await env.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
          WHERE id = ? AND event_id = ?`,
      )
        .bind(original.snapshotJson, SUBMISSION_ID, admin.eventId)
        .run();
    }
  });

  it("does not reserve or dispatch generation after repository authority changes", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        beforeGenerationReserved: async () => {
          await env.DB.prepare(
            "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
          )
            .bind(admin.eventId, admin.organisationId)
            .run();
        },
      },
    );

    await expect(
      service.generate(admin, generationInput()),
    ).rejects.toBeInstanceOf(AiReviewAssessmentStateError);
    expect(create).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM operation_jobs
          WHERE event_id = ? AND type = 'ai.review_assessment.generate'`,
      )
        .bind(admin.eventId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("does not reserve or dispatch generation after its loaded review cycle is replaced", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    let cycleId: string | null = null;
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        beforeGenerationReserved: async () => {
          const cycle = await new EvaluationService(
            env as unknown as CloudflareEnvironment,
          ).startReviewCycle(admin, {
            currentPlanId: "demo-evaluation-plan",
            currentPlanRevision: 1,
            expectedRunningAssessmentOperationCount: 0,
            expectedUnfinishedAssignmentCount: 2,
            expectedUnfinishedReviewCount: 0,
            planName: "Cycle-first reservation guard",
            round: {
              name: "Fresh review",
              opensAt: null,
              closesAt: null,
              anonymous: true,
              recommendationChoices: defaultRecommendationChoices(),
              criteria: [
                {
                  name: "Programme fit",
                  description: "Fit for the current programme.",
                  inputType: "scale_5",
                  options: [],
                  weightPercent: 100,
                  required: true,
                },
              ],
            },
            confirmed: true,
          });
          cycleId = cycle.planId;
        },
      },
    );
    const input = generationInput();

    try {
      await expect(service.generate(admin, input)).rejects.toThrow(
        /review cycle, rubric or proposal changed/i,
      );
      expect(create).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE id = ?",
        )
          .bind(input.generationIntentId)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
    } finally {
      if (cycleId) {
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM evaluation_plans WHERE id = ? AND event_id = ?",
          ).bind(cycleId, admin.eventId),
          env.DB.prepare(
            `UPDATE evaluation_plans
                SET status = 'active', revision = 1, updated_at = unixepoch()
              WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
          ).bind(admin.eventId),
          env.DB.prepare(
            `UPDATE evaluation_rounds
                SET status = 'active', revision = 1, updated_at = unixepoch()
              WHERE id = ? AND event_id = ?`,
          ).bind(ROUND_ID, admin.eventId),
        ]);
      }
    }
  });

  it("does not persist or complete a generation after repository authority changes in flight", async () => {
    const create = vi.fn(async () => {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
      )
        .bind(admin.eventId, admin.organisationId)
        .run();
      return structuredResponse(validAssessment(), "stale-d1-response");
    });
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const input = generationInput();

    await expect(service.generate(admin, input)).rejects.toBeInstanceOf(
      AiReviewAssessmentStateError,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ai_review_assessments WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT status, json_extract(result_json, '$.phase') AS phase
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(input.generationIntentId)
        .first<{ status: string; phase: string }>(),
    ).toEqual({ status: "failed", phase: "failed" });
  });

  it("does not save an override after repository authority changes in flight", async () => {
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(async () =>
          structuredResponse(validAssessment(), "override-race-response"),
        ),
        beforeOverridePersisted: async () => {
          await env.DB.prepare(
            "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
          )
            .bind(admin.eventId, admin.organisationId)
            .run();
        },
      },
    );
    const generated = await service.generate(admin, generationInput());

    await expect(
      service.override(admin, {
        assessmentId: generated.id,
        expectedRevision: generated.revision,
        score: 2.5,
        rationale:
          "An authority change during the request must prevent this stale D1 override.",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(AiReviewAssessmentStateError);
    expect(
      await env.DB.prepare(
        `SELECT override_score AS overrideScore, revision
           FROM ai_review_assessments WHERE id = ?`,
      )
        .bind(generated.id)
        .first<{ overrideScore: number | null; revision: number }>(),
    ).toEqual({ overrideScore: null, revision: generated.revision });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'ai.review_assessment.overridden'
            AND entity_id = ?`,
      )
        .bind(admin.eventId, generated.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("rejects reads, generation and overrides when Airtable is authoritative", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(
        structuredResponse(validAssessment(), "airtable-boundary-response"),
      );
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    const generated = await service.generate(admin, generationInput());
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(admin.eventId, admin.organisationId)
      .run();

    await expect(service.listForEvent(admin)).rejects.toBeInstanceOf(
      AiReviewAssessmentStateError,
    );
    await expect(
      service.generate(admin, generationInput()),
    ).rejects.toBeInstanceOf(AiReviewAssessmentStateError);
    await expect(
      service.override(admin, {
        assessmentId: generated.id,
        expectedRevision: generated.revision,
        score: 3,
        rationale:
          "A direct mutation cannot bypass the authoritative Airtable boundary.",
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(AiReviewAssessmentStateError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("requires administrator authority and an explicitly configured provider", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const injected = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      { provider: workersAiProvider(create) },
    );
    await expect(
      injected.generate(evaluator, generationInput()),
    ).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();

    const local = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      local.generate(admin, generationInput()),
    ).rejects.toBeInstanceOf(AiConfigurationError);

    const operations = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM operation_jobs
        WHERE event_id = ? AND type = 'ai.review_assessment.generate'`,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(operations?.count).toBe(0);
  });

  // This irreversible tombstone test intentionally runs last in this isolated
  // Worker suite. Production retention completion is immutable by design.
  it("does not reserve or dispatch generation after participant retention completes", async () => {
    const create = vi
      .fn<(request: OpenAiResponsesRequest) => Promise<OpenAiResponse>>()
      .mockResolvedValue(structuredResponse(validAssessment()));
    const service = new AiReviewAssessmentService(
      env as unknown as CloudflareEnvironment,
      {
        provider: workersAiProvider(create),
        beforeGenerationReserved: async () => {
          await env.DB.prepare(
            `UPDATE events SET participant_retention_completed_at = unixepoch()
              WHERE id = ? AND organisation_id = ?`,
          )
            .bind(admin.eventId, admin.organisationId)
            .run();
        },
      },
    );
    const input = generationInput();

    await expect(service.generate(admin, input)).rejects.toThrow(
      /participant retention has completed/i,
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE id = ?",
      )
        .bind(input.generationIntentId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});

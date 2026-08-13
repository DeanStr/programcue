import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentService,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment.server";
import {
  AiConfigurationError,
  AiProviderError,
  type AiModelProvider,
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

const ROUND_ID = "demo-evaluation-round";
const SUBMISSION_ID = "demo-evaluation-submission-calm";
const generatedAt = new Date("2026-08-13T12:00:00Z");

function structuredResponse(
  value: unknown,
  id = `workers-ai-response-${crypto.randomUUID()}`,
): OpenAiResponse {
  return {
    id,
    model: "@cf/openai/gpt-oss-120b",
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
    model: "@cf/openai/gpt-oss-120b",
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
    ).rejects.toThrow(/confirm the human AI-score override/i);
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
      effectiveScore: 4.25,
      overridden: false,
      provider: "workers_ai",
      providerLabel: "Workers AI",
      model: "@cf/openai/gpt-oss-120b",
      providerResponseId: "response-1",
      revision: 1,
    });
    expect(assessment.rationale).toContain("run-of-show");

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0];
    expect(request.textFormat?.name).toBe("program_cue_ai_review_assessment");
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain("fragmented run-of-show decisions");
    expect(request.input).not.toContain("Alex Morgan");
    expect(request.input).not.toContain("alex.submitter@example.com");
    expect(request.input).toContain('"blinded":true');

    const persisted = await env.DB.prepare(
      `SELECT score, rationale, provider, model,
              provider_response_id AS responseId,
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
        overrideScore: number | null;
        revision: number;
      }>();
    expect(persisted).toEqual({
      score: 4.25,
      rationale: validAssessment().rationale,
      provider: "workers_ai",
      model: "@cf/openai/gpt-oss-120b",
      responseId: "response-1",
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
      `SELECT action FROM audit_events
        WHERE event_id = ? AND correlation_id = (
          SELECT correlation_id FROM operation_jobs
           WHERE id = (SELECT last_operation_id
                         FROM ai_review_assessments WHERE id = ?)
        ) ORDER BY action`,
    )
      .bind(admin.eventId, assessment.id)
      .all<{ action: string }>();
    expect(actions.results.map(({ action }) => action)).toEqual([
      "ai.review_assessment.generated",
      "ai.review_assessment.requested",
    ]);
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
      effectiveScore: 3.5,
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
        effectiveScore: 3.5,
      }),
    ]);

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

    const recovered = await service.generate(admin, input);
    expect(recovered.providerResponseId).toBe("staged-provider-response");
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

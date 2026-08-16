import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "./evaluation-admin";
import { action as reviewWorkbenchAction } from "./review-workbench";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(origin: string) {
  return new Request("http://localhost/admin/review", {
    method: "POST",
    headers: {
      cookie:
        "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
      origin,
    },
    body: new URLSearchParams({ intent: "unsupported" }),
  });
}

function loaderRequest(search = "") {
  return new Request(`http://localhost/admin/review${search}`, {
    headers: {
      cookie:
        "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
    },
  });
}

function actionRequest(body: URLSearchParams) {
  return new Request("http://localhost/admin/review", {
    method: "POST",
    headers: {
      cookie:
        "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
      origin: "http://localhost",
    },
    body,
  });
}

function reviewWorkbenchRequest(origin: string) {
  return new Request("http://localhost/review/workbench", {
    method: "POST",
    headers: {
      cookie:
        "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
      origin,
    },
    body: new URLSearchParams({
      intent: "add-discussion-message",
      roundId: "demo-evaluation-round",
      targetType: "submission",
      targetId: "demo-evaluation-submission-calm",
      body: "A forged committee message.",
      idempotencyKey: crypto.randomUUID(),
    }),
  });
}

beforeEach(async () => {
  await ensureDemoEvaluationData(workerEnv);
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      "DELETE FROM event_changes WHERE event_id = 'evt-foe-2025' AND entity_type = 'evaluation_discussion_message'",
    ),
    workerEnv.DB.prepare(
      "DELETE FROM evaluation_discussion_messages WHERE event_id = 'evt-foe-2025'",
    ),
    workerEnv.DB.prepare(
      `DELETE FROM reviews
        WHERE assignment_id IN (
          'demo-evaluation-assignment-1', 'demo-evaluation-assignment-2'
        )`,
    ),
    workerEnv.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'assigned', submitted_at = NULL
        WHERE id IN (
          'demo-evaluation-assignment-1', 'demo-evaluation-assignment-2'
        )`,
    ),
    workerEnv.DB.prepare(
      "DELETE FROM reviews WHERE id = 'evaluation-admin-session-review'",
    ),
    workerEnv.DB.prepare(
      "DELETE FROM evaluator_assignments WHERE id = 'evaluation-admin-session-assignment'",
    ),
    workerEnv.DB.prepare(
      "DELETE FROM evaluator_assignments WHERE id LIKE 'evaluation-admin-filter-session-%'",
    ),
    workerEnv.DB.prepare(
      "DELETE FROM sessions WHERE id = 'evaluation-admin-session-target' AND event_id = 'evt-foe-2025'",
    ),
    workerEnv.DB.prepare(
      "DELETE FROM sessions WHERE id LIKE 'evaluation-admin-filter-session-%' AND event_id = 'evt-foe-2025'",
    ),
  ]);
});

describe("evaluation administration results", () => {
  it("projects the latest decision draft back into the decision editor", async () => {
    await expect(
      action({
        request: actionRequest(
          new URLSearchParams({
            intent: "decide",
            submissionId: "demo-evaluation-submission-calm",
            decision: "rejected",
            rationale: "Retain this exact draft rationale.",
            includeReviewerFeedback: "false",
            release: "false",
            sessionDurationMinutes: "75",
          }),
        ),
        params: {},
        context: context(),
      } as never),
    ).resolves.toMatchObject({
      data: {
        committed: true,
      },
      init: { status: 207 },
    });

    const result = await loader({
      request: loaderRequest(),
      params: {},
      context: context(),
    } as never);
    expect(
      result.submissions.find(
        (submission) => submission.id === "demo-evaluation-submission-calm",
      )?.decisionDraft,
    ).toMatchObject({
      revisionNumber: 1,
      decision: "rejected",
      rationale: "Retain this exact draft rationale.",
      includeReviewerFeedback: false,
      sessionTrackId: null,
      sessionDurationMinutes: 75,
    });
  });

  it("rejects a decision draft whose persisted effect preview is incomplete", async () => {
    await action({
      request: actionRequest(
        new URLSearchParams({
          intent: "decide",
          submissionId: "demo-evaluation-submission-calm",
          decision: "rejected",
          rationale: "Do not infer missing persisted fields.",
          includeReviewerFeedback: "false",
          release: "false",
          sessionDurationMinutes: "75",
        }),
      ),
      params: {},
      context: context(),
    } as never);
    await workerEnv.DB.prepare(
      `UPDATE submission_decisions SET effect_preview_json = '{}'
        WHERE event_id = 'evt-foe-2025'
          AND submission_id = 'demo-evaluation-submission-calm'
          AND status = 'draft'`,
    ).run();

    try {
      await expect(
        loader({
          request: loaderRequest(),
          params: {},
          context: context(),
        } as never),
      ).rejects.toThrow(
        "Decision draft demo-evaluation-submission-calm has invalid persisted preview data.",
      );
    } finally {
      await workerEnv.DB.prepare(
        `DELETE FROM submission_decisions
          WHERE event_id = 'evt-foe-2025'
            AND submission_id = 'demo-evaluation-submission-calm'
            AND status = 'draft'`,
      ).run();
    }
  });

  it("persists a discussion post without adding realtime chat semantics", async () => {
    const result = await action({
      request: actionRequest(
        new URLSearchParams({
          intent: "add-discussion-message",
          roundId: "demo-evaluation-round",
          targetType: "submission",
          targetId: "demo-evaluation-submission-calm",
          body: "A durable committee note without a realtime broadcast.",
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
      params: {},
      context: context(),
    } as never);
    expect(result).toMatchObject({
      ok: true,
      message: "Discussion message added.",
    });
    await expect(
      workerEnv.DB.prepare(
        `SELECT body FROM evaluation_discussion_messages
          WHERE event_id = 'evt-foe-2025'`,
      ).first(),
    ).resolves.toEqual({
      body: "A durable committee note without a realtime broadcast.",
    });
    await expect(
      workerEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM event_changes
          WHERE event_id = 'evt-foe-2025'
            AND entity_type = 'evaluation_discussion_message'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("aggregates active submission reviews and excludes recused assignments", async () => {
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'demo-evaluation-assignment-1'`,
      ),
      workerEnv.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'recused'
          WHERE id = 'demo-evaluation-assignment-2'`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, revision, created_at, updated_at, submitted_at
         ) VALUES (
           'evaluation-admin-loader-review', 'evt-foe-2025',
           'demo-evaluation-assignment-1', 'submitted', '{}', 3.5, 'accept',
           1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ),
    ]);

    const result = await loader({
      request: loaderRequest(),
      params: {},
      context: context(),
    } as never);
    const reviewed = result.submissions.find(
      (submission) => submission.id === "demo-evaluation-submission-calm",
    );
    const recused = result.submissions.find(
      (submission) => submission.id === "demo-evaluation-submission-inclusive",
    );

    expect(reviewed).toMatchObject({
      assignmentCount: 1,
      completedReviewCount: 1,
      averageScore: 3.5,
    });
    expect(recused).toMatchObject({
      assignmentCount: 0,
      completedReviewCount: 0,
      averageScore: null,
    });
  });

  it("keeps incomplete review coverage separate from unassigned targets", async () => {
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'demo-evaluation-assignment-1'`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, revision, created_at, updated_at, submitted_at
         ) VALUES (
           'evaluation-admin-loader-review', 'evt-foe-2025',
           'demo-evaluation-assignment-1', 'submitted', '{}', 3.5, 'accept',
           1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, visibility, revision, created_at, updated_at
         ) VALUES
           ('evaluation-admin-filter-session-incomplete', 'evt-foe-2025',
            'Incomplete session', 'evaluation-admin-filter-session-incomplete',
            '', 'presentation', 45, 'unscheduled', 'public', 1,
            unixepoch(), unixepoch()),
           ('evaluation-admin-filter-session-unassigned', 'evt-foe-2025',
            'Unassigned session', 'evaluation-admin-filter-session-unassigned',
            '', 'presentation', 45, 'unscheduled', 'public', 1,
            unixepoch(), unixepoch())`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, assigned_at
         ) VALUES (
           'evaluation-admin-filter-session-assignment', 'evt-foe-2025',
           'demo-evaluation-round',
           'evaluation-admin-filter-session-incomplete', '{}',
           'person-demo-evaluator', 'assigned', unixepoch()
         )`,
      ),
    ]);

    const incomplete = await loader({
      request: loaderRequest("?filter=incomplete"),
      params: {},
      context: context(),
    } as never);
    expect(incomplete).toMatchObject({
      reviewFilter: "incomplete",
      incompleteOnly: true,
      unassignedOnly: false,
    });
    expect(incomplete.submissions.map((submission) => submission.id)).toEqual([
      "demo-evaluation-submission-inclusive",
    ]);
    expect(incomplete.sessions).toEqual([
      expect.objectContaining({
        id: "evaluation-admin-filter-session-incomplete",
        assignmentCount: 1,
        completedReviewCount: 0,
      }),
    ]);
    expect(incomplete.results).toHaveLength(2);
    expect(incomplete.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "evaluation-admin-filter-session-incomplete",
        }),
        expect.objectContaining({
          id: "demo-evaluation-submission-inclusive",
          assignmentCount: 1,
          completedReviewCount: 0,
        }),
      ]),
    );
    expect(incomplete.sessions.map((session) => session.id)).not.toContain(
      "evaluation-admin-filter-session-unassigned",
    );

    const unassigned = await loader({
      request: loaderRequest("?filter=unassigned"),
      params: {},
      context: context(),
    } as never);
    expect(
      unassigned.results.some(
        (target) =>
          target.id === "demo-evaluation-submission-inclusive" ||
          target.id === "demo-evaluation-submission-calm",
      ),
    ).toBe(false);
    expect(unassigned.sessions.map((session) => session.id)).toContain(
      "evaluation-admin-filter-session-unassigned",
    );
    expect(unassigned.sessions.map((session) => session.id)).not.toContain(
      "evaluation-admin-filter-session-incomplete",
    );

    await expect(
      loader({
        request: loaderRequest("?filter=unknown"),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("sorts proposals and sessions together within the selected results round", async () => {
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, visibility, revision, created_at, updated_at
         ) VALUES (
           'evaluation-admin-session-target', 'evt-foe-2025',
           'AI in Event Operations', 'evaluation-admin-session-target', '',
           'presentation', 45, 'unscheduled', 'public', 1,
           unixepoch(), unixepoch()
         )`,
      ),
      workerEnv.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'demo-evaluation-assignment-1'`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, revision, created_at, updated_at, submitted_at
         ) VALUES (
           'evaluation-admin-loader-review', 'evt-foe-2025',
           'demo-evaluation-assignment-1', 'submitted', '{}', 3.5, 'accept',
           1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, revision, assigned_at, submitted_at
         ) VALUES (
           'evaluation-admin-session-assignment', 'evt-foe-2025',
           'demo-evaluation-round', 'evaluation-admin-session-target', '{}',
           'person-demo-evaluator', 'submitted', 1, unixepoch(), unixepoch()
         )`,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, weighted_score,
           recommendation, revision, created_at, updated_at, submitted_at
         ) VALUES (
           'evaluation-admin-session-review', 'evt-foe-2025',
           'evaluation-admin-session-assignment', 'submitted', '{}', 4.75,
           'accept', 1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ),
    ]);

    const result = await loader({
      request: loaderRequest("?sort=score_desc"),
      params: {},
      context: context(),
    } as never);

    expect(result.results.slice(0, 2)).toMatchObject([
      {
        targetType: "session",
        title: "AI in Event Operations",
        averageScore: 4.75,
      },
      {
        targetType: "proposal",
        id: "demo-evaluation-submission-calm",
        averageScore: 3.5,
      },
    ]);
    expect(
      result.sessions.find(
        (candidate) => candidate.id === "evaluation-admin-session-target",
      ),
    ).toMatchObject({
      assignmentCount: 1,
      completedReviewCount: 1,
      averageScore: 4.75,
    });
  });

  it("accepts an event-scoped submission focus and rejects an unknown one", async () => {
    await workerEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, description, format, duration_minutes,
         status, visibility, revision, created_at, updated_at
       ) VALUES (
         'evaluation-admin-session-target', 'evt-foe-2025',
         'AI in Event Operations', 'evaluation-admin-session-target', '',
         'presentation', 45, 'unscheduled', 'public', 1,
         unixepoch(), unixepoch()
       )`,
    ).run();
    const focused = await loader({
      request: loaderRequest("?submission=demo-evaluation-submission-calm"),
      params: {},
      context: context(),
    } as never);
    expect(focused.focusedSubmissionId).toBe("demo-evaluation-submission-calm");
    expect(focused.reviewDiscussionTitle).toEqual(expect.any(String));

    const focusedSession = await loader({
      request: loaderRequest("?session=evaluation-admin-session-target"),
      params: {},
      context: context(),
    } as never);
    expect(focusedSession.focusedSessionId).toBe(
      "evaluation-admin-session-target",
    );
    expect(focusedSession.reviewDiscussionTitle).toBe("AI in Event Operations");

    await expect(
      loader({
        request: loaderRequest(
          "?submission=demo-evaluation-submission-calm&session=evaluation-admin-session-target",
        ),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      loader({
        request: loaderRequest("?submission=another-event-submission"),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a submission focus when Review has no evaluation plan", async () => {
    const plans = await workerEnv.DB.prepare(
      `SELECT id, status FROM evaluation_plans
        WHERE event_id = 'evt-foe-2025' AND status <> 'archived'`,
    ).all<{ id: string; status: string }>();
    await workerEnv.DB.prepare(
      `UPDATE evaluation_plans SET status = 'archived'
        WHERE event_id = 'evt-foe-2025' AND status <> 'archived'`,
    ).run();
    try {
      await expect(
        loader({
          request: loaderRequest("?submission=demo-evaluation-submission-calm"),
          params: {},
          context: context(),
        } as never),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await workerEnv.DB.batch(
        plans.results.map((plan) =>
          workerEnv.DB.prepare(
            "UPDATE evaluation_plans SET status = ? WHERE id = ? AND event_id = 'evt-foe-2025'",
          ).bind(plan.status, plan.id),
        ),
      );
    }
  });
});

describe("evaluation administration mutation origin", () => {
  it("rejects cross-origin browser mutations before dispatch", async () => {
    const response = await action({
      request: request("https://attacker.invalid"),
      params: {},
      context: context(),
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    await expect((response as Response).text()).resolves.toBe(
      "A same-origin request is required.",
    );
  });

  it("allows same-origin requests to reach normal action dispatch", async () => {
    const response = await action({
      request: request("http://localhost"),
      params: {},
      context: context(),
    } as never);

    expect(response).toMatchObject({ init: { status: 400 } });
  });

  it("rejects unconfirmed AI generation before provider resolution or durable work", async () => {
    const generationIntentId = crypto.randomUUID();
    await expect(
      action({
        request: actionRequest(
          new URLSearchParams({
            intent: "generate-ai-review-assessment",
            generationIntentId,
            roundId: "demo-evaluation-round",
            submissionId: "demo-evaluation-submission-calm",
          }),
        ),
        params: {},
        context: context(),
      } as never),
    ).resolves.toMatchObject({ init: { status: 422 } });
    expect(
      await workerEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE id = ?",
      )
        .bind(generationIntentId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});

describe("review workbench mutation origin", () => {
  it("rejects cross-origin discussion posts before dispatch", async () => {
    const response = await reviewWorkbenchAction({
      request: reviewWorkbenchRequest("https://attacker.invalid"),
      params: {},
      context: context(),
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    await expect((response as Response).text()).resolves.toBe(
      "A same-origin request is required.",
    );
    await expect(
      workerEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM evaluation_discussion_messages
          WHERE event_id = 'evt-foe-2025'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });
});

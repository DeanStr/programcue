import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "./evaluation-admin";

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

function loaderRequest() {
  return new Request("http://localhost/admin/review", {
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

beforeEach(async () => {
  await ensureDemoEvaluationData(workerEnv);
  await workerEnv.DB.batch([
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
  ]);
});

describe("evaluation administration results", () => {
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

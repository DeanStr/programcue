import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EvaluationService,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  action as adminResourceAction,
  loader as adminResourceLoader,
  readResourceAttachmentCompletion,
} from "./admin-resources";
import { loader as applicationLoader } from "./application-form";
import { loader as communicationsLoader } from "./communications-centre";
import {
  canReleaseEvaluationDecisions,
  decisionActionOutcome,
} from "./evaluation-admin";
import {
  action as formBuilderAction,
  loader as formBuilderLoader,
} from "./form-builder-preview";
import {
  action as reviewAction,
  reviewCanAdoptServerPayload,
  loader as reviewLoader,
  reviewSaveCoversCurrentEdits,
} from "./review-workbench";

const ADMIN_COOKIE =
  "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025";

function context() {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

function formRequest(url: string, values: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: ADMIN_COOKIE,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams(values),
  });
}

function responseStatus(result: unknown) {
  if (result instanceof Response) return result.status;
  return (result as { init?: ResponseInit }).init?.status ?? 200;
}

beforeEach(async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
  await ensureDemoEvaluationData(testEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frontend route fail-fast boundaries", () => {
  it("reports a committed resource attachment as saved when realtime delivery degrades", async () => {
    await expect(
      readResourceAttachmentCompletion(
        Response.json(
          {
            ok: false,
            committed: true,
            message:
              "Attachment saved, but realtime invalidation needs an Operations retry.",
          },
          { status: 207 },
        ),
      ),
    ).resolves.toEqual({
      message:
        "Attachment saved, but realtime invalidation needs an Operations retry.",
    });
  });

  it("keeps newer review edits recoverable when an older autosave finishes", () => {
    const savedEditGeneration = 1;
    const newerEditGeneration = 2;
    const previouslySyncedGeneration = 0;

    expect(
      reviewSaveCoversCurrentEdits(savedEditGeneration, newerEditGeneration),
    ).toBe(false);
    expect(
      reviewCanAdoptServerPayload(
        newerEditGeneration,
        previouslySyncedGeneration,
      ),
    ).toBe(false);

    expect(
      reviewSaveCoversCurrentEdits(newerEditGeneration, newerEditGeneration),
    ).toBe(true);
    expect(
      reviewCanAdoptServerPayload(newerEditGeneration, newerEditGeneration),
    ).toBe(true);
  });

  it("shows committee-chair release only for an active plan grant", () => {
    expect(
      canReleaseEvaluationDecisions("committee_chair", {
        status: "draft",
        decisionRole: "committee_chair",
      }),
    ).toBe(false);
    expect(
      canReleaseEvaluationDecisions("committee_chair", {
        status: "closed",
        decisionRole: "committee_chair",
      }),
    ).toBe(false);
    expect(
      canReleaseEvaluationDecisions("committee_chair", {
        status: "active",
        decisionRole: "committee_chair",
      }),
    ).toBe(true);
  });

  it("reports queue and realtime failures together after a decision commits", () => {
    const outcome = decisionActionOutcome("queue_failed", true, {
      ok: false,
      committed: true,
      entityId: "decision-test",
      message:
        "Your change was saved, but other open views could not be updated automatically. Refresh them before continuing.",
    });

    expect(outcome).toEqual({
      partial: true,
      message:
        "Decision released. Its notification is saved but needs a queue retry. Your change was saved, but other open views could not be updated automatically. Refresh them before continuing.",
    });
  });

  it("reports local SBEK activation failures after a decision commits", () => {
    const outcome = decisionActionOutcome(
      "queued",
      true,
      null,
      null,
      "demo_activation_failed",
      1,
    );

    expect(outcome.partial).toBe(true);
    expect(outcome.message).toMatch(/decision was committed/i);
    expect(outcome.message).toMatch(/could not be activated/i);
    expect(outcome.message).toMatch(/no email was sent/i);
  });

  it("rejects explicit unknown record selectors", async () => {
    const missing = `missing-${crypto.randomUUID()}`;
    const testContext = context();

    await expect(
      formBuilderLoader({
        request: new Request(
          `http://localhost/admin/submissions/form?form=${missing}`,
          { headers: { cookie: ADMIN_COOKIE } },
        ),
        params: {},
        context: testContext,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adminResourceLoader({
        request: new Request(
          `http://localhost/admin/resources?resource=${missing}`,
          { headers: { cookie: ADMIN_COOKIE } },
        ),
        params: {},
        context: testContext,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      communicationsLoader({
        request: new Request(
          `http://localhost/admin/communications?template=${missing}`,
          { headers: { cookie: ADMIN_COOKIE } },
        ),
        params: {},
        context: testContext,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reviewLoader({
        request: new Request(
          `http://localhost/review/workbench?assignment=${missing}`,
          { headers: { cookie: ADMIN_COOKIE } },
        ),
        params: {},
        context: testContext,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("does not turn arbitrary query parameters into success notices", async () => {
    const application = await applicationLoader({
      request: new Request(
        "http://localhost/apply/form?submitted=1&saved=1&created=1&confirmation=queued",
        { headers: { cookie: ADMIN_COOKIE } },
      ),
      params: { slug: "form" },
      context: context(),
    } as never);
    if (application instanceof Response || "data" in application) {
      throw new Error(
        "The demo application form unexpectedly returned a response wrapper.",
      );
    }
    expect(application.notice).toBe("");

    const communications = await communicationsLoader({
      request: new Request(
        "http://localhost/admin/communications?saved=999999",
        { headers: { cookie: ADMIN_COOKIE } },
      ),
      params: {},
      context: context(),
    } as never);
    expect(communications.notice).toBe("");
  });

  it("rejects missing or unknown mutation intents", async () => {
    const testContext = context();
    const results = await Promise.all([
      formBuilderAction({
        request: formRequest("http://localhost/admin/submissions/form", {}),
        params: {},
        context: testContext,
      } as never),
      adminResourceAction({
        request: formRequest("http://localhost/admin/resources", {
          intent: "unexpected",
        }),
        params: {},
        context: testContext,
      } as never),
      reviewAction({
        request: formRequest("http://localhost/review/workbench", {
          intent: "unexpected",
        }),
        params: {},
        context: testContext,
      } as never),
    ]);

    expect(results.map(responseStatus)).toEqual([400, 400, 400]);
  });

  it("rejects a form save before the browser editor is ready", async () => {
    const save = vi.spyOn(SubmissionService.prototype, "saveForm");
    const result = await formBuilderAction({
      request: formRequest("http://localhost/admin/submissions/form", {
        _intent: "save",
        schema: "{}",
        routing: "{}",
      }),
      params: {},
      context: context(),
    } as never);

    expect(responseStatus(result)).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("rethrows unexpected service failures instead of labelling them validation errors", async () => {
    const formFailure = new Error("synthetic form database failure");
    vi.spyOn(SubmissionService.prototype, "saveForm").mockRejectedValueOnce(
      formFailure,
    );
    await expect(
      formBuilderAction({
        request: formRequest("http://localhost/admin/submissions/form", {
          _intent: "save",
          _clientReady: "1",
          schema: "{}",
          routing: "{}",
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toBe(formFailure);

    const resourceFailure = new Error("synthetic resource database failure");
    vi.spyOn(ResourceService.prototype, "save").mockRejectedValueOnce(
      resourceFailure,
    );
    await expect(
      adminResourceAction({
        request: formRequest("http://localhost/admin/resources", {
          intent: "save",
          documentJson: "{}",
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toBe(resourceFailure);

    const reviewFailure = new Error("synthetic review database failure");
    vi.spyOn(EvaluationService.prototype, "saveReview").mockRejectedValueOnce(
      reviewFailure,
    );
    await expect(
      reviewAction({
        request: formRequest("http://localhost/review/workbench", {
          intent: "save",
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toBe(reviewFailure);
  });

  it("returns a validation response for an incomplete submitted rubric", async () => {
    vi.spyOn(EvaluationService.prototype, "saveReview").mockRejectedValueOnce(
      new EvaluationValidationError(
        "Score every criterion before submitting the review.",
      ),
    );
    const result = await reviewAction({
      request: formRequest("http://localhost/review/workbench", {
        intent: "submit",
      }),
      params: {},
      context: context(),
    } as never);

    expect(responseStatus(result)).toBe(422);
    expect(result).toMatchObject({
      data: {
        ok: false,
        error: "Score every criterion before submitting the review.",
      },
    });
  });
});

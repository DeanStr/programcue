import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import { resetProductionEvaluationFixture } from "~/platform/evaluation/evaluation-fixture.server";
import {
  acquireEvaluationFixtureReset,
  markEvaluationFixtureResetFailed,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { action } from "./ai-context-action";

function productionEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
    BETTER_AUTH_SECRET:
      "evaluation-route-better-auth-secret-with-thirty-two-characters",
    BETTER_AUTH_URL: "https://app.programcue.com",
    AUTH_EMAIL_FROM: "Program Cue <auth@programcue.com>",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-resend-key",
    AI: {} as Ai,
    EVALUATOR_ORGANIZER_EMAIL: "eval-organizer@programcue.com",
    EVALUATOR_SPEAKER_EMAIL: "eval-speaker@programcue.com",
    EVALUATOR_SECOND_SPEAKER_EMAIL: "eval-speaker-2@programcue.com",
    EVALUATOR_REVIEWER_EMAIL: "eval-reviewer@programcue.com",
    EVALUATOR_SHOWCASE_SUBMITTER_EMAIL:
      "eval-showcase-submitter@programcue.com",
    EVALUATOR_SHOWCASE_SPEAKER_EMAIL: "eval-showcase-speaker@programcue.com",
  } as CloudflareEnvironment;
}

function context(environment: CloudflareEnvironment) {
  const routerContext = new RouterContextProvider();
  routerContext.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
}

describe("contextual AI action", () => {
  it("returns an explicit conflict while the evaluation fixture is resetting", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      {
        list: async () => [
          {
            id: "resend-domain-programcue",
            name: "programcue.com",
            status: "verified",
          },
        ],
      },
    );
    const sessionToken = `context-reset-${crypto.randomUUID()}`;
    await environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, person_id, token, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        SBEK_FIXTURE_PEOPLE.organizer.personId,
        sessionToken,
      )
      .run();
    const authCookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      sessionToken,
      String(environment.BETTER_AUTH_SECRET),
    );
    const eventCookie = currentEventCookie(DEMO_EVENT_ID, environment).split(
      ";",
      1,
    )[0]!;
    const cookie = `${authCookie}; ${eventCookie}`;
    const ownerToken = crypto.randomUUID();
    await acquireEvaluationFixtureReset(environment, ownerToken);

    try {
      const response = await action({
        request: new Request("https://app.programcue.com/actions/ai/context", {
          method: "POST",
          headers: {
            cookie,
            origin: "https://app.programcue.com",
          },
          body: new URLSearchParams({ kind: "readiness_summary" }),
        }),
        params: {},
        context: context(environment),
      } as never);
      expect(response).toMatchObject({
        data: {
          ok: false,
          error:
            "The event assistant is unavailable while the evaluation fixture is resetting. Try again after the reset finishes.",
        },
        init: { status: 409 },
      });
    } finally {
      await markEvaluationFixtureResetFailed(
        environment,
        ownerToken,
        new Error("Contextual route conflict test completed."),
      );
    }
  });
});

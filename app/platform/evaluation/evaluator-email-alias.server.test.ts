import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  EVALUATOR_EMAIL_ALIASES,
  EvaluatorEmailAliasContextError,
  EvaluatorEmailAliasDriftError,
  resolveEvaluatorEmailAlias,
} from "./evaluator-email-alias.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const routeableAddresses = {
  [SBEK_FIXTURE_PEOPLE.organizer.personId]:
    "evaluation-organizer@programcue.dev",
  [SBEK_FIXTURE_PEOPLE.speaker.personId]: "evaluation-speaker@programcue.dev",
  [SBEK_FIXTURE_PEOPLE.speaker2.personId]:
    "evaluation-speaker-2@programcue.dev",
  [SBEK_FIXTURE_PEOPLE.reviewer.personId]: "evaluation-reviewer@programcue.dev",
} as const;

const evaluator: Viewer = {
  personId: SBEK_FIXTURE_PEOPLE.organizer.personId,
  name: SBEK_FIXTURE_PEOPLE.organizer.name,
  email: routeableAddresses[SBEK_FIXTURE_PEOPLE.organizer.personId],
  role: "administrator",
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  demo: false,
  evaluation: true,
};

function productionEnvironment(evaluationMode: "true" | "false") {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: evaluationMode,
  } as unknown as CloudflareEnvironment;
}

beforeEach(async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await testEnv.DB.batch(
    Object.entries(routeableAddresses).map(([personId, email]) =>
      testEnv.DB.prepare(
        "UPDATE people SET email = ?, updated_at = unixepoch() WHERE id = ?",
      ).bind(email, personId),
    ),
  );
});

describe("production evaluator email aliases", () => {
  it("routes exactly the four published aliases to their fixed current identities", async () => {
    for (const [enteredEmail, personId] of Object.entries(
      EVALUATOR_EMAIL_ALIASES,
    )) {
      await expect(
        resolveEvaluatorEmailAlias(
          productionEnvironment("true"),
          evaluator,
          enteredEmail,
        ),
      ).resolves.toEqual({
        email: routeableAddresses[personId],
        personId,
        routing: {
          enteredEmail,
          routedEmail: routeableAddresses[personId],
          personId,
        },
      });
    }
  });

  it("leaves lookalikes and non-production fixtures untouched but fails exact aliases closed in ordinary production", async () => {
    const dana = "dana.speaker@sbek-test.example.com";
    await expect(
      resolveEvaluatorEmailAlias(
        productionEnvironment("true"),
        evaluator,
        dana,
      ),
    ).resolves.toEqual({ email: dana, personId: null, routing: null });
    await expect(
      resolveEvaluatorEmailAlias(
        productionEnvironment("false"),
        evaluator,
        "marcus.speaker@sbek-test.example.com",
      ),
    ).rejects.toBeInstanceOf(EvaluatorEmailAliasContextError);
    await expect(
      resolveEvaluatorEmailAlias(
        productionEnvironment("true"),
        { ...evaluator, evaluation: false },
        "marcus.speaker@sbek-test.example.com",
      ),
    ).rejects.toBeInstanceOf(EvaluatorEmailAliasContextError);
    await expect(
      resolveEvaluatorEmailAlias(
        env as unknown as CloudflareEnvironment,
        { ...evaluator, evaluation: false },
        "marcus.speaker@sbek-test.example.com",
      ),
    ).resolves.toEqual({
      email: "marcus.speaker@sbek-test.example.com",
      personId: null,
      routing: null,
    });
  });

  it("fails before routing when any fixed evaluator address has drifted unsafe", async () => {
    await (env as unknown as CloudflareEnvironment).DB.prepare(
      "UPDATE people SET email = ? WHERE id = ?",
    )
      .bind("sbek-reviewer@example.com", SBEK_FIXTURE_PEOPLE.reviewer.personId)
      .run();

    await expect(
      resolveEvaluatorEmailAlias(
        productionEnvironment("true"),
        evaluator,
        "marcus.speaker@sbek-test.example.com",
      ),
    ).rejects.toBeInstanceOf(EvaluatorEmailAliasDriftError);
  });

  it("fails closed when an alias target is linked to another organisation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organisations (id, name, slug)
         VALUES ('evaluation-alias-outside-org', 'Outside organisation',
                 'evaluation-alias-outside-org')`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, person_id, role, accepted_at
         ) VALUES ('evaluation-alias-outside-membership',
                   'evaluation-alias-outside-org', ?, 'owner', unixepoch())`,
      ).bind(SBEK_FIXTURE_PEOPLE.speaker.personId),
    ]);

    try {
      await expect(
        resolveEvaluatorEmailAlias(
          productionEnvironment("true"),
          evaluator,
          "priya.speaker@sbek-test.example.com",
        ),
      ).rejects.toBeInstanceOf(EvaluatorEmailAliasDriftError);
    } finally {
      await testEnv.DB.prepare(
        "DELETE FROM organisations WHERE id = 'evaluation-alias-outside-org'",
      ).run();
    }
  });

  it("allows alias routing from another active event in the fixture organisation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         file_policy_json, activation_status
       ) SELECT 'evaluation-alias-extra-event', organisation_id,
                'Evaluation alias extra event', 'evaluation-alias-extra-event',
                timezone, starts_at + 31536000, ends_at + 31536000,
                file_policy_json, 'active'
           FROM events WHERE id = ?`,
    )
      .bind(DEMO_EVENT_ID)
      .run();

    await expect(
      resolveEvaluatorEmailAlias(
        productionEnvironment("true"),
        { ...evaluator, eventId: "evaluation-alias-extra-event" },
        "marcus.speaker@sbek-test.example.com",
      ),
    ).resolves.toEqual({
      email: routeableAddresses[SBEK_FIXTURE_PEOPLE.speaker2.personId],
      personId: SBEK_FIXTURE_PEOPLE.speaker2.personId,
      routing: {
        enteredEmail: "marcus.speaker@sbek-test.example.com",
        routedEmail: routeableAddresses[SBEK_FIXTURE_PEOPLE.speaker2.personId],
        personId: SBEK_FIXTURE_PEOPLE.speaker2.personId,
      },
    });
  });
});

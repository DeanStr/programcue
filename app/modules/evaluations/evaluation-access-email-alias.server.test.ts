import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { EvaluationService } from "./evaluation-service.server";

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

const evaluationAdmin: Viewer = {
  personId: SBEK_FIXTURE_PEOPLE.organizer.personId,
  name: SBEK_FIXTURE_PEOPLE.organizer.name,
  email: routeableAddresses[SBEK_FIXTURE_PEOPLE.organizer.personId],
  role: "administrator",
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  demo: false,
  evaluation: true,
};

function productionEvaluationEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
  } as unknown as CloudflareEnvironment;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await testEnv.DB.batch([
    ...Object.entries(routeableAddresses).map(([personId, email]) =>
      testEnv.DB.prepare(
        "UPDATE people SET email = ?, updated_at = unixepoch() WHERE id = ?",
      ).bind(email, personId),
    ),
    testEnv.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, revoked_at = unixepoch()
        WHERE organisation_id = ? AND event_id = ? AND person_id = ?
          AND role = 'evaluator'`,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      SBEK_FIXTURE_PEOPLE.reviewer.personId,
    ),
  ]);
});

describe("evaluation reviewer email alias", () => {
  it("reuses the fixed reviewer, sends to its current inbox and audits the routing", async () => {
    const delivery = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "evaluation-alias-email" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", delivery);
    const enteredEmail = "sam.reviewer@sbek-test.example.com";
    const result = await new EvaluationService(
      productionEvaluationEnvironment(),
    ).inviteEvaluationMember(evaluationAdmin, {
      name: "Sam Whitfield",
      email: enteredEmail,
      role: "evaluator",
      teamId: null,
    });

    expect(result).toMatchObject({
      delivery: "sent",
      routing: {
        enteredEmail,
        routedEmail: routeableAddresses[SBEK_FIXTURE_PEOPLE.reviewer.personId],
        personId: SBEK_FIXTURE_PEOPLE.reviewer.personId,
      },
    });
    expect(delivery).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String(
        (delivery.mock.calls[0] as unknown as [string, RequestInit])[1].body,
      ),
    ) as { to: string[] };
    expect(body.to).toEqual([
      routeableAddresses[SBEK_FIXTURE_PEOPLE.reviewer.personId],
    ]);
    await expect(
      (env as unknown as CloudflareEnvironment).DB.prepare(
        `SELECT membership.person_id AS personId,
                json_extract(audit.metadata_json, '$.enteredEmail') AS enteredEmail,
                json_extract(audit.metadata_json, '$.email') AS routedEmail,
                json_extract(audit.metadata_json, '$.evaluatorEmailRouting.personId') AS routedPersonId
           FROM memberships membership
           JOIN audit_events audit ON audit.entity_id = membership.id
          WHERE membership.id = ?
            AND audit.action = 'membership.evaluator.invited'`,
      )
        .bind(result.membershipId)
        .first(),
    ).resolves.toEqual({
      personId: SBEK_FIXTURE_PEOPLE.reviewer.personId,
      enteredEmail,
      routedEmail: routeableAddresses[SBEK_FIXTURE_PEOPLE.reviewer.personId],
      routedPersonId: SBEK_FIXTURE_PEOPLE.reviewer.personId,
    });
  });

  it("rejects a reserved production destination before creating access state", async () => {
    const delivery = vi.fn();
    vi.stubGlobal("fetch", delivery);
    const email = "outside.reviewer@sbek-test.example.com";

    await expect(
      new EvaluationService(
        productionEvaluationEnvironment(),
      ).inviteEvaluationMember(evaluationAdmin, {
        name: "Outside reviewer",
        email,
        role: "evaluator",
        teamId: null,
      }),
    ).rejects.toThrow(/not deliverable: reserved or local-only domain/i);
    expect(delivery).not.toHaveBeenCalled();
    await expect(
      (env as unknown as CloudflareEnvironment).DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM people WHERE email = ? COLLATE NOCASE)
             AS peopleCount,
           (SELECT COUNT(*)
              FROM memberships membership
              JOIN people person ON person.id = membership.person_id
             WHERE membership.organisation_id = ?
               AND membership.event_id = ?
               AND membership.role = 'evaluator'
               AND person.email = ? COLLATE NOCASE) AS membershipCount`,
      )
        .bind(email, DEMO_ORGANISATION_ID, DEMO_EVENT_ID, email)
        .first(),
    ).resolves.toEqual({ peopleCount: 0, membershipCount: 0 });
  });

  it("rejects an exact kit alias outside a signed evaluator context without persisting the literal address", async () => {
    const enteredEmail = "sam.reviewer@sbek-test.example.com";

    await expect(
      new EvaluationService(
        productionEvaluationEnvironment(),
      ).inviteEvaluationMember(
        { ...evaluationAdmin, evaluation: false },
        {
          name: "Sam Whitfield",
          email: enteredEmail,
          role: "evaluator",
          teamId: null,
        },
      ),
    ).rejects.toThrow(/signed production-evaluation session/i);
    await expect(
      (env as unknown as CloudflareEnvironment).DB.prepare(
        "SELECT COUNT(*) AS count FROM people WHERE email = ? COLLATE NOCASE",
      )
        .bind(enteredEmail)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });
});

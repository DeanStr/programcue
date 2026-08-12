import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoData } from "./seed.server";
import { activateSbekDemoInvitation } from "./sbek-invitation.server";

const testEnv = env as unknown as CloudflareEnvironment;

beforeEach(async () => {
  await ensureDemoData(testEnv);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM memberships WHERE id IN (
         'sbek-invitation-reviewer', 'sbek-invitation-speaker',
         'sbek-invitation-unrelated'
       )`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO people (
         id, email, display_name, email_verified, profile_status
       ) VALUES (
         'person-sbek-unrelated', 'unrelated@example.com',
         'Unrelated Person', 1, 'published'
       )`,
    ),
  ]);
});

async function pendingMembership(
  id: string,
  personId: string,
  role: "evaluator" | "speaker",
) {
  await env.DB.prepare(
    `INSERT INTO memberships (
       id, organisation_id, event_id, person_id, role, invited_at,
       invitation_expires_at, accepted_at, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', ?, ?, unixepoch(),
               unixepoch() + 604800, NULL, unixepoch())`,
  )
    .bind(id, personId, role)
    .run();
}

describe("SBEK demo invitation activation", () => {
  it("activates exact reviewer and speaker fixtures without claiming email delivery", async () => {
    await pendingMembership(
      "sbek-invitation-reviewer",
      "person-sbek-reviewer",
      "evaluator",
    );
    await pendingMembership(
      "sbek-invitation-speaker",
      "person-sbek-speaker",
      "speaker",
    );

    await expect(
      activateSbekDemoInvitation(testEnv, {
        membershipId: "sbek-invitation-reviewer",
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        actorPersonId: "person-demo-admin",
        role: "evaluator",
      }),
    ).resolves.toBe("activated");
    await expect(
      activateSbekDemoInvitation(testEnv, {
        membershipId: "sbek-invitation-speaker",
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        actorPersonId: "person-demo-admin",
        role: "speaker",
      }),
    ).resolves.toBe("activated");

    await expect(
      activateSbekDemoInvitation(testEnv, {
        membershipId: "sbek-invitation-reviewer",
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        actorPersonId: "person-demo-admin",
        role: "evaluator",
      }),
    ).resolves.toBe("already_active");

    const activated = await env.DB.prepare(
      `SELECT id, accepted_at AS acceptedAt,
              invitation_expires_at AS invitationExpiresAt,
              last_operation_id AS operationId
         FROM memberships
        WHERE id IN ('sbek-invitation-reviewer', 'sbek-invitation-speaker')
        ORDER BY id`,
    ).all<{
      id: string;
      acceptedAt: number;
      invitationExpiresAt: number | null;
      operationId: string;
    }>();
    expect(activated.results).toHaveLength(2);
    expect(activated.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sbek-invitation-reviewer",
          acceptedAt: expect.any(Number),
          invitationExpiresAt: null,
          operationId: expect.stringMatching(/^demo-sbek-activation:/),
        }),
        expect.objectContaining({
          id: "sbek-invitation-speaker",
          acceptedAt: expect.any(Number),
          invitationExpiresAt: null,
          operationId: expect.stringMatching(/^demo-sbek-activation:/),
        }),
      ]),
    );
    const fixtureAudits = await env.DB.prepare(
      `SELECT correlation_id AS correlationId
         FROM audit_events
        WHERE entity_id IN ('sbek-invitation-reviewer', 'sbek-invitation-speaker')
          AND action = 'membership.demo_fixture_activated'
          AND json_extract(metadata_json, '$.emailDelivery') = 'not_sent'`,
    ).all<{ correlationId: string }>();
    expect(fixtureAudits.results).toHaveLength(2);
    expect(
      fixtureAudits.results.map(({ correlationId }) => correlationId),
    ).toEqual(
      expect.arrayContaining(
        activated.results.map(({ operationId }) => operationId),
      ),
    );
  });

  it("leaves unrelated demo invitations pending", async () => {
    await pendingMembership(
      "sbek-invitation-unrelated",
      "person-sbek-unrelated",
      "evaluator",
    );
    await expect(
      activateSbekDemoInvitation(testEnv, {
        membershipId: "sbek-invitation-unrelated",
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        actorPersonId: "person-demo-admin",
        role: "evaluator",
      }),
    ).resolves.toBe("not_fixture");
    expect(
      await env.DB.prepare(
        `SELECT accepted_at AS acceptedAt FROM memberships WHERE id = ?`,
      )
        .bind("sbek-invitation-unrelated")
        .first(),
    ).toEqual({ acceptedAt: null });
  });

  it("fails explicitly for an invalid runtime or stale exact fixture invitation", async () => {
    await pendingMembership(
      "sbek-invitation-reviewer",
      "person-sbek-reviewer",
      "evaluator",
    );
    await expect(
      activateSbekDemoInvitation(
        { ...testEnv, APP_ENV: "production" },
        {
          membershipId: "sbek-invitation-reviewer",
          organisationId: "org-future-events",
          eventId: "evt-foe-2025",
          actorPersonId: "person-demo-admin",
          role: "evaluator",
        },
      ),
    ).rejects.toThrow(/explicit non-production demo runtime/i);

    await env.DB.prepare(
      `UPDATE memberships SET invitation_expires_at = unixepoch() - 1
        WHERE id = 'sbek-invitation-reviewer'`,
    ).run();
    await expect(
      activateSbekDemoInvitation(testEnv, {
        membershipId: "sbek-invitation-reviewer",
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        actorPersonId: "person-demo-admin",
        role: "evaluator",
      }),
    ).rejects.toThrow(/not pending and valid/i);
  });
});

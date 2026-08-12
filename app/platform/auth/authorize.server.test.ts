import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  acceptEventInvitation,
  requireAuthenticatedPerson,
  requireEventRole,
} from "./authorize.server";

const eventId = "evt-foe-2025";
const adminMembershipId = "membership-demo-admin";
const request = new Request("https://programcue.test/admin/event", {
  headers: { cookie: "program_cue_demo_identity=administrator" },
});

function invitationAcceptanceRequest(origin = "https://programcue.test") {
  return new Request("https://programcue.test/events/select", {
    method: "POST",
    headers: {
      origin,
      cookie: "program_cue_demo_identity=administrator",
    },
  });
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "DELETE FROM memberships WHERE id = 'membership-demo-org-admin'",
  ).run();
  await env.DB.prepare(
    `
    UPDATE memberships
       SET role = 'administrator', invited_at = unixepoch(),
           invitation_expires_at = NULL, accepted_at = unixepoch(), revoked_at = NULL
     WHERE id = ?
  `,
  )
    .bind(adminMembershipId)
    .run();
});

describe("event role authorization", () => {
  it("redirects unauthenticated page requests to sign-in with their local destination", async () => {
    const productionEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment;
    const denied = await requireAuthenticatedPerson(
      new Request("http://localhost/admin/tasks?state=overdue"),
      productionEnv,
    ).catch((error: unknown) => error);

    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(302);
    expect((denied as Response).headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Ftasks%3Fstate%3Doverdue",
    );
  });

  it("retains a bare 401 for non-page authentication boundaries", async () => {
    const productionEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment;

    await expect(
      requireAuthenticatedPerson(
        new Request("http://localhost/admin/events/evt-foe-2025/changes"),
        productionEnv,
        "response",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("keeps an unselected demo browser anonymous at private boundaries", async () => {
    const pageResult = await requireAuthenticatedPerson(
      new Request("http://localhost/admin/tasks?state=overdue"),
      env as unknown as CloudflareEnvironment,
    ).catch((error: unknown) => error);
    expect(pageResult).toBeInstanceOf(Response);
    expect((pageResult as Response).status).toBe(302);
    expect((pageResult as Response).headers.get("location")).toBe(
      "/demo?returnTo=%2Fadmin%2Ftasks%3Fstate%3Doverdue",
    );

    await expect(
      requireAuthenticatedPerson(
        new Request("http://localhost/admin/events/evt-foe-2025/changes"),
        env as unknown as CloudflareEnvironment,
        "response",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    "program_cue_demo_identity=%E0%A4%A",
    "program_cue_demo_identity=not-a-demo-role",
  ])(
    "rejects an invalid demo-role cookie instead of selecting administrator",
    async (cookie) => {
      const rejected = await requireAuthenticatedPerson(
        new Request("http://localhost/admin/event", {
          headers: { cookie },
        }),
        env as unknown as CloudflareEnvironment,
      ).catch((error: unknown) => error);

      expect(rejected).toBeInstanceOf(Response);
      expect((rejected as Response).status).toBe(400);
      expect((rejected as Response).headers.get("set-cookie")).toContain(
        "program_cue_demo_identity=;",
      );
      expect((rejected as Response).headers.get("set-cookie")).toContain(
        "Max-Age=0",
      );
    },
  );

  it("selects the highest authorised role deterministically when memberships overlap", async () => {
    await env.DB.prepare(
      `
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
      ) VALUES ('membership-demo-admin-chair', 'org-future-events', ?,
                'person-demo-admin', 'committee_chair', unixepoch(), unixepoch(), unixepoch())
    `,
    )
      .bind(eventId)
      .run();

    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        eventId,
        ["owner", "administrator", "committee_chair"],
      ),
    ).resolves.toMatchObject({ role: "administrator" });
  });

  it("applies an accepted organisation administrator membership to every event in that organisation only", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT OR REPLACE INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES ('evt-org-admin-scope', 'org-future-events',
                  'Organisation admin event', 'organisation-admin-event',
                  'UTC', 1760000000, 1760086400, ?)
      `,
      ).bind(CANONICAL_EVENT_FILE_POLICY_JSON),
      env.DB.prepare(`
        INSERT OR REPLACE INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, accepted_at, created_at
        ) VALUES ('membership-demo-org-admin', 'org-future-events', NULL,
                  'person-demo-admin', 'administrator', unixepoch(),
                  unixepoch(), unixepoch())
      `),
    ]);

    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        "evt-org-admin-scope",
        ["administrator"],
      ),
    ).resolves.toMatchObject({
      organisationId: "org-future-events",
      eventId: "evt-org-admin-scope",
      role: "administrator",
    });

    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR REPLACE INTO organisations (id, name, slug)
        VALUES ('org-isolated-auth-test', 'Isolated auth test', 'isolated-auth-test')
      `),
      env.DB.prepare(
        `
        INSERT OR REPLACE INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES ('evt-isolated-auth-test', 'org-isolated-auth-test',
                  'Isolated event', 'isolated-auth-event', 'UTC',
                  1760000000, 1760086400, ?)
      `,
      ).bind(CANONICAL_EVENT_FILE_POLICY_JSON),
    ]);
    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        "evt-isolated-auth-test",
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts a valid organisation-administrator invitation through an event in that organisation", async () => {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES ('evt-org-admin-scope', 'org-future-events',
                  'Organisation admin event', 'organisation-admin-event',
                  'UTC', 1760000000, 1760086400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
      `),
      env.DB.prepare(`
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at, accepted_at, created_at
        ) VALUES ('membership-demo-org-admin', 'org-future-events', NULL,
                  'person-demo-admin', 'administrator', unixepoch(),
                  unixepoch() + 300, NULL, unixepoch())
      `),
    ]);

    await expect(
      acceptEventInvitation(
        invitationAcceptanceRequest(),
        env as unknown as CloudflareEnvironment,
        "evt-org-admin-scope",
        ["administrator"],
      ),
    ).resolves.toMatchObject({
      eventId: "evt-org-admin-scope",
      role: "administrator",
    });
    const accepted = await env.DB.prepare(
      `
      SELECT accepted_at AS acceptedAt
        FROM memberships
       WHERE id = 'membership-demo-org-admin'
    `,
    ).first<{ acceptedAt: number | null }>();
    expect(accepted?.acceptedAt).toBeTypeOf("number");
  });

  it("allows parallel explicit invitation submissions to share one acceptance", async () => {
    const auditBefore = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
        FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `,
    )
      .bind(adminMembershipId)
      .first<{ count: number }>();
    await env.DB.prepare(
      `
      UPDATE memberships
         SET accepted_at = NULL, invitation_expires_at = unixepoch() + 300
       WHERE id = ?
    `,
    )
      .bind(adminMembershipId)
      .run();

    const viewers = await Promise.all(
      Array.from({ length: 4 }, () =>
        acceptEventInvitation(
          invitationAcceptanceRequest(),
          env as unknown as CloudflareEnvironment,
          eventId,
          ["administrator"],
        ),
      ),
    );
    expect(viewers).toHaveLength(4);
    expect(viewers.every((viewer) => viewer.role === "administrator")).toBe(
      true,
    );
    const auditAfter = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
        FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `,
    )
      .bind(adminMembershipId)
      .first<{ count: number }>();
    expect(auditAfter?.count).toBe(Number(auditBefore?.count ?? 0) + 1);
  });

  it("denies a revoked membership even when it was previously accepted", async () => {
    await env.DB.prepare(
      "UPDATE memberships SET revoked_at = unixepoch() WHERE id = ?",
    )
      .bind(adminMembershipId)
      .run();

    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps loaders read-only and accepts a valid pending invitation only by explicit POST", async () => {
    const auditBefore = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `,
    )
      .bind(adminMembershipId)
      .first<{ count: number }>();
    await env.DB.prepare(
      `
      UPDATE memberships
         SET accepted_at = NULL, invitation_expires_at = unixepoch() + 300
       WHERE id = ?
    `,
    )
      .bind(adminMembershipId)
      .run();

    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });

    const pending = await env.DB.prepare(
      "SELECT accepted_at AS acceptedAt FROM memberships WHERE id = ?",
    )
      .bind(adminMembershipId)
      .first<{ acceptedAt: number | null }>();
    expect(pending?.acceptedAt).toBeNull();

    await expect(
      acceptEventInvitation(
        invitationAcceptanceRequest(),
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).resolves.toMatchObject({
      personId: "person-demo-admin",
      organisationId: "org-future-events",
      eventId,
      role: "administrator",
    });
    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).resolves.toMatchObject({ role: "administrator" });

    const [membership, audit, auditAfter] = await Promise.all([
      env.DB.prepare(
        "SELECT accepted_at AS acceptedAt FROM memberships WHERE id = ?",
      )
        .bind(adminMembershipId)
        .first<{ acceptedAt: number | null }>(),
      env.DB.prepare(
        `
        SELECT organisation_id AS organisationId, event_id AS eventId,
               actor_person_id AS actorPersonId, metadata_json AS metadataJson
          FROM audit_events
         WHERE entity_id = ? AND action = 'membership.accepted'
      `,
      )
        .bind(adminMembershipId)
        .first<{
          organisationId: string;
          eventId: string;
          actorPersonId: string;
          metadataJson: string;
        }>(),
      env.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM audit_events
         WHERE entity_id = ? AND action = 'membership.accepted'
      `,
      )
        .bind(adminMembershipId)
        .first<{ count: number }>(),
    ]);
    expect(membership?.acceptedAt).toBeTypeOf("number");
    expect(audit).toMatchObject({
      organisationId: "org-future-events",
      eventId,
      actorPersonId: "person-demo-admin",
    });
    expect(JSON.parse(audit!.metadataJson)).toEqual({ role: "administrator" });
    expect(auditAfter?.count).toBe(Number(auditBefore?.count ?? 0) + 1);
  });

  it("denies an expired pending invitation without accepting or auditing it", async () => {
    const before = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `,
    )
      .bind(adminMembershipId)
      .first<{ count: number }>();
    await env.DB.prepare(
      `
      UPDATE memberships
         SET accepted_at = NULL, invitation_expires_at = unixepoch() - 1
       WHERE id = ?
    `,
    )
      .bind(adminMembershipId)
      .run();

    await expect(
      acceptEventInvitation(
        invitationAcceptanceRequest(),
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });

    const after = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `,
    )
      .bind(adminMembershipId)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("fails closed for a pending invitation without an expiry", async () => {
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invited_at = unixepoch(),
              invitation_expires_at = NULL, revoked_at = NULL
        WHERE id = ?`,
    )
      .bind(adminMembershipId)
      .run();

    await expect(
      acceptEventInvitation(
        invitationAcceptanceRequest(),
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireEventRole(
        request,
        env as unknown as CloudflareEnvironment,
        eventId,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects GET and cross-origin invitation acceptance", async () => {
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invited_at = unixepoch(),
              invitation_expires_at = unixepoch() + 300, revoked_at = NULL
        WHERE id = ?`,
    )
      .bind(adminMembershipId)
      .run();

    await expect(
      Promise.resolve().then(() =>
        acceptEventInvitation(
          request,
          env as unknown as CloudflareEnvironment,
          eventId,
          ["administrator"],
        ),
      ),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      Promise.resolve().then(() =>
        acceptEventInvitation(
          invitationAcceptanceRequest("https://attacker.example"),
          env as unknown as CloudflareEnvironment,
          eventId,
          ["administrator"],
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

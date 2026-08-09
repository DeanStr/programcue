import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { requireAuthenticatedPerson, requireEventRole } from "./authorize.server";

const eventId = "evt-foe-2025";
const adminMembershipId = "membership-demo-admin";
const request = new Request("https://programcue.test/admin/event");

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(`
    UPDATE memberships
       SET role = 'administrator', invited_at = unixepoch(),
           invitation_expires_at = NULL, accepted_at = unixepoch(), revoked_at = NULL
     WHERE id = ?
  `).bind(adminMembershipId).run();
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
    expect((denied as Response).headers.get("location"))
      .toBe("/sign-in?returnTo=%2Fadmin%2Ftasks%3Fstate%3Doverdue");
  });

  it("retains a bare 401 for non-page authentication boundaries", async () => {
    const productionEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment;

    await expect(requireAuthenticatedPerson(
      new Request("http://localhost/admin/events/evt-foe-2025/changes"),
      productionEnv,
      "response",
    )).rejects.toMatchObject({ status: 401 });
  });

  it("selects the highest authorised role deterministically when memberships overlap", async () => {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
      ) VALUES ('membership-demo-admin-chair', 'org-future-events', ?,
                'person-demo-admin', 'committee_chair', unixepoch(), unixepoch(), unixepoch())
    `).bind(eventId).run();

    await expect(requireEventRole(
      request,
      env as unknown as CloudflareEnvironment,
      eventId,
      ["owner", "administrator", "committee_chair"],
    )).resolves.toMatchObject({ role: "administrator" });
  });

  it("denies a revoked membership even when it was previously accepted", async () => {
    await env.DB.prepare(
      "UPDATE memberships SET revoked_at = unixepoch() WHERE id = ?",
    ).bind(adminMembershipId).run();

    await expect(requireEventRole(
      request,
      env as unknown as CloudflareEnvironment,
      eventId,
      ["administrator"],
    )).rejects.toMatchObject({ status: 403 });
  });

  it("accepts and audits a valid pending invitation on first authenticated access", async () => {
    const auditBefore = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `).bind(adminMembershipId).first<{ count: number }>();
    await env.DB.prepare(`
      UPDATE memberships
         SET accepted_at = NULL, invitation_expires_at = unixepoch() + 300
       WHERE id = ?
    `).bind(adminMembershipId).run();

    await expect(requireEventRole(
      request,
      env as unknown as CloudflareEnvironment,
      eventId,
      ["administrator"],
    )).resolves.toMatchObject({
      personId: "person-demo-admin",
      organisationId: "org-future-events",
      eventId,
      role: "administrator",
    });
    await expect(requireEventRole(
      request,
      env as unknown as CloudflareEnvironment,
      eventId,
      ["administrator"],
    )).resolves.toMatchObject({ role: "administrator" });

    const [membership, audit, auditAfter] = await Promise.all([
      env.DB.prepare(
        "SELECT accepted_at AS acceptedAt FROM memberships WHERE id = ?",
      ).bind(adminMembershipId).first<{ acceptedAt: number | null }>(),
      env.DB.prepare(`
        SELECT organisation_id AS organisationId, event_id AS eventId,
               actor_person_id AS actorPersonId, metadata_json AS metadataJson
          FROM audit_events
         WHERE entity_id = ? AND action = 'membership.accepted'
      `).bind(adminMembershipId).first<{
        organisationId: string;
        eventId: string;
        actorPersonId: string;
        metadataJson: string;
      }>(),
      env.DB.prepare(`
        SELECT COUNT(*) AS count FROM audit_events
         WHERE entity_id = ? AND action = 'membership.accepted'
      `).bind(adminMembershipId).first<{ count: number }>(),
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
    const before = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `).bind(adminMembershipId).first<{ count: number }>();
    await env.DB.prepare(`
      UPDATE memberships
         SET accepted_at = NULL, invitation_expires_at = unixepoch() - 1
       WHERE id = ?
    `).bind(adminMembershipId).run();

    await expect(requireEventRole(
      request,
      env as unknown as CloudflareEnvironment,
      eventId,
      ["administrator"],
    )).rejects.toMatchObject({ status: 403 });

    const after = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'membership.accepted'
    `).bind(adminMembershipId).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});

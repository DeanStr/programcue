import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./event-setup";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(
  role: "owner" | "administrator",
  values?: Record<string, string>,
) {
  return new Request("http://localhost/admin/event", {
    method: values ? "POST" : "GET",
    headers: {
      cookie: `program_cue_demo_role=${role}; program_cue_event=evt-foe-2025`,
      origin: "http://localhost",
    },
    ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("Event Setup administrator scope route", () => {
  it("lets an owner invite, list and explicitly revoke an organisation administrator", async () => {
    const invited = await action({
      request: request("owner", {
        _intent: "invite",
        name: "Route Organisation Admin",
        email: "route-org-admin@example.com",
        scope: "organisation",
      }),
      params: {},
      context: context(),
    } as never);
    if (invited instanceof Response)
      throw new Error("Organisation invitation returned a raw response.");
    expect(invited.data.intent).toBe("invite");
    expect(invited.data.ok || invited.data.committed).toBe(true);
    const membership = await env.DB.prepare(`
      SELECT membership.id, membership.event_id AS eventId
        FROM memberships membership
        JOIN people person ON person.id = membership.person_id
       WHERE membership.organisation_id = 'org-future-events'
         AND membership.role = 'administrator'
         AND person.email = 'route-org-admin@example.com' COLLATE NOCASE
    `).first<{ id: string; eventId: string | null }>();
    expect(membership?.eventId).toBeNull();

    const setup = await loader({
      request: request("owner"),
      params: {},
      context: context(),
    } as never);
    expect(setup.canManageOrganisationAdministrators).toBe(true);
    expect(setup.event.administrators).toContainEqual(
      expect.objectContaining({
        id: membership?.id,
        scope: "organisation",
        status: "Invited",
      }),
    );

    const revoked = await action({
      request: request("owner", {
        _intent: "revoke_administrator",
        membershipId: membership?.id ?? "",
      }),
      params: {},
      context: context(),
    } as never);
    if (revoked instanceof Response)
      throw new Error("Administrator revocation returned a raw response.");
    expect(revoked.data.intent).toBe("revoke_administrator");
    expect(revoked.data.ok || revoked.data.committed).toBe(true);
    const state = await env.DB.prepare(
      "SELECT revoked_at AS revokedAt FROM memberships WHERE id = ?",
    )
      .bind(membership!.id)
      .first<{ revokedAt: number | null }>();
    expect(state?.revokedAt).toBeTypeOf("number");
  });

  it("allows event-only invitation by an event administrator but rejects organisation scope", async () => {
    const eventInvite = await action({
      request: request("administrator", {
        _intent: "invite",
        name: "Route Event Admin",
        email: "route-event-admin@example.com",
        scope: "event",
      }),
      params: {},
      context: context(),
    } as never);
    if (eventInvite instanceof Response)
      throw new Error("Event invitation returned a raw response.");
    expect(eventInvite.data.intent).toBe("invite");
    expect(eventInvite.data.ok || eventInvite.data.committed).toBe(true);
    const eventMembership = await env.DB.prepare(`
      SELECT membership.event_id AS eventId
        FROM memberships membership
        JOIN people person ON person.id = membership.person_id
       WHERE person.email = 'route-event-admin@example.com' COLLATE NOCASE
         AND membership.role = 'administrator'
    `).first<{ eventId: string | null }>();
    expect(eventMembership?.eventId).toBe("evt-foe-2025");

    const forbidden = await action({
      request: request("administrator", {
        _intent: "invite",
        name: "Forbidden Route Organisation Admin",
        email: "forbidden-route-org-admin@example.com",
        scope: "organisation",
      }),
      params: {},
      context: context(),
    } as never);
    if (forbidden instanceof Response)
      throw new Error("Forbidden invitation returned a raw response.");
    expect(forbidden.init?.status).toBe(403);
    expect(forbidden.data).toMatchObject({ ok: false, intent: "invite" });
    expect(
      await env.DB.prepare(`
        SELECT 1 FROM memberships membership
        JOIN people person ON person.id = membership.person_id
        WHERE person.email = 'forbidden-route-org-admin@example.com' COLLATE NOCASE
      `).first(),
    ).toBeNull();
  });

  it("rejects non-POST mutation methods", async () => {
    await expect(
      action({
        request: new Request("http://localhost/admin/event", {
          method: "PUT",
          headers: {
            cookie:
              "program_cue_demo_role=administrator; program_cue_event=evt-foe-2025",
            origin: "http://localhost",
          },
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 405 });
  });
});

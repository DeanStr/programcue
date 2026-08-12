import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./event-selector";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES ('evt-selector-target', 'org-future-events',
                'Selector target', 'selector-target', 'UTC',
                1760000000, 1760086400,
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
    `),
    env.DB.prepare(`
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role,
        invited_at, accepted_at, created_at
      ) VALUES ('membership-selector-org-admin', 'org-future-events', NULL,
                'person-demo-admin', 'administrator', unixepoch(),
                unixepoch(), unixepoch())
    `),
  ]);
});

describe("event selector route", () => {
  it("lists every authorised event and preserves a safe local return path", async () => {
    const result = await loader({
      request: new Request(
        "http://localhost/events/select?returnTo=%2Fadmin%2Ftasks%3Fstate%3Doverdue",
        { headers: { cookie: "program_cue_demo_identity=administrator" } },
      ),
      params: {},
      context: context(),
    } as never);
    expect(result.returnTo).toBe("/admin/tasks?state=overdue");
    expect(result.events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt-foe-2025", "evt-selector-target"]),
    );
  });

  it("puts an explicitly invited event ahead of a stale current selection", async () => {
    const result = await loader({
      request: new Request(
        "http://localhost/events/select?eventId=evt-selector-target&returnTo=%2Fadmin%2Fevent",
        {
          headers: {
            cookie:
              "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
          },
        },
      ),
      params: {},
      context: context(),
    } as never);

    expect(result.currentEventId).toBe("evt-foe-2025");
    expect(result.events[0]?.eventId).toBe("evt-selector-target");
  });

  it("rejects an explicit event that is outside the signed-in person's scope", async () => {
    await expect(
      loader({
        request: new Request(
          "http://localhost/events/select?eventId=evt-not-authorised",
          { headers: { cookie: "program_cue_demo_identity=administrator" } },
        ),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("sets a local HttpOnly selection cookie, reloads into that event and audits the switch", async () => {
    const response = await action({
      request: new Request("http://localhost/events/select", {
        method: "POST",
        headers: {
          cookie: "program_cue_demo_identity=administrator",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          eventId: "evt-selector-target",
          returnTo: "/admin/event",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/event");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("program_cue_event=evt-selector-target");
    expect(setCookie).toContain("HttpOnly");

    const browserCookie = setCookie.split(";", 1)[0];
    await expect(
      requireCurrentEventRole(
        new Request("http://localhost/admin/event", {
          headers: {
            cookie: `program_cue_demo_identity=administrator; ${browserCookie}`,
          },
        }),
        workerEnv,
        ["administrator"],
      ),
    ).resolves.toMatchObject({ eventId: "evt-selector-target" });

    const audit = await env.DB.prepare(
      `
      SELECT organisation_id AS organisationId, event_id AS eventId,
             actor_person_id AS actorPersonId, metadata_json AS metadataJson
        FROM audit_events
       WHERE action = 'event.context.switched'
         AND entity_id = 'evt-selector-target'
       ORDER BY created_at DESC
       LIMIT 1
    `,
    ).first<{
      organisationId: string;
      eventId: string;
      actorPersonId: string;
      metadataJson: string;
    }>();
    expect(audit).toMatchObject({
      organisationId: "org-future-events",
      eventId: "evt-selector-target",
      actorPersonId: "person-demo-admin",
    });
    expect(JSON.parse(audit!.metadataJson)).toEqual({
      hadPreviousSelection: false,
      role: "administrator",
    });
  });

  it("accepts the highest-priority pending role selected for an event", async () => {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES ('evt-selector-pending-role', 'org-future-events',
                  'Pending role target', 'selector-pending-role', 'UTC',
                  1760000000, 1760086400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
      `),
      env.DB.prepare(`
        INSERT OR REPLACE INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, accepted_at, created_at
        ) VALUES ('membership-selector-evaluator', 'org-future-events',
                  'evt-selector-pending-role', 'person-demo-evaluator',
                  'evaluator', unixepoch(), unixepoch(), unixepoch())
      `),
      env.DB.prepare(`
        INSERT OR REPLACE INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at, accepted_at, created_at
        ) VALUES ('membership-selector-pending-admin', 'org-future-events',
                  'evt-selector-pending-role', 'person-demo-evaluator',
                  'administrator', unixepoch(), unixepoch() + 300, NULL,
                  unixepoch())
      `),
    ]);
    const response = await action({
      request: new Request("http://localhost/events/select", {
        method: "POST",
        headers: {
          cookie: "program_cue_demo_identity=evaluator",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          eventId: "evt-selector-pending-role",
          returnTo: "/",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    expect(response.headers.get("location")).toBe("/admin/event");
    const membership = await env.DB.prepare(
      `
      SELECT accepted_at AS acceptedAt
        FROM memberships
       WHERE id = 'membership-selector-pending-admin'
    `,
    ).first<{ acceptedAt: number | null }>();
    expect(membership?.acceptedAt).toBeTypeOf("number");
  });

  it("rejects external return destinations", async () => {
    const result = await loader({
      request: new Request(
        "http://localhost/events/select?returnTo=https%3A%2F%2Fevil.example",
        { headers: { cookie: "program_cue_demo_identity=administrator" } },
      ),
      params: {},
      context: context(),
    } as never);
    expect(result.returnTo).toBe("/");
  });

  it("uses the selected event role landing page when the old surface is not authorised", async () => {
    await env.DB.prepare(
      `
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role,
        invited_at, accepted_at, created_at
      ) VALUES ('membership-selector-target-speaker', 'org-future-events',
                'evt-selector-target', 'person-demo-speaker', 'speaker',
                unixepoch(), unixepoch(), unixepoch())
    `,
    ).run();
    const response = await action({
      request: new Request("http://localhost/events/select", {
        method: "POST",
        headers: {
          cookie: "program_cue_demo_identity=speaker",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          eventId: "evt-selector-target",
          returnTo: "/admin/event",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    expect(response.headers.get("location")).toBe("/speaker/dashboard");
  });

  it("keeps a return path authorised by another accepted event role", async () => {
    await env.DB.prepare(
      `
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role,
        invited_at, accepted_at, created_at
      ) VALUES ('membership-selector-target-evaluator', 'org-future-events',
                'evt-selector-target', 'person-demo-admin', 'evaluator',
                unixepoch(), unixepoch(), unixepoch())
    `,
    ).run();
    const response = await action({
      request: new Request("http://localhost/events/select", {
        method: "POST",
        headers: {
          cookie: "program_cue_demo_identity=administrator",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          eventId: "evt-selector-target",
          returnTo: "/review/workbench?assignment=next",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    expect(response.headers.get("location")).toBe(
      "/review/workbench?assignment=next",
    );
  });
});

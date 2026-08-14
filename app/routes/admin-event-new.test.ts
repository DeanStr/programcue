import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-event-new";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(values?: Record<string, string>) {
  return new Request("http://localhost/admin/events/new", {
    method: values ? "POST" : "GET",
    headers: {
      cookie:
        "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
      origin: "http://localhost",
    },
    ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES (
       'membership-new-event-route-admin', 'org-future-events', NULL,
       'person-demo-admin', 'administrator', unixepoch(), unixepoch(), unixepoch()
     )`,
  ).run();
});

describe("new event route", () => {
  it("loads blank-event defaults for an organisation administrator", async () => {
    const result = await loader({
      request: request(),
      params: {},
      context: context(),
    } as never);

    expect(result).toMatchObject({
      creationIntentId: expect.any(String),
      timezone: "America/Toronto",
      airtableTableName: "Program Cue Rooms",
    });
  });

  it("creates a blank D1 event without requiring hidden Airtable fields", async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const creationIntentId = crypto.randomUUID();
    const values = {
      intent: "create",
      creationIntentId,
      name: `Route blank event ${token}`,
      slug: `route-blank-event-${token}`,
      timezone: "UTC",
      startDate: "2027-10-01",
      endDate: "2027-10-02",
      repositoryProvider: "d1",
      tableName: "Program Cue Rooms",
    };
    const args = () =>
      ({
        request: request(values),
        params: {},
        context: context(),
      }) as never;
    const response = await action(args());
    if (response instanceof Response)
      throw new Error("New event action returned a raw response.");

    expect(response.data).toMatchObject({
      ok: true,
      committed: true,
      result: { repositoryProvider: "d1" },
    });
    const replay = await action(args());
    if (replay instanceof Response)
      throw new Error("New event replay returned a raw response.");
    expect(replay.data).toEqual(response.data);
    expect(replay.data.result?.operationId).toBe(creationIntentId);
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider,
                (SELECT COUNT(*) FROM events WHERE slug = ?) AS eventCount
           FROM events WHERE slug = ?`,
      )
        .bind(`route-blank-event-${token}`, `route-blank-event-${token}`)
        .first(),
    ).toEqual({ provider: "d1", eventCount: 1 });
  });

  it("offers and reuses only an explicitly selected verified organisation sender", async () => {
    const sourceSenderId = "sender-production-evaluation-fixture";
    await env.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email, provider,
         provider_sender_id, status, created_at, updated_at
       ) VALUES (?, 'evt-foe-2025', 'Route sender', 'Program Cue Events',
                 'events@programcue.test', 'reply@programcue.test', 'resend',
                 'domain-programcue-test', 'verified', unixepoch(), unixepoch())`,
    )
      .bind(sourceSenderId)
      .run();
    const prepared = await loader({
      request: request(),
      params: {},
      context: context(),
    } as never);
    expect(prepared.reusableSenderProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceSenderId,
          sourceEventName: "Future of Events 2025",
          provider: "resend",
        }),
      ]),
    );

    const token = crypto.randomUUID().slice(0, 8);
    const response = await action({
      request: request({
        intent: "create",
        creationIntentId: crypto.randomUUID(),
        name: `Route sender event ${token}`,
        slug: `route-sender-event-${token}`,
        timezone: "UTC",
        startDate: "2027-10-01",
        endDate: "2027-10-02",
        repositoryProvider: "d1",
        reuseSenderProfileId: sourceSenderId,
      }),
      params: {},
      context: context(),
    } as never);
    if (response instanceof Response)
      throw new Error("New event action returned a raw response.");
    expect(response.data).toMatchObject({
      ok: true,
      committed: true,
      message: expect.stringContaining("verified sender is ready"),
    });
    expect(
      await env.DB.prepare(
        `SELECT sender.from_name AS fromName, sender.from_email AS fromEmail,
                sender.reply_to_email AS replyToEmail, sender.provider,
                sender.provider_sender_id AS providerSenderId, sender.status,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.event_id = sender.event_id
                    AND audit.action = 'communication.sender.reused') AS audits
           FROM sender_profiles sender
          WHERE sender.event_id = ?`,
      )
        .bind(response.data.result?.eventId)
        .first(),
    ).toEqual({
      fromName: "Program Cue Events",
      fromEmail: "events@programcue.test",
      replyToEmail: "reply@programcue.test",
      provider: "resend",
      providerSenderId: "domain-programcue-test",
      status: "verified",
      audits: 1,
    });
  });
});

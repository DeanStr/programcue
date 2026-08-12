import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action } from "./admin-speakers";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function adminRequest(body: URLSearchParams) {
  const eventCookie = currentEventCookie(
    "evt-foe-2025",
    env as unknown as CloudflareEnvironment,
  ).split(";", 1)[0];
  return new Request("http://localhost/admin/speakers", {
    method: "POST",
    headers: {
      cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
      origin: "http://localhost",
    },
    body,
  });
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "UPDATE events SET duplicate_person_warnings = 1 WHERE id = ?",
  )
    .bind("evt-foe-2025")
    .run();
});

describe("manual speaker identity checks", () => {
  it("warns on a same-name identity, then creates one replay-safe event membership after confirmation", async () => {
    const suffix = crypto.randomUUID();
    const email = `manual-speaker-${suffix}@example.com`;
    const base = {
      _intent: "create_manual_speaker",
      idempotencyKey: `manual-speaker-${suffix}`,
      name: "Priya Shah",
      email,
    };

    const warning = await action({
      request: adminRequest(new URLSearchParams(base)),
      params: {},
      context: context(),
    } as never);
    if (warning instanceof Response)
      throw new Error("Manual speaker warning returned a raw response.");
    expect(warning.init?.status).toBe(409);
    expect(warning.data).toMatchObject({
      ok: false,
      duplicateCheck: {
        matches: expect.arrayContaining([
          expect.objectContaining({
            personId: "person-demo-speaker",
            reasons: ["same_name"],
          }),
        ]),
      },
    });
    expect(
      await env.DB.prepare("SELECT id FROM people WHERE email = ?")
        .bind(email)
        .first(),
    ).toBeNull();

    const confirmedBody = new URLSearchParams({
      ...base,
      confirmDuplicatePeople: "yes",
    });
    const confirmed = await action({
      request: adminRequest(confirmedBody),
      params: {},
      context: context(),
    } as never);
    if (confirmed instanceof Response)
      throw new Error("Confirmed manual speaker returned a raw response.");
    expect(confirmed.init?.status ?? 200).toBe(200);
    expect(confirmed.data).toMatchObject({ ok: true });

    const replay = await action({
      request: adminRequest(
        new URLSearchParams({ ...base, confirmDuplicatePeople: "yes" }),
      ),
      params: {},
      context: context(),
    } as never);
    if (replay instanceof Response)
      throw new Error("Manual speaker replay returned a raw response.");
    expect(replay.data).toMatchObject({ ok: true });

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM people WHERE email = ?) AS peopleCount,
         (SELECT COUNT(*)
            FROM memberships membership
            JOIN people person ON person.id = membership.person_id
           WHERE membership.event_id = ? AND membership.role = 'speaker'
             AND person.email = ?) AS membershipCount,
         (SELECT COUNT(*)
            FROM audit_events audit
            JOIN people person ON person.id = audit.entity_id
           WHERE audit.event_id = ? AND audit.action = 'speaker.admin.invited'
             AND person.email = ?) AS auditCount`,
    )
      .bind(email, "evt-foe-2025", email, "evt-foe-2025", email)
      .first<{
        peopleCount: number;
        membershipCount: number;
        auditCount: number;
      }>();
    expect(counts).toEqual({
      peopleCount: 1,
      membershipCount: 1,
      auditCount: 1,
    });
  });
});

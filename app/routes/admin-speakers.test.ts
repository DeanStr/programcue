import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { loader as sessionLoader } from "./admin-create-session";
import { loader as detailLoader } from "./admin-speaker-detail";
import { action, loader as rosterLoader } from "./admin-speakers";
import { loader as taskLoader } from "./admin-tasks";

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
  it("exposes the actual inactive workflow status on both record surfaces", async () => {
    const args = () => ({
      request: new Request(
        "http://localhost/admin/speakers?person=person-demo-speaker",
        {
          headers: {
            cookie: adminRequest(new URLSearchParams()).headers.get("cookie")!,
          },
        },
      ),
      params: { personId: "person-demo-speaker" },
      context: context(),
    });
    await rosterLoader(args() as never);
    for (const status of ["declined", "withdrawn"] as const) {
      await env.DB.prepare(
        "UPDATE event_speaker_workflows SET status = ? WHERE event_id = ? AND person_id = ?",
      )
        .bind(status, "evt-foe-2025", "person-demo-speaker")
        .run();
      expect(
        (await rosterLoader(args() as never)).focusedSpeaker?.workflowStatus,
      ).toBe(status);
      expect(
        (await detailLoader(args() as never)).detail.profile.workflowStatus,
      ).toBe(status);
      await expect(taskLoader(args() as never)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it("fails explicitly when the committed roster record cannot be read, and can retry without duplicating it", async () => {
    const token = crypto.randomUUID();
    const input = {
      _intent: "add_manual_speaker",
      idempotencyKey: token,
      name: `Roster speaker ${token.slice(0, 8)}`,
      email: `roster-${token}@example.com`,
      confirmDuplicatePeople: "yes",
    };
    const lookup = vi
      .spyOn(PersonDuplicateService.prototype, "searchOrganisationPeople")
      .mockResolvedValue([]);
    try {
      await expect(
        action({
          request: adminRequest(new URLSearchParams(input)),
          params: {},
          context: context(),
        } as never),
      ).rejects.toThrow(
        "The saved speaker record could not be read from this event roster.",
      );
    } finally {
      lookup.mockRestore();
    }
    const result = await action({
      request: adminRequest(new URLSearchParams(input)),
      params: {},
      context: context(),
    } as never);
    if (result instanceof Response)
      throw new Error("Roster retry returned a raw response.");
    expect(result.data).toMatchObject({
      ok: true,
      addedSpeaker: { name: input.name },
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM people WHERE email = ?",
      )
        .bind(input.email)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("rejects handoff records from another event or organisation", async () => {
    const token = crypto.randomUUID();
    const otherOrganisationId = `handoff-org-${token}`;
    await env.DB.prepare(
      "INSERT INTO organisations (id, name, slug) VALUES (?, 'Other organisation', ?)",
    )
      .bind(otherOrganisationId, otherOrganisationId)
      .run();
    for (const organisationId of ["org-future-events", otherOrganisationId]) {
      const eventId = crypto.randomUUID();
      const personId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO events (id, organisation_id, name, slug, timezone, starts_at, ends_at, file_policy_json)
          SELECT ?, ?, 'Other event', ?, timezone, starts_at, ends_at, file_policy_json
          FROM events WHERE id = 'evt-foe-2025'`).bind(
          eventId,
          organisationId,
          eventId,
        ),
        env.DB.prepare(
          "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Other speaker')",
        ).bind(personId, `${personId}@example.com`),
        env.DB.prepare(`INSERT INTO event_speaker_workflows (event_id, person_id, status, source, last_operation_id)
          VALUES (?, ?, 'prospect', 'membership', ?)`).bind(
          eventId,
          personId,
          crypto.randomUUID(),
        ),
      ]);
      for (const [path, load] of [
        ["/admin/sessions/new", sessionLoader],
        ["/admin/tasks?view=plans", taskLoader],
      ] as const) {
        const url = new URL(path, "http://localhost");
        url.searchParams.set("person", personId);
        await expect(
          load({
            request: new Request(url, {
              headers: {
                cookie: adminRequest(new URLSearchParams()).headers.get(
                  "cookie",
                )!,
              },
            }),
            params: {},
            context: context(),
          } as never),
        ).rejects.toMatchObject({ status: 404 });
      }
    }
  });

  it("adds a replay-safe prospect without email work, then sends portal access only after explicit confirmation", async () => {
    const suffix = crypto.randomUUID();
    const email = `manual-speaker-${suffix}@example.com`;
    const base = {
      _intent: "add_manual_speaker",
      idempotencyKey: `manual-speaker-${suffix}`,
      name: "Priya Shah",
      email,
      jobTitle: "Researcher",
      organisationName: "Signal Works",
      biography: "Designs safer events.",
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

    const alreadyActive = await action({
      request: adminRequest(
        new URLSearchParams({
          ...base,
          idempotencyKey: `manual-speaker-fresh-${suffix}`,
          confirmDuplicatePeople: "yes",
        }),
      ),
      params: {},
      context: context(),
    } as never);
    if (alreadyActive instanceof Response)
      throw new Error("Already-active speaker returned a raw response.");
    expect(alreadyActive.init?.status).toBe(409);
    expect(alreadyActive.data).toMatchObject({
      ok: false,
      existingRosterPerson: { name: "Priya Shah" },
      message: expect.stringMatching(
        /already on this event roster.*values were not applied/i,
      ),
    });

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
           WHERE audit.event_id = ? AND audit.action = 'speaker.admin.added'
             AND person.email = ?) AS auditCount,
         (SELECT COUNT(*)
            FROM communications communication
            JOIN people person ON person.email = ? COLLATE NOCASE
           WHERE communication.event_id = ?
             AND json_extract(communication.audience_json, '$.email') = person.email
         ) AS communicationCount`,
    )
      .bind(
        email,
        "evt-foe-2025",
        email,
        "evt-foe-2025",
        email,
        email,
        "evt-foe-2025",
      )
      .first<{
        peopleCount: number;
        membershipCount: number;
        auditCount: number;
        communicationCount: number;
      }>();
    expect(counts).toEqual({
      peopleCount: 1,
      membershipCount: 1,
      auditCount: 1,
      communicationCount: 0,
    });

    const person = await env.DB.prepare(
      "SELECT id FROM people WHERE email = ? COLLATE NOCASE",
    )
      .bind(email)
      .first<{ id: string }>();
    expect(person).not.toBeNull();
    expect(confirmed.data).toMatchObject({
      addedSpeaker: {
        id: person!.id,
        name: "Priya Shah",
        needsPortalAccessForSession: false,
      },
    });
    const requestHandoff = (path: string) =>
      new Request(`http://localhost${path}`, {
        headers: { cookie: adminRequest(confirmedBody).headers.get("cookie")! },
      });
    const sessionForm = await sessionLoader({
      request: requestHandoff(`/admin/sessions/new?person=${person!.id}`),
      params: {},
      context: context(),
    } as never);
    expect(sessionForm.initialSpeaker).toEqual({
      name: "Priya Shah",
      email,
      biography: "Designs safer events.",
    });
    const recordArgs = {
      request: requestHandoff(`/admin/speakers?person=${person!.id}`),
      params: { personId: person!.id },
      context: context(),
    };
    const roster = await rosterLoader(recordArgs as never);
    expect(roster.focusedSpeaker).toEqual({
      id: person!.id,
      name: "Priya Shah",
      needsPortalAccessForSession: false,
      workflowStatus: "prospect",
    });
    const detail = await detailLoader(recordArgs as never);
    expect(detail.needsPortalAccessForSession).toBe(false);
    expect(sessionForm.speakerNeedingPortalAccess).toBeNull();
    const taskForm = await taskLoader({
      request: requestHandoff(`/admin/tasks?view=plans&person=${person!.id}`),
      params: {},
      context: context(),
    } as never);
    expect(taskForm.focusedSpeakerId).toBe(person!.id);
    for (const [path, load] of [
      ["/admin/sessions/new", sessionLoader],
      ["/admin/tasks", taskLoader],
    ] as const) {
      for (const personId of ["unknown-speaker", "", "  "]) {
        const search = new URLSearchParams({ person: personId });
        await expect(
          load({
            request: requestHandoff(`${path}?${search}`),
            params: {},
            context: context(),
          } as never),
        ).rejects.toMatchObject({ status: 404 });
      }
    }
    const invited = await action({
      request: adminRequest(
        new URLSearchParams({
          _intent: "send_speaker_invitation",
          idempotencyKey: `invite-speaker-${suffix}`,
          personId: person!.id,
          confirmation: "send",
        }),
      ),
      params: {},
      context: context(),
    } as never);
    if (invited instanceof Response)
      throw new Error("Speaker invitation returned a raw response.");
    expect(invited.data).toMatchObject({ ok: true });
    await expect(
      env.DB.prepare(
        `SELECT membership.invited_at IS NOT NULL AS invited,
                membership.invitation_expires_at IS NOT NULL AS hasExpiry,
                workflow.status
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = membership.event_id
            AND workflow.person_id = membership.person_id
          WHERE membership.event_id = ? AND person.email = ? COLLATE NOCASE
            AND membership.role = 'speaker'`,
      )
        .bind("evt-foe-2025", email)
        .first(),
    ).resolves.toEqual({ invited: 1, hasExpiry: 1, status: "invited" });
    await env.DB.prepare(
      "UPDATE memberships SET accepted_at = unixepoch() WHERE event_id = ? AND person_id = ? AND role = 'speaker'",
    )
      .bind("evt-foe-2025", person!.id)
      .run();
    const acceptedRoster = await rosterLoader(recordArgs as never);
    expect(acceptedRoster.focusedSpeaker?.needsPortalAccessForSession).toBe(
      false,
    );
    const acceptedDetail = await detailLoader(recordArgs as never);
    expect(acceptedDetail.needsPortalAccessForSession).toBe(false);
  });
});

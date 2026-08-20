import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import {
  chooseInitialEvent,
  currentEventCookie,
  listAuthorisedEvents,
  loadCurrentEventAdminShellContext,
  recordEventContextSwitch,
  requireCurrentEventRole,
  resolveCurrentEventId,
} from "./current-event.server";

const workerEnv = env as unknown as CloudflareEnvironment;

function demoRequest(cookie = "program_cue_demo_identity=administrator") {
  return new Request("https://programcue.test/admin/event", {
    headers: { cookie },
  });
}

function productionEvaluationEnvironment() {
  return {
    ...workerEnv,
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
  } as CloudflareEnvironment;
}

async function selectedEvaluationRequest() {
  const testEnv = productionEvaluationEnvironment();
  await testEnv.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
               'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
               unixepoch())`,
  )
    .bind(crypto.randomUUID())
    .run();
  const cookie = (await evaluationSessionCookie(testEnv, "organizer")).split(
    ";",
    1,
  )[0]!;
  return {
    env: testEnv,
    request: new Request("https://app.programcue.com/events/select", {
      headers: { cookie },
    }),
  };
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES ('evt-current-context-two', 'org-future-events',
                'Second authorised event', 'current-context-two', 'UTC',
                1760000000, 1760086400,
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
      ON CONFLICT(id) DO UPDATE SET
        organisation_id = excluded.organisation_id,
        name = excluded.name,
        slug = excluded.slug,
        timezone = excluded.timezone,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        repository_provider = 'd1',
        activation_status = 'active',
        file_policy_json = excluded.file_policy_json
    `),
    env.DB.prepare(`
      INSERT OR REPLACE INTO memberships (
        id, organisation_id, event_id, person_id, role,
        invited_at, accepted_at, created_at
      ) VALUES ('membership-current-context-org-admin',
                'org-future-events', NULL, 'person-demo-admin',
                'administrator', unixepoch(), unixepoch(), unixepoch())
    `),
  ]);
});

describe("current event context", () => {
  it("lists evaluator-created events in the dedicated organisation", async () => {
    const evaluation = await selectedEvaluationRequest();
    const events = await listAuthorisedEvents(
      evaluation.request,
      evaluation.env,
      ["administrator"],
    );
    expect(events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt-foe-2025", "evt-current-context-two"]),
    );
    expect(
      events.every((event) => event.organisationId === "org-future-events"),
    ).toBe(true);
  });

  it("fails the evaluator event list closed after any cross-organisation identity link", async () => {
    const evaluation = await selectedEvaluationRequest();
    await evaluation.env.DB.batch([
      evaluation.env.DB.prepare(
        `INSERT INTO organisations (id, name, slug)
         VALUES ('org-evaluation-list-outside', 'Outside list',
                 'evaluation-list-outside')`,
      ),
      evaluation.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES ('membership-evaluation-list-outside',
                   'org-evaluation-list-outside', NULL, 'person-demo-admin',
                   'administrator', unixepoch(), unixepoch(), unixepoch())`,
      ),
    ]);

    await expect(
      listAuthorisedEvents(evaluation.request, evaluation.env, [
        "administrator",
      ]),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("uses only a configured authorised default or an unambiguous sole event", () => {
    const events = [{ eventId: "event-a" }, { eventId: "event-b" }];
    expect(chooseInitialEvent(events, "event-b")).toBe("event-b");
    expect(chooseInitialEvent(events, "missing")).toBeNull();
    expect(chooseInitialEvent([{ eventId: "event-a" }], undefined)).toBe(
      "event-a",
    );
  });

  it("emits a production __Host cookie and a local HTTP-compatible demo cookie", () => {
    const production = {
      ...workerEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
    } as CloudflareEnvironment;
    const productionCookie = currentEventCookie("evt-production", production);
    expect(productionCookie).toContain(
      "__Host-program_cue_event=evt-production",
    );
    expect(productionCookie).toContain("; Secure");
    expect(productionCookie).toContain("; HttpOnly");
    expect(productionCookie).toContain("; SameSite=Lax");

    const localCookie = currentEventCookie("evt-local", workerEnv);
    expect(localCookie).toContain("program_cue_event=evt-local");
    expect(localCookie).not.toContain("; Secure");
    expect(localCookie).toContain("; HttpOnly");

    expect(() =>
      currentEventCookie("evt-invalid-runtime", {
        ...workerEnv,
        APP_ENV: "production",
        DEMO_MODE: "true",
      } as unknown as CloudflareEnvironment),
    ).toThrow("Unsupported APP_ENV/DEMO_MODE/EVALUATION_MODE combination");
  });

  it("loads admin shell state through an event-and-organisation scoped service boundary", async () => {
    const request = demoRequest(
      "program_cue_demo_identity=administrator; program_cue_event=evt-current-context-two",
    );
    const viewer = await requireCurrentEventRole(request, workerEnv, [
      "administrator",
    ]);
    const context = await loadCurrentEventAdminShellContext(workerEnv, viewer, [
      "administrator",
    ]);
    expect(context.eventOptions.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt-foe-2025", "evt-current-context-two"]),
    );
    expect(context.event).toEqual({
      id: "evt-current-context-two",
      name: "Second authorised event",
      timezone: "UTC",
      startDate: "2025-10-09",
      endDate: "2025-10-10",
      venue: "",
      city: "",
    });
    expect(context.canCreateEvents).toBe(true);
    expect(context.canSearchOrganisation).toBe(false);
    expect(context.notificationCounts).toEqual({
      overdueTasks: expect.any(Number),
      scheduleConflicts: expect.any(Number),
      failedOperations: expect.any(Number),
    });

    await expect(
      loadCurrentEventAdminShellContext(
        workerEnv,
        { ...viewer, organisationId: "org-current-context-isolated" },
        ["administrator"],
      ),
    ).rejects.toThrow(
      "The authorised current event no longer belongs to its organisation.",
    );

    const ownerRequest = demoRequest(
      "program_cue_demo_identity=owner; program_cue_event=evt-current-context-two",
    );
    const owner = await requireCurrentEventRole(ownerRequest, workerEnv, [
      "owner",
    ]);
    await expect(
      loadCurrentEventAdminShellContext(workerEnv, owner, ["owner"]),
    ).resolves.toMatchObject({
      canCreateEvents: true,
      canSearchOrganisation: true,
    });
  });

  it("reuses an already-authorised viewer when loading the admin shell", async () => {
    const productionEnv = {
      ...workerEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "false",
    } as unknown as CloudflareEnvironment;
    await expect(
      loadCurrentEventAdminShellContext(
        productionEnv,
        {
          personId: "person-demo-admin",
          name: "Olivia Bennett",
          email: "olivia@example.com",
          role: "administrator",
          organisationId: "org-future-events",
          eventId: "evt-foe-2025",
          demo: false,
        },
        ["administrator"],
      ),
    ).resolves.toMatchObject({
      eventOptions: expect.arrayContaining([
        expect.objectContaining({ eventId: "evt-foe-2025" }),
      ]),
    });
  });

  it("lists and resolves both event-specific and organisation-wide access", async () => {
    const events = await listAuthorisedEvents(demoRequest(), workerEnv, [
      "administrator",
    ]);
    expect(events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt-foe-2025", "evt-current-context-two"]),
    );
    expect(
      events.filter((event) => event.eventId === "evt-foe-2025"),
    ).toHaveLength(1);

    const request = demoRequest(
      "program_cue_demo_identity=administrator; program_cue_event=evt-current-context-two",
    );
    await expect(
      requireCurrentEventRole(request, workerEnv, ["administrator"]),
    ).resolves.toMatchObject({
      eventId: "evt-current-context-two",
      organisationId: "org-future-events",
      role: "administrator",
    });
  });

  it("omits inactive events and rejects a stale selection for one", async () => {
    await env.DB.prepare(
      `UPDATE events
          SET repository_provider = 'airtable',
              activation_status = 'provisioning_failed'
        WHERE id = 'evt-current-context-two'`,
    ).run();

    const events = await listAuthorisedEvents(demoRequest(), workerEnv, [
      "administrator",
    ]);
    expect(
      events.some((event) => event.eventId === "evt-current-context-two"),
    ).toBe(false);
    await expect(
      requireCurrentEventRole(
        demoRequest(
          "program_cue_demo_identity=administrator; program_cue_event=evt-current-context-two",
        ),
        workerEnv,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("omits pending invitations without a finite future expiry", async () => {
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invited_at = unixepoch(),
              invitation_expires_at = NULL, revoked_at = NULL
        WHERE id = 'membership-demo-evaluator'`,
    ).run();

    await expect(
      listAuthorisedEvents(
        demoRequest("program_cue_demo_identity=evaluator"),
        workerEnv,
        ["evaluator"],
      ),
    ).resolves.toEqual([]);
  });

  it("keeps accepted event access ahead of a pending higher-priority role", async () => {
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = unixepoch(), invitation_expires_at = NULL,
              revoked_at = NULL
        WHERE id = 'membership-demo-evaluator'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, invitation_expires_at, created_at
       ) VALUES (?, 'org-future-events', 'evt-foe-2025',
                 'person-demo-evaluator', 'administrator', unixepoch(),
                 unixepoch() + 604800, unixepoch())`,
    )
      .bind(`pending-admin-${crypto.randomUUID()}`)
      .run();

    const events = await listAuthorisedEvents(
      demoRequest("program_cue_demo_identity=evaluator"),
      workerEnv,
      ["administrator", "evaluator"],
    );
    expect(
      events.find((event) => event.eventId === "evt-foe-2025"),
    ).toMatchObject({
      role: "evaluator",
      invitationPending: false,
      pendingInvitationRole: "administrator",
    });
  });

  it("records only real, organisation-scoped event context switches", async () => {
    const request = demoRequest(
      "program_cue_demo_identity=administrator; program_cue_event=evt-current-context-two",
    );
    const viewer = await requireCurrentEventRole(request, workerEnv, [
      "administrator",
    ]);

    await expect(
      recordEventContextSwitch(workerEnv, viewer, viewer.eventId),
    ).resolves.toBe(false);
    await expect(
      recordEventContextSwitch(workerEnv, viewer, "evt-foe-2025"),
    ).resolves.toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE action = 'event.context.switched' AND entity_id = ?`,
      )
        .bind(viewer.eventId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    await expect(
      recordEventContextSwitch(
        workerEnv,
        { ...viewer, organisationId: "org-current-context-isolated" },
        null,
      ),
    ).rejects.toThrow(
      "The selected event no longer belongs to the authorised organisation.",
    );
  });

  it("uses the explicit fixed demo event only when no selection exists", async () => {
    await expect(
      resolveCurrentEventId(demoRequest(), workerEnv, ["administrator"]),
    ).resolves.toBe(workerEnv.DEFAULT_EVENT_ID);
  });

  it("does not infer the demo event while a mutation is in flight", async () => {
    await expect(
      resolveCurrentEventId(
        new Request("https://programcue.test/admin/event", {
          method: "POST",
          headers: {
            cookie: "program_cue_demo_identity=administrator",
            origin: "https://programcue.test",
          },
        }),
        workerEnv,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 428 });
  });

  it("fails fast when the selected event is outside the signed-in person's organisations", async () => {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR REPLACE INTO organisations (id, name, slug)
        VALUES ('org-current-context-isolated', 'Isolated', 'current-context-isolated')
      `),
      env.DB.prepare(
        `
        INSERT OR REPLACE INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES ('evt-current-context-isolated', 'org-current-context-isolated',
                  'Isolated event', 'current-context-isolated-event', 'UTC',
                  1760000000, 1760086400, ?)
      `,
      ).bind(CANONICAL_EVENT_FILE_POLICY_JSON),
    ]);
    const request = demoRequest(
      "program_cue_demo_identity=administrator; program_cue_event=evt-current-context-isolated",
    );
    await expect(
      requireCurrentEventRole(request, workerEnv, ["administrator"]),
    ).rejects.toMatchObject({ status: 403 });
  });
});

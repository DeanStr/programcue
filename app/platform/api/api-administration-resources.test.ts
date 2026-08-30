import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { loader as administrationResourceLoader } from "~/routes/api-administration-resources";
import type { ApiPrincipal } from "./api.server";
import { ApiAdministrationItemService } from "./api-administration-item-service.server";
import {
  ApiAdministrationService,
  parseAdminQuery,
} from "./api-administration-service.server";
import { ApiEvaluationService } from "./api-evaluation-service.server";

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const testEnv = env as unknown as CloudflareEnvironment;
const principal = {
  keyId: "expanded-api-key",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  scopes: new Set([
    "events:read",
    "sessions:read",
    "evaluation:read",
    "integrations:read",
  ]),
} satisfies ApiPrincipal & { eventId: string };

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
});

describe("administration API reads", () => {
  it("checks repository authority for managed reads but not D1-only resources", async () => {
    await ensureDemoProgramme(testEnv);
    await ensureDemoEvaluationData(testEnv);
    const reads: string[] = [];
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        reads.push(scope.eventId);
        return null;
      },
    } as unknown as AirtableProviderBoundary;
    const administration = new ApiAdministrationService(testEnv, {
      airtable,
    });
    const items = new ApiAdministrationItemService(testEnv, { airtable });
    const evaluation = new ApiEvaluationService(testEnv, { airtable });

    await administration.getEvent(principal);
    await administration.list(principal, "sessions", { limit: 1 });
    await items.get(principal, "sessions", "demo-session-1");
    await evaluation.list(principal, "plans", { limit: 1 });
    expect(reads).toEqual(Array(4).fill(principal.eventId));

    await administration.list(principal, "communications", { limit: 1 });
    await expect(
      items.get(principal, "resources", "missing-d1-resource"),
    ).rejects.toMatchObject({ code: "ADMIN_ITEM_NOT_FOUND" });
    expect(reads).toEqual(Array(4).fill(principal.eventId));
  });

  it("uses strict filters, opaque cursors and tenant-isolated event records", async () => {
    await ensureDemoProgramme(testEnv);
    const service = new ApiAdministrationService(testEnv);
    const event = await service.getEvent(principal);
    expect(event).toMatchObject({
      id: principal.eventId,
      repositoryProvider: "d1",
    });
    expect(event.startsAt).toMatch(/Z$/u);

    const first = await service.list(principal, "sessions", { limit: 2 });
    const firstSessions = first.sessions as unknown as Array<{
      id: string;
      title: string;
      requiredResources: unknown[];
      speakerIds: string[];
    }>;
    expect(firstSessions).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(firstSessions[0]).toMatchObject({
      requiredResources: expect.any(Array),
      speakerIds: expect.any(Array),
    });
    const second = await service.list(principal, "sessions", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const secondSessions = second.sessions as unknown as Array<{ id: string }>;
    expect(secondSessions.map((session) => session.id)).not.toEqual(
      firstSessions.map((session) => session.id),
    );

    const suffix = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organisations (id, name, slug) VALUES (?, 'Other API tenant', ?)`,
      ).bind(`other-org-${suffix}`, `other-org-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'Other event', ?, 'UTC', 2000000000, 2000086400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(
        `other-event-${suffix}`,
        `other-org-${suffix}`,
        `other-event-${suffix}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status, visibility
        ) VALUES (?, ?, 'Foreign tenant session', ?, 'presentation', 30,
                  'unscheduled', 'private')`,
      ).bind(
        `other-session-${suffix}`,
        `other-event-${suffix}`,
        `other-session-${suffix}`,
      ),
    ]);
    const all = await service.list(principal, "sessions", { limit: 100 });
    const allSessions = all.sessions as unknown as Array<{ title: string }>;
    expect(
      allSessions.some((session) => session.title === "Foreign tenant session"),
    ).toBe(false);

    expect(() =>
      parseAdminQuery(
        new Request("https://programcue.test/api?status=not-real"),
        "sessions",
      ),
    ).toThrowError(expect.objectContaining({ status: 422 }));
  });

  it("executes every documented administration collection query", async () => {
    await ensureDemoProgramme(testEnv);
    await ensureDemoEvaluationData(testEnv);
    const service = new ApiAdministrationService(testEnv);
    for (const resource of [
      "submissions",
      "forms",
      "people",
      "speakers",
      "sessions",
      "schedule-versions",
      "decisions",
      "communications",
      "resources",
    ] as const) {
      const page = await service.list(principal, resource, { limit: 5 });
      const key =
        resource === "schedule-versions" ? "scheduleVersions" : resource;
      expect((page as unknown as Record<string, unknown>)[key]).toEqual(
        expect.any(Array),
      );
    }
  });

  it("returns effective form admission controls from collection and item reads", async () => {
    const opensAt = 1_900_000_000;
    const closesAt = opensAt + 86_400;
    const form = await testEnv.DB.prepare(
      `SELECT id FROM form_definitions
        WHERE event_id = ? ORDER BY id LIMIT 1`,
    )
      .bind(principal.eventId)
      .first<{ id: string }>();
    if (!form) throw new Error("The API form fixture is unavailable.");
    await testEnv.DB.prepare(
      `UPDATE form_definitions
          SET opens_at = ?, closes_at = ?, submission_limit = 12,
              per_person_submission_limit = 2
        WHERE id = ? AND event_id = ?`,
    )
      .bind(opensAt, closesAt, form.id, principal.eventId)
      .run();

    const collection = await new ApiAdministrationService(testEnv).list(
      principal,
      "forms",
      { limit: 100 },
    );
    expect(
      (collection.forms as Array<Record<string, unknown>>).find(
        (candidate) => candidate.id === form.id,
      ),
    ).toMatchObject({
      opensAt: new Date(opensAt * 1_000).toISOString(),
      closesAt: new Date(closesAt * 1_000).toISOString(),
      submissionLimit: 12,
      perPersonSubmissionLimit: 2,
    });

    const item = await new ApiAdministrationItemService(testEnv).get(
      principal,
      "forms",
      form.id,
    );
    expect(item.item).toMatchObject({
      opensAt: new Date(opensAt * 1_000).toISOString(),
      closesAt: new Date(closesAt * 1_000).toISOString(),
      submissionLimit: 12,
      perPersonSubmissionLimit: 2,
    });
  });

  it("returns every ordered submission track in collection and item records", async () => {
    const token = crypto.randomUUID();
    const submissionId = `api-multi-track-${token}`;
    const teamId = `api-routing-team-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO evaluation_teams (
           id, event_id, name, status, created_at, updated_at
         ) VALUES (?, ?, 'API routing team', 'active', unixepoch(), unixepoch())`,
      ).bind(teamId, principal.eventId),
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, format, status,
           answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'Multi-track API proposal', 'AI & Innovation',
                   'Presentation', 'submitted', '{}', '{"answers":{},"speakers":[]}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(submissionId, principal.eventId, `API-MULTI-${token}`),
      testEnv.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-ai', 'AI & Innovation', 0)`,
      ).bind(submissionId, principal.eventId),
      testEnv.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-operations', 'Event Operations', 1)`,
      ).bind(submissionId, principal.eventId),
      testEnv.DB.prepare(
        `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
         VALUES (?, ?, ?)`,
      ).bind(submissionId, principal.eventId, teamId),
    ]);
    try {
      const collection = (await new ApiAdministrationService(testEnv).list(
        principal,
        "submissions",
        { limit: 100 },
      )) as unknown as { submissions: Array<Record<string, unknown>> };
      expect(
        collection.submissions.find(
          (submission) => submission.id === submissionId,
        ),
      ).toMatchObject({
        routedTeamIds: [teamId],
        tracks: [
          { id: "demo-track-ai", name: "AI & Innovation", position: 0 },
          {
            id: "demo-track-operations",
            name: "Event Operations",
            position: 1,
          },
        ],
      });
      await expect(
        new ApiAdministrationItemService(testEnv).get(
          principal,
          "submissions",
          submissionId,
        ),
      ).resolves.toMatchObject({
        item: {
          routedTeamIds: [teamId],
          tracks: [
            { id: "demo-track-ai", name: "AI & Innovation", position: 0 },
            {
              id: "demo-track-operations",
              name: "Event Operations",
              position: 1,
            },
          ],
        },
      });
    } finally {
      await testEnv.DB.prepare(
        "DELETE FROM submissions WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, principal.eventId)
        .run();
      await testEnv.DB.prepare(
        "DELETE FROM evaluation_teams WHERE id = ? AND event_id = ?",
      )
        .bind(teamId, principal.eventId)
        .run();
    }
  });

  it("returns one deterministic, filter-consistent people membership", async () => {
    const suffix = crypto.randomUUID();
    const personId = `person-multi-role-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Multi role person', 1, 'published',
                   unixepoch(), unixepoch())`,
      ).bind(personId, `multi-role-${suffix}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, created_at
         ) VALUES (?, ?, NULL, ?, 'owner', 1700000000, 1700604800,
                   1700000100, 1700000000)`,
      ).bind(
        `membership-multi-role-owner-${suffix}`,
        principal.organisationId,
        personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', 1700000200, 1700605000,
                   1700000300, 1700000200)`,
      ).bind(
        `membership-multi-role-speaker-${suffix}`,
        principal.organisationId,
        principal.eventId,
        personId,
      ),
    ]);
    const service = new ApiAdministrationService(testEnv);

    const allPeople = (await service.list(principal, "people", {
      limit: 100,
    })) as unknown as { people: Array<Record<string, unknown>> };
    expect(
      allPeople.people.find((person) => person.id === personId),
    ).toMatchObject({
      role: "owner",
      invitedAt: "2023-11-14T22:13:20.000Z",
      acceptedAt: "2023-11-14T22:15:00.000Z",
    });

    const speakers = (await service.list(principal, "people", {
      limit: 100,
      role: "speaker",
    })) as unknown as { people: Array<Record<string, unknown>> };
    expect(
      speakers.people.find((person) => person.id === personId),
    ).toMatchObject({
      role: "speaker",
      invitedAt: "2023-11-14T22:16:40.000Z",
      acceptedAt: "2023-11-14T22:18:20.000Z",
    });
  });

  it("enforces each administration collection's least-privilege scope", async () => {
    await ensureDemoProgramme(testEnv);
    const suffix = crypto.randomUUID();
    const token = `pc_api_sessions_${suffix}`;
    await testEnv.DB.prepare(
      `INSERT INTO api_keys (
         id, organisation_id, event_id, name, key_prefix, key_hash,
         scopes_json, created_at
       ) VALUES (?, ?, ?, 'Sessions-only API key', 'pc_api_', ?,
                 '["sessions:read"]', unixepoch())`,
    )
      .bind(
        `api-sessions-key-${suffix}`,
        principal.organisationId,
        principal.eventId,
        await hash(token),
      )
      .run();
    const invoke = (resource: string) =>
      administrationResourceLoader({
        request: new Request(
          `https://programcue.test/api/v1/events/${principal.eventId}/${resource}?limit=2`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
        params: { eventId: principal.eventId, resource },
        context: routeContext(),
      } as never);
    expect((await invoke("sessions")).status).toBe(200);
    const denied = await invoke("forms");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "SCOPE_FORBIDDEN" },
    });
  });
});

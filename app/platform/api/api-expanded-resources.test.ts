import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import {
  ApiAdministrationService,
  parseAdminQuery,
} from "./api-administration-service.server";
import { ApiAdministrationItemService } from "./api-administration-item-service.server";
import { ApiEvaluationService } from "./api-evaluation-service.server";
import { ApiIntegrationService } from "./api-integration-service.server";
import {
  publicProgrammeResponse,
  publicSchedulePage,
  publicSessionPage,
  publicSessionQuerySchema,
} from "./api-public-programme.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  parseStrictQuery,
} from "./api-pagination.server";
import { ApiError, type ApiPrincipal } from "./api.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as administrationResourceLoader } from "~/routes/api-administration-resources";
import { action as evaluationResourceAction } from "~/routes/api-evaluation-resources";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicEventLoader } from "~/routes/api-public-event";
import { loader as publicScheduleLoader } from "~/routes/api-public-schedule";
import { loader as publicSessionsLoader } from "~/routes/api-public-sessions";
import { loader as publicSpeakersLoader } from "~/routes/api-public-speakers";

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

describe("expanded public API contract", () => {
  it("returns only published records with RFC 3339 timestamps and stable pagination", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2025",
    );
    expect(programme).not.toBeNull();
    const first = await publicSessionPage(programme!, {
      limit: 2,
    });
    expect(first.sessions).toHaveLength(2);
    expect(first.sessions[0]?.startsAt).toMatch(/Z$/u);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await publicSessionPage(programme!, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.sessions.map((session) => session.id)).not.toEqual(
      first.sessions.map((session) => session.id),
    );

    const filtered = publicProgrammeResponse(programme!, {
      speakerId: programme!.sessions[0]!.speakerIds[0],
    });
    expect(filtered.sessions.length).toBeGreaterThan(0);
    expect(
      filtered.sessions.every((session) =>
        session.speakerIds.includes(programme!.sessions[0]!.speakerIds[0]!),
      ),
    ).toBe(true);
    expect(filtered.version.publishedAt).toMatch(/Z$/u);
    expect(filtered.freshness.fetchedAt).toMatch(/Z$/u);
    expect(filtered).not.toHaveProperty("correlationId");
  });

  it("rejects unknown and repeated public filters", () => {
    expect(() =>
      parseStrictQuery(
        new Request("https://programcue.test/api?limit=2&limit=3"),
        publicSessionQuerySchema,
      ),
    ).toThrowError(
      expect.objectContaining({ status: 422, code: "VALIDATION_ERROR" }),
    );
    expect(() =>
      parseStrictQuery(
        new Request("https://programcue.test/api?unknown=true"),
        publicSessionQuerySchema,
      ),
    ).toThrowError(
      expect.objectContaining({ status: 422, code: "VALIDATION_ERROR" }),
    );
  });

  it("round-trips opaque cursors for valid non-ASCII record identifiers", () => {
    expect(
      decodePrivateCursor(encodePrivateCursor(1_725_000_000, "轮次-α")),
    ).toEqual({
      version: 1,
      sort: 1_725_000_000,
      id: "轮次-α",
    });
  });

  it("keeps every new cacheable route free of request-specific correlation data", async () => {
    await ensureDemoProgramme(testEnv);
    const routes = [
      { loader: publicEventLoader, suffix: "", key: "event" },
      {
        loader: publicSessionsLoader,
        suffix: "/sessions?limit=2",
        key: "sessions",
      },
      {
        loader: publicSpeakersLoader,
        suffix: "/speakers?limit=2",
        key: "speakers",
      },
      {
        loader: publicScheduleLoader,
        suffix: "/schedule?limit=2",
        key: "entries",
      },
    ] as const;
    for (const route of routes) {
      const response = await route.loader({
        request: new Request(
          `https://programcue.test/api/v1/public/events/future-of-events-2025${route.suffix}`,
          {
            headers: {
              "x-correlation-id": "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
            },
          },
        ),
        params: { slug: "future-of-events-2025" },
        context: routeContext(),
      } as never);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=300, stale-while-revalidate=60, must-revalidate",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const etag = response.headers.get("etag");
      expect(etag).toMatch(/^"program-cue-publication-/u);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty(route.key);
      expect(body).not.toHaveProperty("correlationId");
      expect(JSON.stringify(body)).not.toContain(
        "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
      );
      const revalidated = await route.loader({
        request: new Request(
          `https://programcue.test/api/v1/public/events/future-of-events-2025${route.suffix}`,
          { headers: { "if-none-match": etag! } },
        ),
        params: { slug: "future-of-events-2025" },
        context: routeContext(),
      } as never);
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(etag);
    }
  });

  it("changes the public validator when live published speaker content changes", async () => {
    await ensureDemoProgramme(testEnv);
    const url =
      "https://programcue.test/api/v1/public/events/future-of-events-2025/speakers?limit=100";
    const initial = await publicSpeakersLoader({
      request: new Request(url),
      params: { slug: "future-of-events-2025" },
      context: routeContext(),
    } as never);
    const initialBody = (await initial.json()) as {
      speakers: Array<{ id: string; displayName: string }>;
    };
    const target = initialBody.speakers[0]!;
    const original = await testEnv.DB.prepare(
      `SELECT display_name AS displayName, profile_revision AS revision,
              updated_at AS updatedAt
         FROM people WHERE id = ?`,
    )
      .bind(target.id)
      .first<{ displayName: string; revision: number; updatedAt: number }>();
    expect(original).not.toBeNull();
    const changedName = `${original!.displayName} revised`;
    try {
      await testEnv.DB.prepare(
        `UPDATE people SET display_name = ?, profile_revision = profile_revision + 1,
                           updated_at = updated_at + 1
          WHERE id = ?`,
      )
        .bind(changedName, target.id)
        .run();
      const revalidated = await publicSpeakersLoader({
        request: new Request(url, {
          headers: { "if-none-match": initial.headers.get("etag")! },
        }),
        params: { slug: "future-of-events-2025" },
        context: routeContext(),
      } as never);
      expect(revalidated.status).toBe(200);
      expect(revalidated.headers.get("etag")).not.toBe(
        initial.headers.get("etag"),
      );
      await expect(revalidated.json()).resolves.toMatchObject({
        speakers: expect.arrayContaining([
          expect.objectContaining({ id: target.id, displayName: changedName }),
        ]),
      });
    } finally {
      await testEnv.DB.prepare(
        `UPDATE people SET display_name = ?, profile_revision = ?, updated_at = ?
          WHERE id = ?`,
      )
        .bind(
          original!.displayName,
          original!.revision,
          original!.updatedAt,
          target.id,
        )
        .run();
    }
  });

  it("keeps the D1 validator stable when only wall-clock time advances", async () => {
    await ensureDemoProgramme(testEnv);
    const url =
      "https://programcue.test/api/v1/public/events/future-of-events-2025/speakers?limit=100";
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-10T10:00:00Z"));
    try {
      const initial = await publicSpeakersLoader({
        request: new Request(url),
        params: { slug: "future-of-events-2025" },
        context: routeContext(),
      } as never);
      const initialEtag = initial.headers.get("etag");
      expect(initialEtag).toMatch(/^"program-cue-publication-/u);

      clock.mockReturnValue(Date.parse("2026-08-10T12:00:00Z"));
      const revalidated = await publicSpeakersLoader({
        request: new Request(url, {
          headers: { "if-none-match": initialEtag! },
        }),
        params: { slug: "future-of-events-2025" },
        context: routeContext(),
      } as never);
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(initialEtag);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects undeclared calendar-feed query parameters in the API envelope", async () => {
    const response = await publicCalendarLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/future-of-events-2025/calendar.ics?unexpected=true",
      ),
      params: { slug: "future-of-events-2025" },
      context: routeContext(),
    } as never);
    expect(response.status).toBe(422);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
      correlationId: expect.any(String),
    });
  });
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

  it("returns every ordered submission track in collection and item records", async () => {
    const token = crypto.randomUUID();
    const submissionId = `api-multi-track-${token}`;
    await testEnv.DB.batch([
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

describe("evaluation and integration API reads", () => {
  it("returns multi-round evaluation resources with criteria and private review state", async () => {
    await ensureDemoEvaluationData(testEnv);
    const service = new ApiEvaluationService(testEnv);
    const rounds = await service.list(principal, "rounds", { limit: 20 });
    const roundRecords = rounds.rounds as unknown as Array<{
      createdAt: string;
      criteria: unknown[];
      advancementRule: Record<string, unknown>;
    }>;
    expect(roundRecords.length).toBeGreaterThan(0);
    expect(roundRecords[0]).toMatchObject({
      criteria: expect.any(Array),
      advancementRule: expect.any(Object),
    });
    expect(roundRecords[0]?.createdAt).toMatch(/Z$/u);
    const assignments = await service.list(principal, "assignments", {
      limit: 20,
    });
    const assignmentRecords = assignments.assignments as unknown as Array<{
      evaluatorPersonId: string;
    }>;
    expect(assignmentRecords.length).toBeGreaterThan(0);
    expect(assignmentRecords[0]).toHaveProperty("evaluatorPersonId");
    for (const resource of [
      "plans",
      "teams",
      "reviews",
      "conflicts",
      "moderations",
    ] as const) {
      const page = await service.list(principal, resource, { limit: 10 });
      expect((page as unknown as Record<string, unknown>)[resource]).toEqual(
        expect.any(Array),
      );
    }
  });

  it("never returns encrypted integration credentials and scopes child records through the connection event", async () => {
    const suffix = crypto.randomUUID();
    const connectionId = `api-connection-${suffix}`;
    const runId = `api-run-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO integration_connections (
          id, organisation_id, event_id, provider, status, direction,
          encrypted_credentials, configuration_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                  'secret-ciphertext', '{"externalEventId":"event-1"}',
                  unixepoch(), unixepoch())`,
      ).bind(connectionId, principal.organisationId, principal.eventId),
      testEnv.DB.prepare(
        `INSERT INTO integration_runs (
          id, connection_id, idempotency_key, status, direction, dry_run,
          summary_json, created_at
        ) VALUES (?, ?, ?, 'succeeded', 'outbound', 1,
                  '{"total":1}', unixepoch())`,
      ).bind(runId, connectionId, `api-run-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO integration_run_items (
          id, run_id, entity_type, entity_id, action, status, diff_json,
          updated_at
        ) VALUES (?, ?, 'session', ?, 'create', 'succeeded',
                  '{"title":"Example"}', unixepoch())`,
      ).bind(`api-run-item-${suffix}`, runId, `session-${suffix}`),
    ]);
    const service = new ApiIntegrationService(testEnv);
    const connections = await service.list(principal, "connections", {
      limit: 10,
    });
    const connectionRecords = connections.connections as unknown as Array<
      Record<string, unknown> & { id: string }
    >;
    const connection = connectionRecords.find(
      (record) => record.id === connectionId,
    );
    expect(connection).toMatchObject({
      hasCredentials: true,
      configuration: { externalEventId: "event-1" },
    });
    expect(connection).not.toHaveProperty("encryptedCredentials");
    expect(connection).not.toHaveProperty("encrypted_credentials");

    const items = await service.list(principal, "run-items", {
      limit: 10,
      runId,
    });
    expect(items.runItems).toEqual([
      expect.objectContaining({
        runId,
        diff: { title: "Example" },
      }),
    ]);
  });

  it("rejects a cursor from a changed public collection, filter, or resource", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2025",
    );
    const page = await publicSessionPage(programme!, { limit: 1 });
    await expect(
      publicSessionPage(
        {
          ...programme!,
          sessions: programme!.sessions.map((session, index) =>
            index === 0
              ? { ...session, title: `${session.title} changed` }
              : session,
          ),
        },
        { limit: 1, cursor: page.nextCursor! },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        status: 409,
        code: "PUBLICATION_CHANGED",
      } satisfies Partial<ApiError>),
    );
    await expect(
      publicSessionPage(programme!, {
        limit: 1,
        cursor: page.nextCursor!,
        q: "different filter",
      }),
    ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
    await expect(
      publicSchedulePage(programme!, {
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
  });

  it("keeps public cursors stable across freshness-only cache changes", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2025",
    );
    const airtableProgramme = {
      ...programme!,
      freshness: {
        source: "airtable" as const,
        fetchedAt: programme!.freshness.fetchedAt,
        cacheExpiresAt: programme!.freshness.fetchedAt + 60,
        cached: false as const,
      },
    };
    const first = await publicSessionPage(airtableProgramme, { limit: 1 });
    const second = await publicSessionPage(
      {
        ...airtableProgramme,
        contentRevision: `${programme!.contentRevision}-freshness-changed`,
        freshness: {
          ...airtableProgramme.freshness,
          cached: true as const,
        },
      },
      { limit: 1, cursor: first.nextCursor! },
    );
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.id).not.toBe(first.sessions[0]?.id);
  });

  it("executes a strict, audited and exactly replayable plan command through the API route", async () => {
    const suffix = crypto.randomUUID();
    const eventId = `api-evaluation-event-${suffix}`;
    const token = `pc_api_evaluation_${suffix}`;
    const keyId = `api-evaluation-key-${suffix}`;
    const sessionId = `api-evaluation-session-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'API evaluation event', ?, 'UTC',
                  2000000000, 2000086400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(eventId, principal.organisationId, `api-evaluation-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO api_keys (
          id, organisation_id, event_id, name, key_prefix, key_hash,
          scopes_json, created_at
        ) VALUES (?, ?, ?, 'Evaluation route key', 'pc_api_', ?,
                  '["evaluation:write"]', unixepoch())`,
      ).bind(keyId, principal.organisationId, eventId, await hash(token)),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at,
           invited_at, created_at
         ) VALUES (?, ?, ?, 'person-demo-evaluator', 'evaluator', unixepoch(),
                   unixepoch(), unixepoch())`,
      ).bind(
        `api-evaluation-membership-${suffix}`,
        principal.organisationId,
        eventId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, revision, created_at, updated_at
         ) VALUES (?, ?, 'API direct session', ?, 'Frozen API evidence',
                   'workshop', 60, 'unscheduled', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, `api-direct-session-${suffix}`),
    ]);
    const context = routeContext();
    const body = {
      revision: 0,
      name: "API review plan",
      status: "active",
      decisionRole: "administrator",
      rounds: [
        {
          id: `api-round-${suffix}`,
          name: "First review",
          dueAt: null,
          anonymous: false,
          criteria: [
            {
              id: `api-criterion-${suffix}`,
              name: "Programme fit",
              description: "Fit for this event.",
              inputType: "scale_5",
              weightPercent: 100,
              required: true,
              position: 0,
            },
          ],
        },
      ],
    };
    const invoke = (value: unknown) =>
      evaluationResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/plans`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": `evaluation-plan-${suffix}`,
            },
            body: JSON.stringify(value),
          },
        ),
        params: { eventId, resource: "plans" },
        context,
      } as never);
    const { decisionRole: _decisionRole, ...withoutDecisionRole } = body;
    const missingDecisionRole = await invoke(withoutDecisionRole);
    expect(missingDecisionRole.status).toBe(422);
    await expect(missingDecisionRole.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const { anonymous: _anonymous, ...roundWithoutAnonymous } = body.rounds[0]!;
    const missingAnonymous = await invoke({
      ...body,
      rounds: [roundWithoutAnonymous],
    });
    expect(missingAnonymous.status).toBe(422);
    await expect(missingAnonymous.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const first = await invoke(body);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { planId: string };
    const replay = await invoke(body);
    await expect(replay.json()).resolves.toMatchObject({
      planId: firstBody.planId,
    });
    const conflict = await invoke({ ...body, name: "Changed request" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "EVALUATION_REVISION_CONFLICT" },
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT actor_person_id AS actorPersonId, actor_id AS actorId
           FROM audit_events
          WHERE action = 'evaluation.plan.saved' AND entity_id = ?`,
      )
        .bind(firstBody.planId)
        .first(),
    ).resolves.toEqual({
      actorPersonId: null,
      actorId: `api_key:${keyId}`,
    });

    const assignmentBody = {
      roundId: body.rounds[0]!.id,
      targetType: "session",
      targetIds: [sessionId],
      evaluatorPersonIds: ["person-demo-evaluator"],
      teamId: null,
    };
    const invokeAssignment = (value: unknown, idempotencyKey: string) =>
      evaluationResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/assignments`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(value),
          },
        ),
        params: { eventId, resource: "assignments" },
        context,
      } as never);
    const assignmentResponse = await invokeAssignment(
      assignmentBody,
      `evaluation-assignment-${suffix}`,
    );
    expect(assignmentResponse.status).toBe(200);
    await expect(assignmentResponse.json()).resolves.toMatchObject({
      createdAssignmentCount: 1,
      requestedAssignmentCount: 1,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT submission_id AS submissionId, session_id AS sessionId,
                json_extract(session_snapshot_json, '$.title') AS snapshotTitle
           FROM evaluator_assignments
          WHERE event_id = ? AND session_id = ?`,
      )
        .bind(eventId, sessionId)
        .first(),
    ).resolves.toEqual({
      submissionId: null,
      sessionId,
      snapshotTitle: "API direct session",
    });
    const assignmentPage = await new ApiEvaluationService(testEnv).list(
      { ...principal, eventId },
      "assignments",
      { limit: 10, targetType: "session", targetId: sessionId },
    );
    expect(assignmentPage.assignments).toEqual([
      expect.objectContaining({
        targetType: "session",
        targetId: sessionId,
        targetTitle: "API direct session",
      }),
    ]);
    const legacyAssignment = await invokeAssignment(
      {
        roundId: body.rounds[0]!.id,
        submissionIds: [sessionId],
        evaluatorPersonIds: ["person-demo-evaluator"],
      },
      `legacy-evaluation-assignment-${suffix}`,
    );
    expect(legacyAssignment.status).toBe(422);

    const unknown = await invoke({ ...body, unsupported: true });
    expect(unknown.status).toBe(422);
  });
});

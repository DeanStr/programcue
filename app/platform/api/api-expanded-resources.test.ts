import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import { EventService } from "~/modules/events/event-service.server";
import { FileService } from "~/modules/files/file-service.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import {
  PUBLIC_CALENDAR_SESSION_ID_LIMIT,
  PUBLIC_CALENDAR_SESSION_LIMIT,
  publicCalendarQuerySchema,
  publicProgrammeResponse,
  publicSessionPage,
  publicSessionQuerySchema,
} from "./api-public-programme.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  parseStrictQuery,
} from "./api-pagination.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicEventLoader } from "~/routes/api-public-event";
import { loader as publicScheduleLoader } from "~/routes/api-public-schedule";
import { loader as publicSessionsLoader } from "~/routes/api-public-sessions";
import { loader as publicSpeakersLoader } from "~/routes/api-public-speakers";

const testEnv = env as unknown as CloudflareEnvironment;

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
      "future-of-events-2027",
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

  it("accepts the documented maximum calendar session selection", () => {
    const sessions = Array.from(
      { length: PUBLIC_CALENDAR_SESSION_LIMIT },
      (_, index) => `${index}-`.padEnd(PUBLIC_CALENDAR_SESSION_ID_LIMIT, "x"),
    ).join(",");
    const requestUrl = new URL("https://programcue.test/api");
    requestUrl.searchParams.set("sessions", sessions);

    expect(
      parseStrictQuery(new Request(requestUrl), publicCalendarQuerySchema),
    ).toEqual({ sessions });
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

  it("uses database keyset cursors for public session pages", async () => {
    await ensureDemoProgramme(testEnv);
    const fullSnapshot = vi.spyOn(
      PublicProgrammeService.prototype,
      "getPublished",
    );
    const base =
      "https://programcue.test/api/v1/public/events/future-of-events-2027/sessions?limit=2";
    const firstResponse = await publicSessionsLoader({
      request: new Request(base),
      params: { slug: "future-of-events-2027" },
      context: routeContext(),
    } as never);
    const first = (await firstResponse.json()) as {
      sessions: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(fullSnapshot).not.toHaveBeenCalled();

    const nextUrl = new URL(base);
    nextUrl.searchParams.set("cursor", first.nextCursor);
    const secondResponse = await publicSessionsLoader({
      request: new Request(nextUrl),
      params: { slug: "future-of-events-2027" },
      context: routeContext(),
    } as never);
    const second = (await secondResponse.json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(second.sessions).toHaveLength(2);
    expect(second.sessions.map((session) => session.id)).not.toEqual(
      first.sessions.map((session) => session.id),
    );

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE events SET description = COALESCE(description, '') || ' revised'
          WHERE id = 'evt-foe-2025'`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, created_at
         ) VALUES ('evt-foe-2025', 'event', 'evt-foe-2025',
                   'updated', unixepoch())`,
      ),
    ]);
    const stale = await publicSessionsLoader({
      request: new Request(nextUrl),
      params: { slug: "future-of-events-2027" },
      context: routeContext(),
    } as never);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "PUBLICATION_CHANGED" },
    });
    fullSnapshot.mockRestore();
  });

  it("advances the persisted public projection revision for every public change category", async () => {
    await ensureDemoProgramme(testEnv);
    const base =
      "https://programcue.test/api/v1/public/events/future-of-events-2027/sessions?limit=2";
    const nextCursor = async () => {
      const response = await publicSessionsLoader({
        request: new Request(base),
        params: { slug: "future-of-events-2027" },
        context: routeContext(),
      } as never);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { nextCursor: string };
      expect(body.nextCursor).toEqual(expect.any(String));
      return body.nextCursor;
    };
    const expectStale = async (cursor: string) => {
      const url = new URL(base);
      url.searchParams.set("cursor", cursor);
      const response = await publicSessionsLoader({
        request: new Request(url),
        params: { slug: "future-of-events-2027" },
        context: routeContext(),
      } as never);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "PUBLICATION_CHANGED" },
      });
    };
    const revision = async () => {
      const row = await testEnv.DB.prepare(
        `SELECT public_projection_revision AS revision
           FROM events WHERE id = 'evt-foe-2025'`,
      ).first<{ revision: number }>();
      expect(row).not.toBeNull();
      return row!.revision;
    };
    const expectMutationInvalidates = async (
      mutate: () => Promise<unknown>,
    ) => {
      const cursor = await nextCursor();
      const before = await revision();
      await mutate();
      expect(await revision()).toBeGreaterThan(before);
      await expectStale(cursor);
    };

    const unchangedCursor = await nextCursor();
    const beforeUnrelated = await revision();
    await testEnv.DB.prepare(
      `INSERT INTO event_changes (
         event_id, entity_type, entity_id, change_type, created_at
       ) VALUES ('evt-foe-2025', 'task_instance', 'unrelated-task',
                 'updated', unixepoch())`,
    ).run();
    expect(await revision()).toBe(beforeUnrelated);
    const unchangedUrl = new URL(base);
    unchangedUrl.searchParams.set("cursor", unchangedCursor);
    expect(
      (
        await publicSessionsLoader({
          request: new Request(unchangedUrl),
          params: { slug: "future-of-events-2027" },
          context: routeContext(),
        } as never)
      ).status,
    ).toBe(200);

    const headshotAssetId = `public-revision-headshot-${crypto.randomUUID()}`;
    const headshotVersionId = `public-revision-version-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, target_type, target_id, asset_kind, status,
           created_at, updated_at
         ) VALUES (?, 'evt-foe-2025', 'person', 'person-demo-speaker',
                   'headshot', 'pending', unixepoch(), unixepoch())`,
      ).bind(headshotAssetId),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           released_at, created_at
         ) VALUES (?, 'evt-foe-2025', ?, 1, ?, 'headshot.webp',
                   'image/webp', 'image/webp', 100, 'uploaded', 'valid',
                   'clean', unixepoch(), unixepoch())`,
      ).bind(
        headshotVersionId,
        headshotAssetId,
        `tests/${headshotVersionId}.webp`,
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets
            SET status = 'active', current_version_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = 'evt-foe-2025'`,
      ).bind(headshotVersionId, headshotAssetId),
    ]);

    await expectMutationInvalidates(async () => {
      const viewer = {
        personId: "person-demo-admin",
        name: "Olivia Bennett",
        email: "olivia@example.com",
        role: "administrator" as const,
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
        demo: true,
      };
      const service = new EventService(testEnv);
      const setup = await service.getSetup(viewer);
      return service.saveSetup(viewer, {
        revision: setup.revision,
        name: setup.name,
        timezone: setup.timezone,
        startDate: setup.startDate,
        endDate: setup.endDate,
        venue: setup.venue,
        venueAddress: setup.venueAddress,
        venueMapUrl: setup.venueMapUrl,
        city: setup.city,
        publicSlug: setup.publicSlug,
        brandAccent: setup.brandAccent,
        programmeHeroImageUrl: setup.programmeHeroImageUrl,
        participantLogoUrl: setup.participantLogoUrl,
        participantWelcomeText: setup.participantWelcomeText,
        participantSupportUrl: setup.participantSupportUrl,
        description: `${setup.description} revised`,
        repositoryProvider: setup.repositoryProvider,
        retentionMonths: setup.retentionMonths,
        submissionAccessMode: setup.submissionAccessMode,
        allowAnonymousDrafts: setup.allowAnonymousDrafts,
        duplicatePersonWarnings: setup.duplicatePersonWarnings,
        filePolicy: setup.filePolicy,
        rooms: setup.rooms.map((room, index) =>
          index === 0 ? { ...room, name: `${room.name} revised` } : room,
        ),
        tracks: setup.tracks.map((track, index) =>
          index === 0 ? { ...track, name: `${track.name} revised` } : track,
        ),
        sessionFormats: setup.sessionFormats,
      });
    });
    const recordPublicChange = (entityType: string, entityId: string) =>
      testEnv.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, created_at
         ) VALUES ('evt-foe-2025', ?, ?, 'updated', unixepoch())`,
      )
        .bind(entityType, entityId)
        .run();
    await expectMutationInvalidates(() =>
      recordPublicChange("schedule_version", "demo-schedule-published"),
    );
    await expectMutationInvalidates(() =>
      recordPublicChange("session", "demo-session-1"),
    );
    await expectMutationInvalidates(() =>
      recordPublicChange("person", "person-demo-speaker"),
    );
    await expectMutationInvalidates(() =>
      recordPublicChange("file_version", headshotVersionId),
    );
    await expectMutationInvalidates(() =>
      new FileService(testEnv).eraseAsset(
        {
          personId: "person-demo-admin",
          name: "Olivia Bennett",
          email: "olivia@example.com",
          role: "administrator",
          organisationId: "org-future-events",
          eventId: "evt-foe-2025",
          demo: true,
        },
        { assetId: headshotAssetId, confirmed: true },
      ),
    );
  });

  it("rejects unapproving a snapshot already exposed by the public collection", async () => {
    await ensureDemoProgramme(testEnv);
    await expect(
      testEnv.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = 'in_review', approved_by_person_id = NULL,
                approved_at = NULL, approval_source = NULL
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025' AND session_id = 'demo-session-1'`,
      ).run(),
    ).rejects.toThrow(/cannot lose approval/i);
    const response = await publicSessionsLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/future-of-events-2027/sessions",
      ),
      params: { slug: "future-of-events-2027" },
      context: routeContext(),
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: "demo-session-1" }),
      ]),
    });
  });

  it("does not expose a speaker through a private-session filter", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2027",
    );
    const speaker = programme?.speakers[0];
    expect(speaker).toBeDefined();
    const privateSessionId = `private-filter-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, track_id, title, slug, description, format,
         duration_minutes, expected_attendance, required_resources_json,
         status, visibility, revision, created_at, updated_at
       )
       SELECT ?, event_id, track_id, 'Private filter session', ?, NULL, format,
              duration_minutes, expected_attendance, required_resources_json,
              'published', 'private', 1, unixepoch(), unixepoch()
         FROM sessions WHERE id = ? AND event_id = ?`,
    )
      .bind(
        privateSessionId,
        privateSessionId,
        programme!.sessions[0]!.id,
        programme!.event.id,
      )
      .run();
    try {
      await testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
      )
        .bind(privateSessionId, programme!.event.id, speaker!.id)
        .run();
      const url = new URL(
        "https://programcue.test/api/v1/public/events/future-of-events-2027/speakers",
      );
      url.searchParams.set("sessionId", privateSessionId);
      url.searchParams.set("limit", "100");
      const response = await publicSpeakersLoader({
        request: new Request(url),
        params: { slug: "future-of-events-2027" },
        context: routeContext(),
      } as never);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ speakers: [] });
    } finally {
      await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(privateSessionId)
        .run();
    }
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
          `https://programcue.test/api/v1/public/events/future-of-events-2027${route.suffix}`,
          {
            headers: {
              "x-correlation-id": "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
            },
          },
        ),
        params: { slug: "future-of-events-2027" },
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
          `https://programcue.test/api/v1/public/events/future-of-events-2027${route.suffix}`,
          { headers: { "if-none-match": etag! } },
        ),
        params: { slug: "future-of-events-2027" },
        context: routeContext(),
      } as never);
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(etag);
    }
  });

  it("changes the public validator when live published speaker content changes", async () => {
    await ensureDemoProgramme(testEnv);
    const url =
      "https://programcue.test/api/v1/public/events/future-of-events-2027/speakers?limit=100";
    const initial = await publicSpeakersLoader({
      request: new Request(url),
      params: { slug: "future-of-events-2027" },
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
        params: { slug: "future-of-events-2027" },
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
      "https://programcue.test/api/v1/public/events/future-of-events-2027/speakers?limit=100";
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-10T10:00:00Z"));
    try {
      const initial = await publicSpeakersLoader({
        request: new Request(url),
        params: { slug: "future-of-events-2027" },
        context: routeContext(),
      } as never);
      const initialEtag = initial.headers.get("etag");
      expect(initialEtag).toMatch(/^"program-cue-publication-/u);

      clock.mockReturnValue(Date.parse("2026-08-10T12:00:00Z"));
      const revalidated = await publicSpeakersLoader({
        request: new Request(url, {
          headers: { "if-none-match": initialEtag! },
        }),
        params: { slug: "future-of-events-2027" },
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
        "https://programcue.test/api/v1/public/events/future-of-events-2027/calendar.ics?unexpected=true",
      ),
      params: { slug: "future-of-events-2027" },
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

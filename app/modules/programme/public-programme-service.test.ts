import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicProgrammeLoader } from "~/routes/api-public-programme";
import {
  action as publicProgrammePageAction,
  descriptionSnippet,
  itineraryCookie,
  loader as publicProgrammePageLoader,
} from "~/routes/public-programme";
import {
  assertPublishedSpeakerGraphIntegrity,
  PublicProgrammeService,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSnapshotInvariantError,
  PublishedProgrammeSpeakerInvariantError,
  readCookie,
} from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an empty shared-itinerary token instead of loading private state", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const rejected = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2025?share=",
      ),
      params: { slug: "future-of-events-2025" },
      context,
    } as never).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(404);
    await expect((rejected as Response).text()).resolves.toBe(
      "This shared itinerary is unavailable or empty.",
    );
  });

  it("returns the public calendar 404 in the versioned API error envelope", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000404";
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const response = await publicCalendarLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/not-published/calendar.ics",
        { headers: { "x-correlation-id": correlationId } },
      ),
      params: { slug: "not-published" },
      context,
    } as never);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "EVENT_NOT_FOUND",
        message: "Published event programme not found",
      },
      correlationId,
    });
  });

  it("keeps request-specific correlation data out of the cacheable response", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const response = await publicProgrammeLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/future-of-events-2025/programme",
        { headers: { "x-correlation-id": "caller-specific-value" } },
      ),
      params: { slug: "future-of-events-2025" },
      context,
    } as never);
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60, must-revalidate",
    );
    expect(response.headers.get("etag")).toMatch(/^"program-cue-publication-/u);
    const body = await response.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("correlationId");
    expect(JSON.stringify(body)).not.toContain("caller-specific-value");
  });

  it("serves explicit static JSON and HTML programme exports", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const args = (format: string) =>
      ({
        request: new Request(
          `https://programcue.test/api/v1/public/events/future-of-events-2025/programme?format=${format}`,
        ),
        params: { slug: "future-of-events-2025" },
        context,
      }) as never;

    const json = await publicProgrammeLoader(args("json"));
    expect(json.headers.get("content-disposition")).toContain(
      "future-of-events-2025-programme.json",
    );
    await expect(json.json()).resolves.toMatchObject({
      sessions: expect.any(Array),
      speakers: expect.any(Array),
      freshness: expect.objectContaining({ source: "d1" }),
    });

    const html = await publicProgrammeLoader(args("html"));
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-disposition")).toContain(
      "future-of-events-2025-programme.html",
    );
    expect(await html.text()).toContain("<!doctype html>");

    const invalid = await publicProgrammeLoader(args("xml"));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "INVALID_EXPORT_FORMAT" },
    });
  });

  it("returns only the current published schedule version", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme?.version.id).toBe("demo-schedule-published");
    expect(programme?.event).toMatchObject({
      startDate: "2025-05-20",
      endDate: "2025-05-22",
    });
    expect(programme?.event).not.toHaveProperty("startsAt");
    expect(programme?.event).not.toHaveProperty("endsAt");
    expect(programme?.freshness).toMatchObject({
      source: "d1",
      cacheExpiresAt: null,
      cached: false,
    });
    expect(programme?.sessions).toHaveLength(5);
    expect(programme?.speakers.length).toBeGreaterThan(0);
    expect(programme?.speakers[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        displayName: expect.any(String),
        sessionIds: expect.any(Array),
      }),
    );
    expect(programme?.speakers[0]).not.toHaveProperty("email");
    expect(
      programme?.sessions.every((session) => session.speakerNames.length > 0),
    ).toBe(true);
    expect(() =>
      assertPublishedSpeakerGraphIntegrity(
        programme!.version.id,
        [
          {
            ...programme!.sessions[0],
            speakerIds: [
              ...programme!.sessions[0].speakerIds,
              "missing-person",
            ],
            speakerNames: [
              ...programme!.sessions[0].speakerNames,
              "Missing Person",
            ],
          },
          ...programme!.sessions.slice(1),
        ],
        programme!.speakers,
      ),
    ).toThrow(PublishedProgrammeSpeakerInvariantError);

    const publicSessionId = programme!.sessions[0].id;
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES ('programme-speaker-late', 'programme-speaker-late@example.com',
          'Later Co-speaker', 1, 'published', unixepoch(), unixepoch())
      `),
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES ('programme-speaker-early', 'programme-speaker-early@example.com',
          'Earlier || Co-speaker', 1, 'published', unixepoch(), unixepoch())
      `),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (session_id, event_id, person_id, position, visibility)
        VALUES (?, 'evt-foe-2025', 'programme-speaker-late', 20, 'public')
      `,
      ).bind(publicSessionId),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (session_id, event_id, person_id, position, visibility)
        VALUES (?, 'evt-foe-2025', 'programme-speaker-early', 10, 'public')
      `,
      ).bind(publicSessionId),
    ]);
    const orderedSession = (await service.getPublished(
      "future-of-events-2025",
    ))!.sessions.find((session) => session.id === publicSessionId)!;
    expect(orderedSession.speakerIds.slice(-2)).toEqual([
      "programme-speaker-early",
      "programme-speaker-late",
    ]);
    expect(orderedSession.speakerNames.slice(-2)).toEqual([
      "Earlier || Co-speaker",
      "Later Co-speaker",
    ]);

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (
          'programme-draft-speaker', 'programme-draft-speaker@example.com',
          'Private Draft Speaker', 1, 'draft', unixepoch(), unixepoch()
        )
      `),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, visibility
        ) VALUES (?, 'evt-foe-2025', 'programme-draft-speaker', 99, 'public')
      `,
      ).bind(publicSessionId),
    ]);
    const withoutPrivateProfile = await service.getPublished(
      "future-of-events-2025",
    );
    const publicSession = withoutPrivateProfile!.sessions.find(
      (session) => session.id === publicSessionId,
    )!;
    expect(publicSession.speakerIds).not.toContain("programme-draft-speaker");
    expect(publicSession.speakerNames).not.toContain("Private Draft Speaker");
    expect(publicSession.speakerIds).toHaveLength(
      publicSession.speakerNames.length,
    );

    await env.DB.prepare(
      `INSERT INTO sessions (id, event_id, title, slug, format, duration_minutes, status, visibility, revision, created_at, updated_at) VALUES ('private-unpublished-session', 'evt-foe-2025', 'Private draft', 'private-draft', 'other', 30, 'unscheduled', 'private', 1, unixepoch(), unixepoch())`,
    ).run();
    expect(
      (await service.getPublished("future-of-events-2025"))?.sessions.some(
        (session) => session.id === "private-unpublished-session",
      ),
    ).toBe(false);
  });

  it("does not expose stale publication state for an inactive event", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      `UPDATE events SET activation_status = 'provisioning_failed'
        WHERE id = 'evt-foe-2025'`,
    ).run();

    try {
      await expect(
        service.getPublished("future-of-events-2025"),
      ).resolves.toBeNull();
    } finally {
      await env.DB.prepare(
        `UPDATE events SET activation_status = 'active'
          WHERE id = 'evt-foe-2025'`,
      ).run();
    }
  });

  it("returns a bounded CFP speaker preview without exposing programme internals", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const withoutSpeakers = await service.getPublishedLandingSummary(
      "future-of-events-2025",
      0,
    );
    expect(withoutSpeakers).toEqual({ speakers: [] });

    const preview = await service.getPublishedLandingSummary(
      "future-of-events-2025",
      1,
    );
    expect(preview?.speakers).toHaveLength(1);
    expect(preview?.speakers[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
    });
    expect(Object.keys(preview!.speakers[0]!).sort()).toEqual([
      "displayName",
      "id",
      "imageUrl",
      "jobTitle",
      "organisationName",
    ]);
    expect(preview?.speakers[0]).not.toHaveProperty("biography");
    expect(preview?.speakers[0]).not.toHaveProperty("sessionIds");
    await expect(
      service.getPublishedLandingSummary("future-of-events-2025", 9),
    ).rejects.toThrow(RangeError);
  });

  it("does not fall back to D1 when the authoritative Airtable repository is unavailable", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await service.getPublished("future-of-events-2025");
    const suffix = crypto.randomUUID();
    const eventId = `airtable-public-${suffix}`;
    const versionId = `airtable-public-version-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           repository_provider, activation_status, programme_published_at, revision,
           file_policy_json, created_at, updated_at
         ) VALUES (?, 'org-future-events', 'Airtable public test', ?, 'UTC',
                   4070908800, 4070995200, 'airtable', 'provisioning',
                   unixepoch(), 1,
                   '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}',
                   unixepoch(), unixepoch())`,
      ).bind(eventId, eventId),
      env.DB.prepare(
        `UPDATE events
            SET activation_status = 'active', repository_locked_at = unixepoch()
          WHERE id = ? AND activation_status = 'provisioning'`,
      ).bind(eventId),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
           id, event_id, version_number, status, revision, created_at,
           published_at
         ) VALUES (?, ?, 1, 'published', 1, unixepoch(), unixepoch())`,
      ).bind(versionId, eventId),
    ]);

    await expect(service.getPublished(eventId)).rejects.toThrow(
      /configure and validate an airtable repository/i,
    );
  });

  it("fails fast instead of silently omitting published entries whose content snapshot is missing", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const entry = await env.DB.prepare(
      `SELECT session_id AS sessionId
         FROM schedule_entries
        WHERE event_id = 'evt-foe-2025'
          AND schedule_version_id = 'demo-schedule-published'
        LIMIT 1`,
    ).first<{ sessionId: string }>();
    expect(entry).not.toBeNull();
    await env.DB.prepare(
      `DELETE FROM schedule_session_contents
        WHERE schedule_version_id = 'demo-schedule-published'
          AND event_id = 'evt-foe-2025' AND session_id = ?`,
    )
      .bind(entry!.sessionId)
      .run();

    try {
      await expect(
        service.getPublished("future-of-events-2025"),
      ).rejects.toBeInstanceOf(PublishedProgrammeSnapshotInvariantError);
      await expect(
        service.getPublishedLandingSummary("future-of-events-2025", 8),
      ).rejects.toBeInstanceOf(PublishedProgrammeSnapshotInvariantError);
    } finally {
      await env.DB.prepare(
        `INSERT INTO schedule_session_contents (
           schedule_version_id, event_id, session_id, title, slug,
           description, track_id, format, duration_minutes,
           required_resources_json, visibility, created_at, updated_at
         )
         SELECT 'demo-schedule-published', event_id, id, title, slug,
                description, track_id, format, duration_minutes,
                required_resources_json, visibility, unixepoch(), unixepoch()
           FROM sessions WHERE id = ? AND event_id = 'evt-foe-2025'`,
      )
        .bind(entry!.sessionId)
        .run();
    }
  });

  it("rejects duplicate event slugs across organisations and keeps public lookup stable", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const before = await service.getPublished("future-of-events-2025");
    expect(before?.event.id).toBe("evt-foe-2025");

    await env.DB.prepare(
      `
      INSERT INTO organisations (id, name, slug)
      VALUES ('programme-collision-org', 'Collision Org', 'programme-collision-org')
    `,
    ).run();
    await expect(
      env.DB.prepare(
        `
      INSERT INTO events (id, organisation_id, name, slug, timezone, starts_at, ends_at, file_policy_json)
      VALUES ('programme-collision-event', 'programme-collision-org', 'Collision Event',
              'future-of-events-2025', 'UTC', 100, 200,
              '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
    `,
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed: events\.slug/);

    const after = await service.getPublished("future-of-events-2025");
    expect(after?.event.id).toBe(before?.event.id);
    expect(after?.version.id).toBe(before?.version.id);
  });

  it("persists an anonymous itinerary by a hashed browser token", async () => {
    const programmeService = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await programmeService.getPublished(
      "future-of-events-2025",
    );
    expect(programme).not.toBeNull();
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const sessionId = activeProgramme.sessions[0].id;
    await expect(
      service.hasActiveAnonymousItinerary(activeProgramme, null),
    ).resolves.toBe(false);
    const itinerary = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    const { token } = itinerary;
    await expect(
      service.hasActiveAnonymousItinerary(activeProgramme, token),
    ).resolves.toBe(true);
    expect(itinerary.expiresAt).toBe(
      Math.floor(Date.parse("2099-05-23T03:59:59Z") / 1_000) + 365 * 86_400,
    );
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: token,
      }),
    ).toEqual([sessionId]);
    const row = await env.DB.prepare(
      "SELECT visitor_key_hash AS visitorHash FROM public_itineraries WHERE event_id = ?",
    )
      .bind(programme!.event.id)
      .first<{ visitorHash: string }>();
    expect(row?.visitorHash).not.toBe(token);
    await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: token },
      sessionId,
      "remove",
    );
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: token,
      }),
    ).toEqual([]);
  });

  it("bounds expired itinerary cleanup when a new anonymous itinerary is created", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const prefix = `expired-itinerary-${crypto.randomUUID()}-`;
    await env.DB.prepare(
      `WITH RECURSIVE numbers(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 105
       )
       INSERT INTO public_itineraries (
         id, event_id, visitor_key_hash, expires_at, created_at, updated_at
       )
       SELECT ? || value, ?, ? || value, 1, 1, 1 FROM numbers`,
    )
      .bind(prefix, activeProgramme.event.id, prefix)
      .run();

    await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: null },
      activeProgramme.sessions[0]!.id,
      "add",
    );

    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total FROM public_itineraries
          WHERE substr(id, 1, ?) = ? AND expires_at = 1`,
      )
        .bind(prefix.length, prefix)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 5 });
  });

  it("requires verified abuse protection before creating an anonymous itinerary", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const fetcher = vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "programcue.test",
        action: "public_itinerary_create",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: {
        ...(env as unknown as CloudflareEnvironment),
        APP_ENV: "production",
        DEMO_MODE: "false",
        BETTER_AUTH_URL: "https://programcue.test",
        BETTER_AUTH_SECRET:
          "programme-abuse-test-secret-with-at-least-thirty-two-characters",
        TURNSTILE_SITE_KEY: "programme-site-key",
        TURNSTILE_SECRET_KEY: "programme-secret-key",
      } as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const programmeService = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const currentProgramme = await programmeService.getPublished(
      "future-of-events-2025",
    );
    expect(currentProgramme).not.toBeNull();
    const originalEvent = await env.DB.prepare(
      "SELECT ends_at AS endsAt FROM events WHERE id = ?",
    )
      .bind(currentProgramme!.event.id)
      .first<{ endsAt: number }>();
    expect(originalEvent).not.toBeNull();
    try {
      await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?")
        .bind(4_071_081_599, currentProgramme!.event.id)
        .run();
      const programme = await programmeService.getPublished(
        "future-of-events-2025",
      );
      expect(programme).not.toBeNull();
      const request = new Request(
        "https://programcue.test/public/programme/future-of-events-2025",
        {
          method: "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.201",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            intent: "add",
            sessionId: programme!.sessions[0]!.id,
            "turnstile-token": "verified-itinerary-token",
          }),
        },
      );

      const response = await publicProgrammePageAction({
        request,
        params: { slug: "future-of-events-2025" },
        context,
      } as never);

      if (response instanceof Response) {
        throw new Error(
          "Anonymous itinerary creation returned a raw response.",
        );
      }
      expect(response.init?.status).toBeUndefined();
      expect(response.data).toMatchObject({ ok: true });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?")
        .bind(originalEvent!.endsAt, currentProgramme!.event.id)
        .run();
    }
  });

  it("rotates an unrecognized visitor cookie instead of accepting a fixed bearer token", async () => {
    const programmeService = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await programmeService.getPublished(
      "future-of-events-2025",
    );
    expect(programme).not.toBeNull();
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const attackerSelectedToken = `fixed-${crypto.randomUUID()}`;
    const result = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: attackerSelectedToken },
      activeProgramme.sessions[0]!.id,
      "add",
    );
    expect(result.token).not.toBe(attackerSelectedToken);
    expect(result.token).toMatch(/^[0-9a-f-]{72}$/u);

    const fixedHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(attackerSelectedToken),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await expect(
      env.DB.prepare(
        `SELECT 1 FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(activeProgramme.event.id, fixedHash)
        .first(),
    ).resolves.toBeNull();
  });

  it("reuses one browser token without losing itineraries from another event", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const firstSessionId = activeProgramme.sessions[0].id;
    const { token } = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: null },
      firstSessionId,
      "add",
    );

    const suffix = crypto.randomUUID();
    const secondEventId = `itinerary-event-${suffix}`;
    const secondSessionId = `itinerary-session-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, 'org-future-events', 'Second itinerary event', ?, 'UTC',
                  4070908800, 4071081599,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(secondEventId, `itinerary-event-${suffix}`),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Second itinerary session', ?, 'presentation', 30,
                  'published', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(secondSessionId, secondEventId, `itinerary-session-${suffix}`),
    ]);
    const secondProgramme = {
      ...activeProgramme,
      event: {
        ...activeProgramme.event,
        id: secondEventId,
        slug: `itinerary-event-${suffix}`,
        name: "Second itinerary event",
        startDate: "2099-01-01",
        endDate: "2099-01-02",
        timezone: "UTC",
      },
      sessions: [
        {
          ...activeProgramme.sessions[0],
          id: secondSessionId,
          slug: `itinerary-session-${suffix}`,
        },
      ],
    };

    const { token: reusedToken, expiresAt: sharedCookieExpiry } =
      await service.updateItinerary(
        secondProgramme,
        { personId: null, visitorToken: token },
        secondSessionId,
        "add",
      );
    expect(reusedToken).toBe(token);
    expect(sharedCookieExpiry).toBe(
      Math.floor(Date.parse("2099-05-23T03:59:59Z") / 1_000) + 365 * 86_400,
    );
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: reusedToken,
      }),
    ).toEqual([firstSessionId]);
    await env.DB.prepare(
      `UPDATE public_itineraries
          SET expires_at = unixepoch() - 1
        WHERE event_id = ? AND visitor_key_hash = (
          SELECT visitor_key_hash FROM public_itineraries WHERE event_id = ?
        )`,
    )
      .bind(activeProgramme.event.id, secondEventId)
      .run();
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: reusedToken,
      }),
    ).toEqual([]);
    const revived = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: reusedToken },
      firstSessionId,
      "add",
    );
    expect(revived.token).toBe(reusedToken);
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: revived.token,
      }),
    ).toEqual([firstSessionId]);
    const secondItinerary = await env.DB.prepare(
      `SELECT visitor_key_hash AS visitorHash, expires_at AS expiresAt
         FROM public_itineraries WHERE event_id = ?`,
    )
      .bind(secondEventId)
      .first<{ visitorHash: string; expiresAt: number | null }>();
    expect(secondItinerary).not.toBeNull();
    expect(secondItinerary!.expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1_000),
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(activeProgramme.event.id, secondItinerary!.visitorHash)
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });
  });

  it("shares a read-only itinerary and syncs anonymous selections to a signed-in person", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const sessionId = programme!.sessions[0].id;
    const { token } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    const anonymousIdentity = { personId: null, visitorToken: token };
    const shareToken = await service.shareItinerary(
      programme!,
      anonymousIdentity,
    );
    const shareHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(shareToken),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    expect(await service.sharedItinerary(programme!, shareToken)).toEqual([
      sessionId,
    ]);
    const storedShare = await env.DB.prepare(
      `SELECT share_token_hash AS shareHash
         FROM public_itineraries
        WHERE event_id = ? AND share_token_hash = ?`,
    )
      .bind(programme!.event.id, shareHash)
      .first<{ shareHash: string }>();
    expect(storedShare?.shareHash).toBe(shareHash);
    expect(storedShare?.shareHash).not.toBe(shareToken);

    const signedInIdentity = {
      personId: "person-demo-admin",
      visitorToken: token,
    };
    await expect(
      service.itineraryIsSynced(programme!, signedInIdentity),
    ).resolves.toBe(false);
    await service.syncItinerary(programme!, signedInIdentity);
    await expect(
      service.itineraryIsSynced(programme!, signedInIdentity),
    ).resolves.toBe(true);
    expect(
      await service.itinerary(programme!, {
        personId: "person-demo-admin",
        visitorToken: null,
      }),
    ).toEqual([sessionId]);
    expect(
      await env.DB.prepare(
        `SELECT person_id AS personId, visitor_key_hash AS visitorHash
           FROM public_itineraries
          WHERE event_id = ? AND share_token_hash = ?`,
      )
        .bind(programme!.event.id, storedShare!.shareHash)
        .first<{ personId: string; visitorHash: string | null }>(),
    ).toEqual({ personId: "person-demo-admin", visitorHash: null });
    expect(await service.sharedItinerary(programme!, shareToken)).toEqual([
      sessionId,
    ]);

    await service.updateItinerary(
      programme!,
      signedInIdentity,
      sessionId,
      "remove",
    );
    await service.syncItinerary(programme!, signedInIdentity);
    expect(
      await service.itinerary(programme!, {
        personId: "person-demo-admin",
        visitorToken: null,
      }),
    ).toEqual([]);
  });

  it("reads the union of signed-in and anonymous itineraries without mutating either identity", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const [personalSession, anonymousSession] = programme!.sessions;
    expect(personalSession).toBeDefined();
    expect(anonymousSession).toBeDefined();

    await service.updateItinerary(
      programme!,
      { personId: "person-demo-admin", visitorToken: null },
      personalSession!.id,
      "add",
    );
    const { token } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      anonymousSession!.id,
      "add",
    );
    const before = await env.DB.prepare(
      `SELECT id, person_id AS personId, visitor_key_hash AS visitorHash,
              updated_at AS updatedAt
         FROM public_itineraries
        WHERE event_id = ? AND (person_id = ? OR visitor_key_hash IS NOT NULL)
        ORDER BY id`,
    )
      .bind(programme!.event.id, "person-demo-admin")
      .all<{
        id: string;
        personId: string | null;
        visitorHash: string | null;
        updatedAt: number;
      }>();

    await expect(
      service.itinerary(programme!, {
        personId: "person-demo-admin",
        visitorToken: token,
      }),
    ).resolves.toEqual([personalSession!.id, anonymousSession!.id]);

    const after = await env.DB.prepare(
      `SELECT id, person_id AS personId, visitor_key_hash AS visitorHash,
              updated_at AS updatedAt
         FROM public_itineraries
        WHERE event_id = ? AND (person_id = ? OR visitor_key_hash IS NOT NULL)
        ORDER BY id`,
    )
      .bind(programme!.event.id, "person-demo-admin")
      .all<{
        id: string;
        personId: string | null;
        visitorHash: string | null;
        updatedAt: number;
      }>();
    expect(after.results).toEqual(before.results);
    expect(after.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personId: "person-demo-admin",
          visitorHash: null,
        }),
        expect.objectContaining({
          personId: null,
          visitorHash: expect.any(String),
        }),
      ]),
    );
  });

  it("does not disclose itinerary items whose session is no longer public", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const sessionId = programme!.sessions[0]!.id;
    const { token } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    const shareToken = await service.shareItinerary(programme!, {
      personId: null,
      visitorToken: token,
    });

    await env.DB.prepare(
      `UPDATE sessions SET status = 'cancelled', updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(sessionId, programme!.event.id)
      .run();
    try {
      await expect(
        service.itinerary(programme!, {
          personId: null,
          visitorToken: token,
        }),
      ).resolves.toEqual([]);
      await expect(
        service.sharedItinerary(programme!, shareToken),
      ).rejects.toBeInstanceOf(PublishedProgrammeItineraryNotFoundError);
      await expect(
        service.shareItinerary(programme!, {
          personId: null,
          visitorToken: token,
        }),
      ).rejects.toBeInstanceOf(PublishedProgrammeItineraryNotFoundError);
    } finally {
      await env.DB.prepare(
        `UPDATE sessions SET status = 'published', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(sessionId, programme!.event.id)
        .run();
    }
  });

  it("rotates an expired itinerary token without exposing or mutating its items", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const sessionId = activeProgramme.sessions[0].id;
    const { token: expiredToken } = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    await env.DB.prepare(
      "UPDATE public_itineraries SET expires_at = unixepoch() - 1 WHERE event_id = ?",
    )
      .bind(programme!.event.id)
      .run();

    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: expiredToken,
      }),
    ).toEqual([]);
    const { token: replacementToken } = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: expiredToken },
      sessionId,
      "add",
    );
    expect(replacementToken).not.toBe(expiredToken);
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: expiredToken,
      }),
    ).toEqual([]);
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: replacementToken,
      }),
    ).toEqual([sessionId]);
  });

  it("fails fast when an event is beyond its itinerary retention window", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();
    await expect(
      service.updateItinerary(
        programme!,
        { personId: null, visitorToken: null },
        programme!.sessions[0].id,
        "add",
      ),
    ).rejects.toThrow("no longer available");
  });

  it("keeps the fixed demo programme itinerary interactive", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    expect(programme).not.toBeNull();

    const sessionId = programme!.sessions[0].id;
    const { token, expiresAt } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    const visitorHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token!)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    expect(
      await service.itinerary(programme!, {
        personId: null,
        visitorToken: token,
      }),
    ).toEqual([sessionId]);
    expect(expiresAt).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT expires_at AS expiresAt FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(programme!.event.id, visitorHash)
        .first<{ expiresAt: number | null }>(),
    ).toEqual({ expiresAt: null });
  });

  it("keeps the itinerary cookie through the event-relative retention deadline", () => {
    const now = 1_800_000_000;
    const expiresAt = now + 3 * 365 * 86_400;
    const cookie = itineraryCookie(
      "visitor token",
      expiresAt,
      "https://programme.example/event",
      now,
    );
    expect(cookie).toContain("program_cue_itinerary=visitor%20token");
    expect(cookie).toContain(`Max-Age=${expiresAt - now}`);
    expect(cookie).toContain(
      `Expires=${new Date(expiresAt * 1_000).toUTCString()}`,
    );
    expect(cookie).toContain("; Secure");
    expect(
      itineraryCookie("demo-token", null, "http://localhost/programme", now),
    ).not.toMatch(/Expires=|Max-Age=|; Secure/);
    expect(
      readCookie(
        new Request("https://programme.example/event", {
          headers: { cookie: "program_cue_itinerary=%not-valid" },
        }),
        "program_cue_itinerary",
      ),
    ).toBeNull();
  });

  it("truncates long public descriptions on a word boundary and leaves short ones intact", () => {
    const short = "A practical session about accessible programme design.";
    expect(descriptionSnippet(short)).toBe(short);
    expect(descriptionSnippet(" Collapsed   whitespace\nsnippet ")).toBe(
      "Collapsed whitespace snippet",
    );

    const long = `${"word ".repeat(80)}end`;
    const snippet = descriptionSnippet(long);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(181);
    expect(snippet.slice(0, -1)).not.toMatch(/\s$/u);
    expect(long.startsWith(snippet.slice(0, -1))).toBe(true);

    const unbroken = "x".repeat(400);
    expect(descriptionSnippet(unbroken)).toBe(`${"x".repeat(180)}…`);
  });

  it("returns no programme for an unpublished event", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    expect(await service.getPublished("not-an-event")).toBeNull();
  });
});

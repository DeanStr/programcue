import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicProgrammeLoader } from "~/routes/api-public-programme";
import { itineraryCookie } from "~/routes/public-programme";
import { PublicProgrammeService } from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  it("returns the public calendar 404 in the versioned API error envelope", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const response = await publicCalendarLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/not-published/calendar.ics",
        { headers: { "x-correlation-id": "calendar-not-found" } },
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
      correlationId: "calendar-not-found",
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
    const body = await response.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("correlationId");
    expect(JSON.stringify(body)).not.toContain("caller-specific-value");
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
    expect(programme?.sessions).toHaveLength(5);
    expect(
      programme?.sessions.every((session) => session.speakerNames.length > 0),
    ).toBe(true);

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
          'Earlier Co-speaker', 1, 'published', unixepoch(), unixepoch())
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
      "Earlier Co-speaker",
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
      INSERT INTO events (id, organisation_id, name, slug, timezone, starts_at, ends_at)
      VALUES ('programme-collision-event', 'programme-collision-org', 'Collision Event',
              'future-of-events-2025', 'UTC', 100, 200)
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
    const itinerary = await service.updateItinerary(
      activeProgramme,
      null,
      sessionId,
      "add",
    );
    const { token } = itinerary;
    expect(itinerary.expiresAt).toBe(
      Math.floor(Date.parse("2099-05-23T03:59:59Z") / 1_000) + 365 * 86_400,
    );
    expect(await service.itinerary(activeProgramme, token)).toEqual([
      sessionId,
    ]);
    const row = await env.DB.prepare(
      "SELECT visitor_key_hash AS visitorHash FROM public_itineraries WHERE event_id = ?",
    )
      .bind(programme!.event.id)
      .first<{ visitorHash: string }>();
    expect(row?.visitorHash).not.toBe(token);
    await service.updateItinerary(activeProgramme, token, sessionId, "remove");
    expect(await service.itinerary(activeProgramme, token)).toEqual([]);
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
      null,
      firstSessionId,
      "add",
    );

    const suffix = crypto.randomUUID();
    const secondEventId = `itinerary-event-${suffix}`;
    const secondSessionId = `itinerary-session-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at
        ) VALUES (?, 'org-future-events', 'Second itinerary event', ?, 'UTC',
                  4070908800, 4071081599)`,
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
        token,
        secondSessionId,
        "add",
      );
    expect(reusedToken).toBe(token);
    expect(sharedCookieExpiry).toBe(
      Math.floor(Date.parse("2099-05-23T03:59:59Z") / 1_000) + 365 * 86_400,
    );
    expect(await service.itinerary(activeProgramme, reusedToken)).toEqual([
      firstSessionId,
    ]);
    const secondItinerary = await env.DB.prepare(
      `SELECT visitor_key_hash AS visitorHash
         FROM public_itineraries WHERE event_id = ?`,
    )
      .bind(secondEventId)
      .first<{ visitorHash: string }>();
    expect(secondItinerary).not.toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(activeProgramme.event.id, secondItinerary!.visitorHash)
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });
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
      null,
      sessionId,
      "add",
    );
    await env.DB.prepare(
      "UPDATE public_itineraries SET expires_at = unixepoch() - 1 WHERE event_id = ?",
    )
      .bind(programme!.event.id)
      .run();

    expect(await service.itinerary(activeProgramme, expiredToken)).toEqual([]);
    const { token: replacementToken } = await service.updateItinerary(
      activeProgramme,
      expiredToken,
      sessionId,
      "add",
    );
    expect(replacementToken).not.toBe(expiredToken);
    expect(await service.itinerary(activeProgramme, expiredToken)).toEqual([]);
    expect(await service.itinerary(activeProgramme, replacementToken)).toEqual([
      sessionId,
    ]);
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
        null,
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
      null,
      sessionId,
      "add",
    );
    const visitorHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    expect(await service.itinerary(programme!, token)).toEqual([sessionId]);
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

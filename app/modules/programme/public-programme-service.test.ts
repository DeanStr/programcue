import { serializeSignedCookie } from "better-call";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicProgrammeLoader } from "~/routes/api-public-programme";
import { loader as publicProgrammePageLoader } from "~/routes/public-programme";
import { sortPublishedSpeakers } from "./programme-presentation";
import {
  itineraryCookie,
  publicItineraryIdentity,
} from "./public-itinerary-identity.server";
import {
  assertPublishedSpeakerGraphIntegrity,
  PublicProgrammeService,
  PublishedProgrammeSnapshotInvariantError,
  PublishedProgrammeSpeakerInvariantError,
} from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves published public content while editorial review remains advisory", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new PublicProgrammeService(testEnv);
    const baseline = await service.getPublished("future-of-events-2025");
    expect(
      baseline?.sessions.some((session) => session.id === "demo-session-1"),
    ).toBe(true);
    await testEnv.DB.prepare(
      `UPDATE schedule_session_contents
          SET content_status = 'in_review', approved_by_person_id = NULL,
              approved_at = NULL, approval_source = NULL
        WHERE schedule_version_id = 'demo-schedule-published'
          AND event_id = 'evt-foe-2025' AND session_id = 'demo-session-1'`,
    ).run();
    try {
      const programme = await service.getPublished("future-of-events-2025");
      expect(
        programme?.sessions.some((session) => session.id === "demo-session-1"),
      ).toBe(true);
      await expect(
        service.getPublishedLandingSummary("future-of-events-2025", 8),
      ).resolves.not.toBeNull();
    } finally {
      await testEnv.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = 'approved',
                approved_by_person_id = NULL,
                approved_at = unixepoch(),
                approval_source = 'legacy_publication'
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025' AND session_id = 'demo-session-1'`,
      ).run();
    }
  });

  it("exports the server-side personal itinerary without a session-ID URL", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2025");
    const selected = programme!.sessions[0]!;
    const omitted = programme!.sessions[1]!;
    const { token } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      selected.id,
      "add",
    );
    const cookie = (
      await itineraryCookie(
        env as unknown as CloudflareEnvironment,
        token!,
        "https://programcue.test",
      )
    ).split(";")[0]!;
    const response = await publicCalendarLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/future-of-events-2025/calendar.ics?itinerary=mine",
        {
          headers: {
            cookie,
          },
        },
      ),
      params: { slug: "future-of-events-2025" },
      context,
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "future-of-events-2025-itinerary.ics",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const calendar = await response.text();
    expect(calendar).toContain(`UID:${selected.id}@programcue`);
    expect(calendar).not.toContain(`UID:${omitted.id}@programcue`);
  });

  it("uses the selected production evaluation persona as the itinerary identity", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
      EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
      EVALUATION_SESSION_SECRET:
        "evaluation-session-secret-with-more-than-thirty-two-characters",
    } as CloudflareEnvironment;
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_id, action,
         entity_type, entity_id, metadata_json, created_at
       ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
                 'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                 unixepoch())`,
    )
      .bind(crypto.randomUUID())
      .run();
    const cookie = (await evaluationSessionCookie(testEnv, "organizer")).split(
      ";",
      1,
    )[0]!;

    await expect(
      publicItineraryIdentity(
        new Request("https://app.programcue.test/public/programme/event", {
          headers: { cookie },
        }),
        testEnv,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({
      personId: "person-demo-admin",
      visitorToken: null,
    });
  });

  it("keeps gate-only evaluation state anonymous instead of falling through to Better Auth", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
      BETTER_AUTH_SECRET:
        "evaluation-itinerary-better-auth-secret-with-thirty-two-characters",
      BETTER_AUTH_URL: "https://app.programcue.com",
      EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
      EVALUATION_SESSION_SECRET:
        "evaluation-session-secret-with-more-than-thirty-two-characters",
    } as CloudflareEnvironment;
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_id, action,
         entity_type, entity_id, metadata_json, created_at
       ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
                 'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                 unixepoch())`,
    )
      .bind(crypto.randomUUID())
      .run();
    const evaluationCookie = (
      await evaluationSessionCookie(testEnv, null)
    ).split(";", 1)[0]!;
    const authToken = `itinerary-dual-session-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO auth_sessions (
         id, person_id, token, expires_at, created_at, updated_at
       ) VALUES (?, 'person-demo-admin', ?, unixepoch() + 3600,
                 unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), authToken)
      .run();
    const betterAuthCookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      authToken,
      String(testEnv.BETTER_AUTH_SECRET),
    );
    const visitorToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const visitorCookie = (
      await itineraryCookie(
        testEnv,
        visitorToken,
        "https://app.programcue.com/public/programme/future-of-events-2025",
      )
    ).split(";", 1)[0]!;

    await expect(
      publicItineraryIdentity(
        new Request(
          "https://app.programcue.com/public/programme/future-of-events-2025",
          {
            headers: {
              cookie: `${evaluationCookie}; ${betterAuthCookie}; ${visitorCookie}`,
            },
          },
        ),
        testEnv,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({
      personId: null,
      visitorToken,
    });

    await expect(
      publicItineraryIdentity(
        new Request(
          "https://app.programcue.com/public/programme/future-of-events-2025",
          { headers: { cookie: betterAuthCookie } },
        ),
        testEnv,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({
      personId: "person-demo-admin",
      visitorToken: null,
    });
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
      startDate: "2027-05-20",
      endDate: "2027-05-22",
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
    expect(programme?.speakers.map((speaker) => speaker.id)).toEqual(
      sortPublishedSpeakers(programme!.speakers).map((speaker) => speaker.id),
    );
    expect(programme?.speakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "person-demo-speaker",
          displayName: "Priya Shah",
          jobTitle: "Director of Experience Design",
          organisationName: "EventLab",
          imageUrl: "/images/demo-speakers/priya-shah.webp",
        }),
        expect.objectContaining({
          id: "person-demo-submitter",
          displayName: "Alex Morgan",
          jobTitle: "Product Strategy Lead",
          organisationName: "Northstar Events",
          imageUrl: "/images/demo-speakers/alex-morgan.webp",
        }),
      ]),
    );
    const speakerById = new Map(
      programme!.speakers.map((speaker) => [speaker.id, speaker]),
    );
    expect(
      programme!.sessions.every((session) =>
        session.speakerIds.every((speakerId) => {
          const speaker = speakerById.get(speakerId);
          return (
            speaker?.sessionIds.includes(session.id) &&
            speaker.jobTitle &&
            speaker.organisationName
          );
        }),
      ),
    ).toBe(true);
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
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position,
          participation_status, participation_confirmed_at, visibility
        ) VALUES (?, 'evt-foe-2025', 'programme-speaker-late', 20,
                  'confirmed', unixepoch(), 'public')
      `,
      ).bind(publicSessionId),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position,
          participation_status, participation_confirmed_at, visibility
        ) VALUES (?, 'evt-foe-2025', 'programme-speaker-early', 10,
                  'confirmed', unixepoch(), 'public')
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
          session_id, event_id, person_id, position,
          participation_status, participation_confirmed_at, visibility
        ) VALUES (?, 'evt-foe-2025', 'programme-draft-speaker', 99,
                  'confirmed', unixepoch(), 'public')
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

  it("uses bundled portraits only for the canonical demo or evaluation fixture", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const production = await new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
      EVALUATION_MODE: "false",
    } as unknown as CloudflareEnvironment).getPublished(
      "future-of-events-2025",
    );
    expect(
      production?.speakers.find(
        (speaker) => speaker.id === "person-demo-speaker",
      )?.imageUrl,
    ).toBeNull();

    const evaluationEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
    } as unknown as CloudflareEnvironment;
    const evaluationService = new PublicProgrammeService(evaluationEnv);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE people
            SET profile_status = 'published', updated_at = unixepoch()
          WHERE id IN ('person-sbek-speaker', 'person-sbek-speaker2')`,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('demo-session-1', 'evt-foe-2025',
                   'person-sbek-speaker', 90, 'Speaker', 'confirmed',
                   unixepoch(), 'public')`,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('demo-session-1', 'evt-foe-2025',
                   'person-sbek-speaker2', 91, 'Co-speaker', 'confirmed',
                   unixepoch(), 'public')`,
      ),
    ]);
    const evaluation = await evaluationService.getPublished(
      "future-of-events-2025",
    );
    expect(
      evaluation?.speakers.find(
        (speaker) => speaker.id === "person-demo-speaker",
      )?.imageUrl,
    ).toBe("/images/demo-speakers/priya-shah.webp");
    expect(
      evaluation?.speakers.find(
        (speaker) => speaker.id === "person-sbek-speaker",
      )?.imageUrl,
    ).toBe("/images/demo-speakers/priya-raman.webp");
    expect(
      evaluation?.speakers.find(
        (speaker) => speaker.id === "person-sbek-speaker2",
      )?.imageUrl,
    ).toBe("/images/demo-speakers/marcus-okafor.webp");

    const assetId = `fixture-pending-headshot-${crypto.randomUUID()}`;
    const versionId = `${assetId}-v1`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status, created_at, updated_at
         ) VALUES (?, 'evt-foe-2025', 'person-demo-speaker', 'person',
                   'person-demo-speaker', 'headshot', NULL, 'pending',
                   unixepoch(), unixepoch())`,
      ).bind(assetId),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, size_bytes,
           created_by_person_id, created_at
         ) VALUES (?, 'evt-foe-2025', ?, 1, ?, 'pending-headshot.webp',
                   'image/webp', 1024, 'person-demo-speaker', unixepoch())`,
      ).bind(versionId, assetId, `evaluation/headshots/${versionId}`),
    ]);

    const withPendingUpload = await evaluationService.getPublished(
      "future-of-events-2025",
    );
    expect(
      withPendingUpload?.speakers.find(
        (speaker) => speaker.id === "person-demo-speaker",
      )?.imageUrl,
    ).toBeNull();
  });

  it("loads a published programme with more than 98 speakers", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const prefix = `many-speaker-${crypto.randomUUID().slice(0, 8)}-`;
    const speakerIds = Array.from(
      { length: 99 },
      (_, index) => `${prefix}${index}`,
    );
    const cleanup = async () => {
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM session_speakers
             WHERE person_id IN (
               SELECT id FROM people WHERE display_name LIKE 'Large Programme Speaker %'
             )`,
        ),
        env.DB.prepare(
          "DELETE FROM people WHERE display_name LIKE 'Large Programme Speaker %'",
        ),
      ]);
    };

    try {
      await cleanup();
      await env.DB.batch([
        ...speakerIds.map((speakerId, index) =>
          env.DB.prepare(
            `
            INSERT INTO people (
              id, email, display_name, email_verified, profile_status,
              created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'published', unixepoch(), unixepoch())
          `,
          ).bind(
            speakerId,
            `${speakerId}@example.com`,
            `Large Programme Speaker ${String(index).padStart(3, "0")}`,
          ),
        ),
        ...speakerIds.map((speakerId, index) =>
          env.DB.prepare(
            `
            INSERT INTO session_speakers (
              session_id, event_id, person_id, position,
              participation_status, participation_confirmed_at, visibility
            ) VALUES ('demo-session-1', 'evt-foe-2025', ?, ?,
                      'confirmed', unixepoch(), 'public')
          `,
          ).bind(speakerId, index + 1_000),
        ),
      ]);

      const programme = await service.getPublished("future-of-events-2025");
      expect(programme).not.toBeNull();
      expect(programme!.speakers).toEqual(
        expect.arrayContaining(
          speakerIds.map((speakerId) =>
            expect.objectContaining({ id: speakerId }),
          ),
        ),
      );
    } finally {
      await cleanup();
    }
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
      await expect(
        service.getPublishedLandingSummary("future-of-events-2025", 8),
      ).resolves.toBeNull();
    } finally {
      await env.DB.prepare(
        `UPDATE events SET activation_status = 'active'
          WHERE id = 'evt-foe-2025'`,
      ).run();
    }
  });

  it("filters sessions whose published records are not public", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      "UPDATE sessions SET visibility = 'private' WHERE id = 'demo-session-1'",
    ).run();
    try {
      const programme = await service.getPublished("future-of-events-2025");
      expect(
        programme?.sessions.some((session) => session.id === "demo-session-1"),
      ).toBe(false);
      expect(
        programme?.speakers.every((speaker) =>
          speaker.sessionIds.every((sessionId) =>
            programme.sessions.some((session) => session.id === sessionId),
          ),
        ),
      ).toBe(true);
    } finally {
      await env.DB.prepare(
        "UPDATE sessions SET visibility = 'public' WHERE id = 'demo-session-1'",
      ).run();
    }
  });

  it("fails closed when published session content is not public", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `UPDATE schedule_session_contents
          SET visibility = 'private'
        WHERE schedule_version_id = 'demo-schedule-published'
          AND event_id = 'evt-foe-2025'
          AND session_id = 'demo-session-1'`,
    ).run();
    try {
      await expect(
        service.getPublished("future-of-events-2025"),
      ).rejects.toBeInstanceOf(PublishedProgrammeSnapshotInvariantError);
    } finally {
      await env.DB.prepare(
        `UPDATE schedule_session_contents
            SET visibility = 'public'
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025'
            AND session_id = 'demo-session-1'`,
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
});

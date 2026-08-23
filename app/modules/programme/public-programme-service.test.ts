import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloudflareContext,
  cspNonceContext,
} from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import { loader as publicCalendarLoader } from "~/routes/api-public-calendar";
import { loader as publicProgrammeLoader } from "~/routes/api-public-programme";
import {
  meta as publicProgrammeMeta,
  loader as publicProgrammePageLoader,
} from "~/routes/public-programme";
import { defaultProgrammeEmbedConfiguration } from "./programme-embed-configuration";
import { ProgrammeEmbedService } from "./programme-embed-service.server";
import { sortPublishedSpeakers } from "./programme-presentation";
import {
  itineraryCookie,
  publicItineraryIdentity,
} from "./public-itinerary-identity.server";
import {
  assertPublishedSpeakerGraphIntegrity,
  PublicProgrammeService,
  PublishedProgrammeSpeakerInvariantError,
  parsePublishedSpeakerArray,
} from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  it("fails closed when a published speaker array is missing", () => {
    expect(() =>
      parsePublishedSpeakerArray("version-1", "break-1", "speaker IDs", null),
    ).toThrow(/did not return speaker IDs/);
    expect(
      parsePublishedSpeakerArray("version-1", "break-1", "speaker names", "[]"),
    ).toEqual([]);
  });

  it("returns an empty speaker list for a published session with no speakers", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const sessionId = `break-no-speakers-${crypto.randomUUID()}`;
    const slug = `break-no-speakers-${sessionId.slice(-8)}`;
    await testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, description, format, duration_minutes,
         status, visibility, revision, created_at, updated_at
       ) VALUES (?, 'evt-foe-2025', 'Open space', ?, '', 'presentation', 15,
                 'published', 'public', 1, unixepoch(), unixepoch())`,
    )
      .bind(sessionId, slug)
      .run();
    const row = await testEnv.DB.prepare(
      `
      SELECT
        (
          SELECT json_group_array(ordered.personId)
            FROM (
              SELECT ss.person_id AS personId
                FROM session_speakers ss
                JOIN people p ON p.id = ss.person_id AND p.profile_status = 'published'
               WHERE ss.session_id = s.id AND ss.event_id = s.event_id
                 AND ss.visibility = 'public'
                 AND ss.participation_status = 'confirmed'
               ORDER BY ss.position, ss.person_id
            ) ordered
        ) AS speakerIds,
        (
          SELECT json_group_array(ordered.displayName)
            FROM (
              SELECT p.display_name AS displayName
                FROM session_speakers ss
                JOIN people p ON p.id = ss.person_id AND p.profile_status = 'published'
               WHERE ss.session_id = s.id AND ss.event_id = s.event_id
                 AND ss.visibility = 'public'
                 AND ss.participation_status = 'confirmed'
               ORDER BY ss.position, ss.person_id
            ) ordered
        ) AS speakerNames
        FROM sessions s
       WHERE s.id = ? AND s.event_id = 'evt-foe-2025'
    `,
    )
      .bind(sessionId)
      .first<{ speakerIds: string | null; speakerNames: string | null }>();
    expect(row).toEqual({ speakerIds: "[]", speakerNames: "[]" });
    if (!row) throw new Error("Speaker-less session query returned no row.");
    expect(
      parsePublishedSpeakerArray(
        "demo-schedule-published",
        sessionId,
        "speaker IDs",
        row.speakerIds,
      ),
    ).toEqual([]);
    expect(
      parsePublishedSpeakerArray(
        "demo-schedule-published",
        sessionId,
        "speaker names",
        row.speakerNames,
      ),
    ).toEqual([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not retain the pre-release 2025 public-slug alias", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new PublicProgrammeService(testEnv);

    await expect(
      service.getPublished("future-of-events-2025"),
    ).resolves.toBeNull();
    await expect(
      service.getPublished("future-of-events-2027"),
    ).resolves.not.toBeNull();
  });

  it("serves managed embeds with exact draft, pause and revocation semantics", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const embedService = new ProgrammeEmbedService(testEnv);
    const admin = {
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator" as const,
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      demo: true,
    };
    const slug = `route-${crypto.randomUUID().slice(0, 8)}`;
    const id = await embedService.create(admin, {
      name: "Route semantics",
      slug,
      installationNote: "",
      configurationJson: JSON.stringify({
        ...defaultProgrammeEmbedConfiguration(),
        surface: "sessions",
      }),
    });
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: testEnv,
      ctx: {} as ExecutionContext,
    });
    const load = (query = "") =>
      publicProgrammePageLoader({
        request: new Request(
          `https://programcue.test/embed/future-of-events-2027/saved/${slug}${query}`,
        ),
        params: { slug: "future-of-events-2027", embedSlug: slug },
        context,
      } as never);

    const draft = await load().catch((error: unknown) => error);
    expect(draft).toMatchObject({ status: 404 });
    await embedService.transition(admin, {
      id,
      revision: 1,
      nextStatus: "active",
      confirmed: "yes",
    });
    const active = await load();
    if (active instanceof Response)
      throw new Error("Managed embed returned a raw response.");
    expect(active.data).toMatchObject({
      embedded: true,
      surface: "sessions",
      managedEmbedRevision: 2,
    });
    const queryRejected = await load("?density=compact").catch(
      (error: unknown) => error,
    );
    expect(queryRejected).toMatchObject({ status: 400 });

    await testEnv.DB.prepare(
      "UPDATE programme_embeds SET configuration_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          ...defaultProgrammeEmbedConfiguration(),
          surface: "agenda",
        }),
        id,
      )
      .run();
    const historicalAgenda = await load();
    if (historicalAgenda instanceof Response)
      throw new Error("Historical agenda embed returned a raw response.");
    expect(historicalAgenda.data).toMatchObject({
      embedded: true,
      surface: "schedule",
      managedEmbedRevision: 2,
    });

    await testEnv.DB.prepare(
      "UPDATE programme_embeds SET configuration_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          ...defaultProgrammeEmbedConfiguration(),
          surface: "agenda",
          track: "Removed published track",
        }),
        id,
      )
      .run();
    const publicationDrift = await load().catch((error: unknown) => error);
    expect(publicationDrift).toMatchObject({ status: 500 });
    if (!(publicationDrift instanceof Response)) {
      throw new Error(
        "Managed embed publication drift did not return a response.",
      );
    }
    expect(publicationDrift.headers.get("cache-control")).toBe("no-store");

    await embedService.transition(admin, {
      id,
      revision: 2,
      nextStatus: "paused",
      confirmed: "yes",
    });
    const paused = await load().catch((error: unknown) => error);
    expect(paused).toMatchObject({ init: { status: 503 } });
    await embedService.transition(admin, {
      id,
      revision: 3,
      nextStatus: "revoked",
      confirmed: "yes",
    });
    const revoked = await load().catch((error: unknown) => error);
    expect(revoked).toMatchObject({ init: { status: 410 } });
  });

  it("serves the seeded published snapshot with explicit legacy approval provenance", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new PublicProgrammeService(testEnv);
    const baseline = await service.getPublished("future-of-events-2027");
    expect(
      baseline?.sessions.some((session) => session.id === "demo-session-1"),
    ).toBe(true);
    await expect(
      testEnv.DB.prepare(
        `SELECT content_status AS contentStatus,
                approval_source AS approvalSource
           FROM schedule_session_contents
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025' AND session_id = 'demo-session-1'`,
      ).first(),
    ).resolves.toEqual({
      contentStatus: "approved",
      approvalSource: "legacy_publication",
    });
    await expect(
      service.getPublishedLandingSummary("future-of-events-2027", 8),
    ).resolves.not.toBeNull();
  });

  it("rejects published approval drift at the database boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new PublicProgrammeService(testEnv);
    await expect(
      testEnv.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = 'in_review', approved_by_person_id = NULL,
                approved_at = NULL, approval_source = NULL
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025' AND session_id = 'demo-session-1'`,
      ).run(),
    ).rejects.toThrow(/approval and visibility are immutable/i);
    await expect(
      service.getPublished("future-of-events-2027"),
    ).resolves.not.toBeNull();
    await expect(
      service.getPublishedLandingSummary("future-of-events-2027", 8),
    ).resolves.not.toBeNull();
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
    const programme = await service.getPublished("future-of-events-2027");
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
        "https://programcue.test/api/v1/public/events/future-of-events-2027/calendar.ics?itinerary=mine",
        {
          headers: {
            cookie,
          },
        },
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "future-of-events-2027-itinerary.ics",
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
      EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
      EVALUATION_SESSION_SECRET:
        "evaluation-session-secret-with-more-than-thirty-two-characters",
    } as CloudflareEnvironment;
    await ensureDemoData(env as unknown as CloudflareEnvironment);
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
      EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
      EVALUATION_SESSION_SECRET:
        "evaluation-session-secret-with-more-than-thirty-two-characters",
    } as CloudflareEnvironment;
    await ensureDemoData(env as unknown as CloudflareEnvironment);
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
        "https://app.programcue.com/public/programme/future-of-events-2027",
      )
    ).split(";", 1)[0]!;

    await expect(
      publicItineraryIdentity(
        new Request(
          "https://app.programcue.com/public/programme/future-of-events-2027",
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
          "https://app.programcue.com/public/programme/future-of-events-2027",
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
        "https://programcue.test/public/programme/future-of-events-2027?share=",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(404);
    await expect((rejected as Response).text()).resolves.toBe(
      "This shared itinerary is unavailable or empty.",
    );
  });

  it("resolves speaker deep links from the published snapshot and emits honest unfurl metadata", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const request = new Request(
      "https://programcue.test/public/programme/future-of-events-2027?speaker=person-demo-speaker",
    );
    const result = await publicProgrammePageLoader({
      request,
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    if (result instanceof Response) {
      throw new Error("Speaker deep link returned a raw response.");
    }
    expect(result.data.speakerShare).toMatchObject({
      speakerId: "person-demo-speaker",
      speakerName: "Priya Shah",
      url: "https://programcue.test/public/programme/future-of-events-2027?speaker=person-demo-speaker",
      imageUrl: null,
    });
    expect(result.data.canonicalUrl).toBe(result.data.speakerShare?.url);
    const metadata = publicProgrammeMeta({ loaderData: result.data } as never);
    expect(metadata).toEqual(
      expect.arrayContaining([
        { title: "Priya Shah · Future of Events 2027" },
        {
          tagName: "link",
          rel: "canonical",
          href: result.data.canonicalUrl,
        },
        {
          property: "og:url",
          content: result.data.canonicalUrl,
        },
        { name: "twitter:card", content: "summary" },
      ]),
    );
    expect(metadata).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "og:image" }),
      ]),
    );

    const invalid = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027?speaker=not-published",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(Response);
    expect((invalid as Response).status).toBe(404);
  });

  it("canonicalises a known session on the wrong public surface", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const result = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027?session=demo-session-1",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never).catch((error: unknown) => error);

    expect(result).toMatchObject({ status: 302 });
    expect((result as Response).headers.get("Location")).toBe(
      "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
    );

    const shared = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027?share=itinerary-token&session=demo-session-1&day=2027-06-12",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never).catch((error: unknown) => error);
    expect(shared).toMatchObject({ status: 302 });
    expect((shared as Response).headers.get("Location")).toBe(
      "/public/programme/future-of-events-2027/sessions?share=itinerary-token&session=demo-session-1&day=2027-06-12",
    );

    const unknown = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027?session=not-published",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(Response);
    expect((unknown as Response).status).toBe(404);
  });

  it("uses the matched route parameter for programme data revalidation", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const result = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027/schedule.data?_routes=public-programme-surface",
      ),
      params: { slug: "future-of-events-2027", surface: "schedule" },
      context,
    } as never);
    if (result instanceof Response) {
      throw new Error("Programme revalidation returned a raw response.");
    }
    expect(result.data.surface).toBe("schedule");
  });

  it("invalidates embed ETags when public venue presentation changes", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: testEnv,
      ctx: {} as ExecutionContext,
    });
    const original = await testEnv.DB.prepare(
      `SELECT venue_address AS venueAddress, venue_map_url AS venueMapUrl,
              programme_hero_image_url AS heroImageUrl
         FROM events WHERE id = 'evt-foe-2025'`,
    ).first<{
      venueAddress: string | null;
      venueMapUrl: string | null;
      heroImageUrl: string | null;
    }>();
    expect(original).not.toBeNull();

    const load = (etag?: string) =>
      publicProgrammePageLoader({
        request: new Request(
          "https://programcue.test/embed/future-of-events-2027",
          etag ? { headers: { "if-none-match": etag } } : undefined,
        ),
        params: { slug: "future-of-events-2027" },
        context,
      } as never);
    const readEtag = async (candidate: Awaited<ReturnType<typeof load>>) => {
      if (candidate instanceof Response) {
        throw new Error("Changed embed presentation returned 304.");
      }
      const etag = new Headers(candidate.init?.headers).get("etag");
      expect(etag).toMatch(/^"program-cue-publication-/u);
      return etag!;
    };

    try {
      let etag = await readEtag(await load());
      const unchanged = await load(etag);
      expect(unchanged).toBeInstanceOf(Response);
      expect((unchanged as Response).status).toBe(304);

      for (const [column, value] of [
        ["venue_address", "Level 2, 100 Test Street"],
        ["venue_map_url", "https://maps.example.test/programme"],
        [
          "programme_hero_image_url",
          "https://images.example.test/programme-hero.jpg",
        ],
      ] as const) {
        await testEnv.DB.prepare(
          `UPDATE events SET ${column} = ? WHERE id = 'evt-foe-2025'`,
        )
          .bind(value)
          .run();
        const nextEtag = await readEtag(await load(etag));
        expect(nextEtag).not.toBe(etag);
        etag = nextEtag;
      }
    } finally {
      await testEnv.DB.prepare(
        `UPDATE events
            SET venue_address = ?, venue_map_url = ?,
                programme_hero_image_url = ?
          WHERE id = 'evt-foe-2025'`,
      )
        .bind(
          original!.venueAddress,
          original!.venueMapUrl,
          original!.heroImageUrl,
        )
        .run();
    }
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
    context.set(cspNonceContext, "test-response-nonce-1234567890");
    const response = await publicProgrammeLoader({
      request: new Request(
        "https://programcue.test/api/v1/public/events/future-of-events-2027/programme",
        { headers: { "x-correlation-id": "caller-specific-value" } },
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=0, must-revalidate",
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
    context.set(cspNonceContext, "test-response-nonce-1234567890");
    const args = (format: string, headers?: HeadersInit) =>
      ({
        request: new Request(
          `https://programcue.test/api/v1/public/events/future-of-events-2027/programme?format=${format}`,
          { headers },
        ),
        params: { slug: "future-of-events-2027" },
        context,
      }) as never;

    const json = await publicProgrammeLoader(args("json"));
    expect(json.headers.get("etag")).toMatch(/^"program-cue-publication-/u);
    expect(json.headers.get("content-disposition")).toContain(
      "future-of-events-2027-programme.json",
    );
    await expect(json.json()).resolves.toMatchObject({
      sessions: expect.any(Array),
      speakers: expect.any(Array),
      freshness: expect.objectContaining({ source: "d1" }),
    });

    const html = await publicProgrammeLoader(args("html"));
    const htmlEtag = html.headers.get("etag");
    expect(htmlEtag).toMatch(/^W\/"program-cue-publication-/u);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-disposition")).toContain(
      "future-of-events-2027-programme.html",
    );
    expect(await html.text()).toContain("<!doctype html>");
    const htmlNotModified = await publicProgrammeLoader(
      args("html", { "if-none-match": htmlEtag ?? "" }),
    );
    expect(htmlNotModified.status).toBe(304);
    expect(await htmlNotModified.text()).toBe("");

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
    const programme = await service.getPublished("future-of-events-2027");
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
      "future-of-events-2027",
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
      "future-of-events-2027",
    );
    const publicSession = withoutPrivateProfile!.sessions.find(
      (session) => session.id === publicSessionId,
    )!;
    expect(publicSession.speakerIds).not.toContain("programme-draft-speaker");
    expect(publicSession.speakerNames).not.toContain("Private Draft Speaker");
    expect(publicSession.speakerIds).toHaveLength(
      publicSession.speakerNames.length,
    );

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          created_at, updated_at
        ) VALUES (
          'programme-pending-speaker', 'programme-pending-speaker@example.com',
          'Pending Public Speaker', 1, 'published', unixepoch(), unixepoch()
        )
      `),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position,
          participation_status, participation_confirmed_at, visibility
        ) VALUES (?, 'evt-foe-2025', 'programme-pending-speaker', 100,
                  'pending', NULL, 'public')
      `,
      ).bind(publicSessionId),
    ]);
    const withoutPendingParticipation = await service.getPublished(
      "future-of-events-2027",
    );
    const publicSessionWithoutPending =
      withoutPendingParticipation!.sessions.find(
        (session) => session.id === publicSessionId,
      )!;
    expect(publicSessionWithoutPending.speakerIds).not.toContain(
      "programme-pending-speaker",
    );
    expect(publicSessionWithoutPending.speakerNames).not.toContain(
      "Pending Public Speaker",
    );
    expect(
      withoutPendingParticipation!.speakers.some(
        (speaker) => speaker.id === "programme-pending-speaker",
      ),
    ).toBe(false);

    await env.DB.prepare(
      `INSERT INTO sessions (id, event_id, title, slug, format, duration_minutes, status, visibility, revision, created_at, updated_at) VALUES ('private-unpublished-session', 'evt-foe-2025', 'Private draft', 'private-draft', 'other', 30, 'unscheduled', 'private', 1, unixepoch(), unixepoch())`,
    ).run();
    expect(
      (await service.getPublished("future-of-events-2027"))?.sessions.some(
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
      "future-of-events-2027",
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
      "future-of-events-2027",
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
      "future-of-events-2027",
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

      const programme = await service.getPublished("future-of-events-2027");
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

  it("keeps speaker session IDs and the publication revision independent of relation insertion order", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const before = await service.getPublished("future-of-events-2027");
    const beforeSpeaker = before!.speakers.find(
      (speaker) => speaker.id === "person-demo-speaker",
    );
    expect(beforeSpeaker!.sessionIds).toHaveLength(3);

    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM session_speakers
          WHERE event_id = 'evt-foe-2025'
            AND person_id = 'person-demo-speaker'`,
      ),
      ...["demo-session-5", "demo-session-3", "demo-session-1"].map(
        (sessionId) =>
          env.DB.prepare(
            `INSERT INTO session_speakers (
               session_id, event_id, person_id, position, role_label,
               participation_status, participation_confirmed_at, visibility
             ) VALUES (?, 'evt-foe-2025', 'person-demo-speaker', 0, 'Speaker',
                       'confirmed', unixepoch(), 'public')`,
          ).bind(sessionId),
      ),
    ]);

    const after = await service.getPublished("future-of-events-2027");
    const afterSpeaker = after!.speakers.find(
      (speaker) => speaker.id === "person-demo-speaker",
    );
    expect(afterSpeaker!.sessionIds).toEqual(beforeSpeaker!.sessionIds);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after!.contentRevision).toBe(before!.contentRevision);
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
        service.getPublished("future-of-events-2027"),
      ).resolves.toBeNull();
      await expect(
        service.getPublishedLandingSummary("future-of-events-2027", 8),
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
      const programme = await service.getPublished("future-of-events-2027");
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

  it("rejects hiding a scheduled public snapshot after publication", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      env.DB.prepare(
        `UPDATE schedule_session_contents
            SET visibility = 'private'
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025'
            AND session_id = 'demo-session-1'`,
      ).run(),
    ).rejects.toThrow(/approval and visibility are immutable/i);
    await expect(
      service.getPublished("future-of-events-2027"),
    ).resolves.not.toBeNull();
  });

  it("returns a bounded CFP speaker preview without exposing programme internals", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const withoutSpeakers = await service.getPublishedLandingSummary(
      "future-of-events-2027",
      0,
    );
    expect(withoutSpeakers).toEqual({ speakers: [] });

    const preview = await service.getPublishedLandingSummary(
      "future-of-events-2027",
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
      service.getPublishedLandingSummary("future-of-events-2027", 9),
    ).rejects.toThrow(RangeError);
  });

  it("does not fall back to D1 when the authoritative Airtable repository is unavailable", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    await service.getPublished("future-of-events-2027");
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
    await expect(service.findPublishedVersion(eventId)).resolves.toMatchObject({
      eventId,
      slug: eventId,
      version: { id: versionId, versionNumber: 1 },
    });
  });

  it("rejects deleting content for a published public entry", async () => {
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
    await expect(
      env.DB.prepare(
        `DELETE FROM schedule_session_contents
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = 'evt-foe-2025' AND session_id = ?`,
      )
        .bind(entry!.sessionId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/i);
    await expect(
      service.getPublished("future-of-events-2027"),
    ).resolves.not.toBeNull();
    await expect(
      service.getPublishedLandingSummary("future-of-events-2027", 8),
    ).resolves.not.toBeNull();
  });

  it("rejects duplicate event slugs across organisations and keeps public lookup stable", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const before = await service.getPublished("future-of-events-2027");
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
              'future-of-events-2027', 'UTC', 100, 200,
              '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
    `,
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed: events\.slug/);

    const after = await service.getPublished("future-of-events-2027");
    expect(after?.event.id).toBe(before?.event.id);
    expect(after?.version.id).toBe(before?.version.id);
  });
});

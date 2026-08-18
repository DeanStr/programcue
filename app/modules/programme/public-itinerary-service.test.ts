import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  action as publicProgrammePageAction,
  loader as publicProgrammePageLoader,
} from "~/routes/public-programme";
import {
  itineraryCookie,
  publicItineraryIdentity,
} from "./public-itinerary-identity.server";
import { eventVisitorKeyHash } from "./public-itinerary-token.server";
import {
  PublicProgrammeService,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSessionNotFoundError,
  readCookie,
} from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists an anonymous itinerary by an event-specific keyed browser hash", async () => {
    const programmeService = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await programmeService.getPublished(
      "future-of-events-2027",
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
    const programme = await service.getPublished("future-of-events-2027");
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
        EVALUATION_MODE: "false",
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
      "future-of-events-2027",
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
        "future-of-events-2027",
      );
      expect(programme).not.toBeNull();
      const request = new Request(
        "https://programcue.test/public/programme/future-of-events-2027",
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
        params: { slug: "future-of-events-2027" },
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

  it("uses rate limiting without Turnstile for the production evaluation fixture itinerary", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const evaluationEnv = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
      BETTER_AUTH_URL: "https://programcue.test",
      BETTER_AUTH_SECRET:
        "programme-abuse-test-secret-with-at-least-thirty-two-characters",
    } as unknown as CloudflareEnvironment;
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: evaluationEnv,
      ctx: {} as ExecutionContext,
    });
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM abuse_rate_limits",
    ).first<{ total: number }>();

    const page = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    if (page instanceof Response) {
      throw new Error("Evaluation programme loader returned a raw response.");
    }
    expect(page.data).toMatchObject({
      itineraryVerificationRequired: false,
      turnstileSiteKey: null,
    });

    const programme = await new PublicProgrammeService(
      evaluationEnv,
    ).getPublished("future-of-events-2027");
    expect(programme).not.toBeNull();
    const response = await publicProgrammePageAction({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027",
        {
          method: "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.202",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            intent: "add",
            sessionId: programme!.sessions[0]!.id,
          }),
        },
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    if (response instanceof Response) {
      throw new Error("Evaluation itinerary action returned a raw response.");
    }

    expect(response.init?.status).toBeUndefined();
    expect(response.data).toMatchObject({ ok: true });
    expect(response.init?.headers).toEqual(
      expect.objectContaining({ "set-cookie": expect.any(String) }),
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS total FROM abuse_rate_limits").first<{
        total: number;
      }>(),
    ).resolves.toEqual({ total: (before?.total ?? 0) + 1 });
  });

  it("does not add a hidden published session to an anonymous visitor itinerary", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2027");
    expect(programme).not.toBeNull();
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const sessionId = activeProgramme.sessions[0]!.id;
    const itinerariesBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM public_itineraries WHERE event_id = ?`,
    )
      .bind(activeProgramme.event.id)
      .first<{ total: number }>();
    await env.DB.prepare(
      `UPDATE sessions SET visibility = 'hidden' WHERE id = ? AND event_id = ?`,
    )
      .bind(sessionId, activeProgramme.event.id)
      .run();
    try {
      await expect(
        service.updateItinerary(
          activeProgramme,
          { personId: null, visitorToken: null },
          sessionId,
          "add",
        ),
      ).rejects.toBeInstanceOf(PublishedProgrammeSessionNotFoundError);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS total FROM public_itineraries WHERE event_id = ?`,
        )
          .bind(activeProgramme.event.id)
          .first<{ total: number }>(),
      ).resolves.toEqual({ total: itinerariesBefore?.total ?? 0 });
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
          EVALUATION_MODE: "false",
          BETTER_AUTH_URL: "https://programcue.test",
          BETTER_AUTH_SECRET:
            "programme-abuse-test-secret-with-at-least-thirty-two-characters",
          TURNSTILE_SITE_KEY: "programme-site-key",
          TURNSTILE_SECRET_KEY: "programme-secret-key",
        } as unknown as CloudflareEnvironment,
        ctx: {} as ExecutionContext,
      });
      const response = await publicProgrammePageAction({
        request: new Request(
          "https://programcue.test/public/programme/future-of-events-2027",
          {
            method: "POST",
            headers: {
              "cf-connecting-ip": "203.0.113.209",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              intent: "add",
              sessionId,
              "turnstile-token": "verified-itinerary-token",
            }),
          },
        ),
        params: { slug: "future-of-events-2027" },
        context,
      } as never);
      if (response instanceof Response) {
        throw new Error("Hidden itinerary add returned a raw response.");
      }
      expect(response.init?.status).toBe(404);
      expect(response.data).toMatchObject({ ok: false });
    } finally {
      await env.DB.prepare(
        `UPDATE sessions SET visibility = 'public' WHERE id = ? AND event_id = ?`,
      )
        .bind(sessionId, activeProgramme.event.id)
        .run();
    }
  });

  it("does not treat a leftover hidden session as a successful add", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2027");
    expect(programme).not.toBeNull();
    const activeProgramme = {
      ...programme!,
      event: { ...programme!.event, endDate: "2099-05-22" },
    };
    const sessionId = activeProgramme.sessions[0]!.id;
    const { token } = await service.updateItinerary(
      activeProgramme,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    await env.DB.prepare(
      `UPDATE sessions SET visibility = 'hidden' WHERE id = ? AND event_id = ?`,
    )
      .bind(sessionId, activeProgramme.event.id)
      .run();
    try {
      await expect(
        service.updateItinerary(
          activeProgramme,
          { personId: null, visitorToken: token },
          sessionId,
          "add",
        ),
      ).rejects.toBeInstanceOf(PublishedProgrammeSessionNotFoundError);
      expect(
        await service.itinerary(activeProgramme, {
          personId: null,
          visitorToken: token,
        }),
      ).toEqual([]);
      const visitorHash = await eventVisitorKeyHash(
        env as unknown as CloudflareEnvironment,
        token!,
        activeProgramme.event.id,
      );
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS total
             FROM public_itinerary_items item
             JOIN public_itineraries itinerary
               ON itinerary.id = item.itinerary_id
            WHERE itinerary.event_id = ?
              AND itinerary.visitor_key_hash = ?
              AND item.session_id = ?`,
        )
          .bind(activeProgramme.event.id, visitorHash, sessionId)
          .first<{ total: number }>(),
      ).resolves.toEqual({ total: 1 });
    } finally {
      await env.DB.prepare(
        `UPDATE sessions SET visibility = 'public' WHERE id = ? AND event_id = ?`,
      )
        .bind(sessionId, activeProgramme.event.id)
        .run();
    }
  });

  it("rejects an unsigned visitor cookie instead of accepting a fixed bearer token", async () => {
    const attackerSelectedToken = `fixed-${crypto.randomUUID()}`;
    await expect(
      publicItineraryIdentity(
        new Request("https://programcue.test/public/programme/event", {
          headers: {
            cookie: `program_cue_itinerary=${encodeURIComponent(attackerSelectedToken)}`,
          },
        }),
        env as unknown as CloudflareEnvironment,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({ personId: null, visitorToken: null });
  });

  it("reuses one browser token without losing itineraries from another event", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2027");
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
    const secondOrganisationId = `itinerary-org-${suffix}`;
    const secondEventId = `itinerary-event-${suffix}`;
    const secondSessionId = `itinerary-session-${suffix}`;
    const secondVersionId = `itinerary-version-${suffix}`;
    const secondRoomId = `itinerary-room-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organisations (id, name, slug)
         VALUES (?, 'Second itinerary organisation', ?)`,
      ).bind(secondOrganisationId, `itinerary-org-${suffix}`),
      env.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'Second itinerary event', ?, 'UTC',
                  4070908800, 4071081599,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(secondEventId, secondOrganisationId, `itinerary-event-${suffix}`),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Second itinerary session', ?, 'presentation', 30,
                  'published', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(secondSessionId, secondEventId, `itinerary-session-${suffix}`),
      env.DB.prepare(
        `INSERT INTO rooms (id, event_id, name, capacity, position)
         VALUES (?, ?, 'Second itinerary room', 100, 0)`,
      ).bind(secondRoomId, secondEventId),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
           id, event_id, version_number, name, status, created_by_person_id,
           created_at, published_at
         ) VALUES (?, ?, 1, 'Second itinerary schedule', 'published',
                   'person-demo-admin', unixepoch(), unixepoch())`,
      ).bind(secondVersionId, secondEventId),
      env.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = 'approved', approved_by_person_id = NULL,
                approved_at = unixepoch(), approval_source = 'legacy_publication'
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
      ).bind(secondVersionId, secondEventId, secondSessionId),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
           id, event_id, schedule_version_id, session_id, room_id,
           starts_at, ends_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 4070908800, 4070910600, unixepoch(), unixepoch())`,
      ).bind(
        `itinerary-entry-${suffix}`,
        secondEventId,
        secondVersionId,
        secondSessionId,
        secondRoomId,
      ),
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
      version: {
        ...activeProgramme.version,
        id: secondVersionId,
      },
      sessions: [
        {
          ...activeProgramme.sessions[0],
          id: secondSessionId,
          slug: `itinerary-session-${suffix}`,
        },
      ],
    };

    const { token: reusedToken, expiresAt: secondItineraryExpiry } =
      await service.updateItinerary(
        secondProgramme,
        { personId: null, visitorToken: token },
        secondSessionId,
        "add",
      );
    expect(reusedToken).toBe(token);
    expect(secondItineraryExpiry).toBe(
      Math.floor(Date.parse("2099-01-02T23:59:59Z") / 1_000) + 365 * 86_400,
    );
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: reusedToken,
      }),
    ).toEqual([firstSessionId]);
    const [firstVisitorHash, secondVisitorHash] = await Promise.all([
      eventVisitorKeyHash(
        env as unknown as CloudflareEnvironment,
        token!,
        activeProgramme.event.id,
      ),
      eventVisitorKeyHash(
        env as unknown as CloudflareEnvironment,
        token!,
        secondEventId,
      ),
    ]);
    expect(firstVisitorHash).not.toBe(secondVisitorHash);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total FROM public_itineraries
          WHERE (event_id = ? AND visitor_key_hash = ?)
             OR (event_id = ? AND visitor_key_hash = ?)`,
      )
        .bind(
          activeProgramme.event.id,
          firstVisitorHash,
          secondEventId,
          secondVisitorHash,
        )
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 2 });
    await env.DB.prepare(
      `UPDATE public_itineraries
          SET expires_at = unixepoch() - 1
        WHERE event_id = ?`,
    )
      .bind(activeProgramme.event.id)
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
         FROM public_itineraries WHERE event_id = ? AND visitor_key_hash = ?`,
    )
      .bind(secondEventId, secondVisitorHash)
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
    ).toEqual({ total: 0 });
  });

  it("shares a read-only itinerary and syncs anonymous selections to a signed-in person", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2027");
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
    const programme = await service.getPublished("future-of-events-2027");
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

  it("does not retain legacy anonymous share links after the secret reset", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2027");
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
    const visitorHash = await eventVisitorKeyHash(
      env as unknown as CloudflareEnvironment,
      token!,
      programme!.event.id,
    );
    const downgraded = await env.DB.prepare(
      `UPDATE public_itineraries
          SET visitor_key_hash = 'legacy-unversioned-hash'
        WHERE event_id = ? AND person_id IS NULL AND visitor_key_hash = ?`,
    )
      .bind(programme!.event.id, visitorHash)
      .run();
    expect(downgraded.meta.changes).toBe(1);

    await expect(
      service.sharedItinerary(programme!, shareToken),
    ).rejects.toBeInstanceOf(PublishedProgrammeItineraryNotFoundError);
  });

  it("does not disclose itinerary items whose session is no longer public", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2027");
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

  it("reuses the signed browser identity while replacing an expired event row", async () => {
    const service = new PublicProgrammeService(
      env as unknown as CloudflareEnvironment,
    );
    const programme = await service.getPublished("future-of-events-2027");
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
    expect(replacementToken).toBe(expiredToken);
    expect(
      await service.itinerary(activeProgramme, {
        personId: null,
        visitorToken: expiredToken,
      }),
    ).toEqual([sessionId]);
  });

  it("fails fast when an event is beyond its itinerary retention window", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    await env.DB.prepare(
      `UPDATE events
          SET starts_at = unixepoch('1999-12-30T00:00:00Z'),
              ends_at = unixepoch('2000-01-01T23:59:59Z')
        WHERE id = ?`,
    )
      .bind("evt-foe-2025")
      .run();
    const programme = await service.getPublished("future-of-events-2027");
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
    const programme = await service.getPublished("future-of-events-2027");
    expect(programme).not.toBeNull();

    const sessionId = programme!.sessions[0].id;
    const { token, expiresAt } = await service.updateItinerary(
      programme!,
      { personId: null, visitorToken: null },
      sessionId,
      "add",
    );
    const visitorHash = await eventVisitorKeyHash(
      env as unknown as CloudflareEnvironment,
      token!,
      programme!.event.id,
    );

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

  it("keeps the fixed production evaluation fixture itinerary interactive", async () => {
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
    } as CloudflareEnvironment);
    const programme = await service.getPublished("future-of-events-2027");
    expect(programme).not.toBeNull();

    const now = Math.floor(Date.now() / 1_000);
    const sessionId = programme!.sessions[0].id;
    const { expiresAt } = await service.updateItinerary(
      programme!,
      { personId: "person-demo-admin", visitorToken: null },
      sessionId,
      "add",
    );

    expect(expiresAt).toBeGreaterThanOrEqual(now + 365 * 86_400);
    await expect(
      service.itinerary(programme!, {
        personId: "person-demo-admin",
        visitorToken: null,
      }),
    ).resolves.toEqual([sessionId]);

    await service.updateItinerary(
      programme!,
      { personId: "person-demo-admin", visitorToken: null },
      sessionId,
      "remove",
    );
  });

  it("signs the shared browser cookie and rejects tampering", async () => {
    const now = 1_800_000_000;
    const browserId = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const cookie = await itineraryCookie(
      env as unknown as CloudflareEnvironment,
      browserId,
      "https://programme.example/event",
      now,
    );
    const expiresAt = now + 5 * 365 * 86_400;
    expect(cookie).not.toContain(`program_cue_itinerary=${browserId};`);
    expect(decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!)).toMatch(
      /^v2\./u,
    );
    expect(cookie).toContain(`Max-Age=${5 * 365 * 86_400}`);
    expect(cookie).toContain(
      `Expires=${new Date(expiresAt * 1_000).toUTCString()}`,
    );
    expect(cookie).toContain("; Secure");
    const requestWithCookie = new Request("https://programme.example/event", {
      headers: { cookie: cookie.split(";")[0]! },
    });
    await expect(
      publicItineraryIdentity(
        requestWithCookie,
        env as unknown as CloudflareEnvironment,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({ personId: null, visitorToken: browserId });
    const hostCookie = cookie.split(";")[0]!;
    const hostValue = hostCookie.slice(hostCookie.indexOf("=") + 1);
    await expect(
      publicItineraryIdentity(
        new Request("https://programme.example/event", {
          headers: {
            cookie: `program_cue_itinerary=${hostValue}`,
          },
        }),
        env as unknown as CloudflareEnvironment,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({ personId: null, visitorToken: null });
    const encodedValue = cookie.split(";")[0]!.split("=")[1]!;
    const signedValue = decodeURIComponent(encodedValue);
    const tampered = `${signedValue.slice(0, -1)}${signedValue.endsWith("a") ? "b" : "a"}`;
    await expect(
      publicItineraryIdentity(
        new Request("https://programme.example/event", {
          headers: {
            cookie: `program_cue_itinerary=${encodeURIComponent(tampered)}`,
          },
        }),
        env as unknown as CloudflareEnvironment,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({ personId: null, visitorToken: null });
    expect(
      await itineraryCookie(
        env as unknown as CloudflareEnvironment,
        browserId,
        "http://localhost/programme",
        now,
      ),
    ).not.toContain("; Secure");
    expect(
      readCookie(
        new Request("https://programme.example/event", {
          headers: { cookie: "program_cue_itinerary=%not-valid" },
        }),
        "program_cue_itinerary",
      ),
    ).toBeNull();
  });

  it("keeps anonymous itinerary identity independent from authentication rotation", async () => {
    const browserId = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const itinerarySecret =
      "stable-anonymous-itinerary-secret-with-at-least-thirty-two-characters";
    const originalEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      BETTER_AUTH_SECRET:
        "original-authentication-secret-with-at-least-thirty-two-characters",
      ANONYMOUS_ITINERARY_SECRET: itinerarySecret,
    } as unknown as CloudflareEnvironment;
    const rotatedAuthenticationEnvironment = {
      ...originalEnvironment,
      BETTER_AUTH_SECRET:
        "rotated-authentication-secret-with-at-least-thirty-two-characters",
    } as CloudflareEnvironment;
    const cookie = await itineraryCookie(
      originalEnvironment,
      browserId,
      "https://programme.example/event",
    );
    const request = new Request("https://programme.example/event", {
      headers: { cookie: cookie.split(";")[0]! },
    });

    await expect(
      publicItineraryIdentity(
        request,
        rotatedAuthenticationEnvironment,
        "evt-foe-2025",
      ),
    ).resolves.toEqual({ personId: null, visitorToken: browserId });
    const originalHash = await eventVisitorKeyHash(
      originalEnvironment,
      browserId,
      "evt-foe-2025",
    );
    const rotatedHash = await eventVisitorKeyHash(
      rotatedAuthenticationEnvironment,
      browserId,
      "evt-foe-2025",
    );
    expect(originalHash).toMatch(/^v2\.[A-Za-z0-9_-]+$/u);
    expect(rotatedHash).toBe(originalHash);
  });

  it("does not fall back to the authentication secret for anonymous itineraries", async () => {
    const browserId = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const missingItinerarySecret = {
      ...(env as unknown as CloudflareEnvironment),
      BETTER_AUTH_SECRET:
        "configured-authentication-secret-with-at-least-thirty-two-characters",
      ANONYMOUS_ITINERARY_SECRET: undefined,
    } as unknown as CloudflareEnvironment;

    await expect(
      itineraryCookie(
        missingItinerarySecret,
        browserId,
        "https://programme.example/event",
      ),
    ).rejects.toThrow(/ANONYMOUS_ITINERARY_SECRET/u);
  });

  it("rejects authentication-secret reuse outside production readiness", async () => {
    const browserId = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const reusedSecret =
      "reused-authentication-secret-with-at-least-thirty-two-characters";
    const environment = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "development",
      BETTER_AUTH_SECRET: reusedSecret,
      ANONYMOUS_ITINERARY_SECRET: reusedSecret,
    } as unknown as CloudflareEnvironment;

    await expect(
      itineraryCookie(environment, browserId, "http://localhost/programme"),
    ).rejects.toThrow(/must be independent/u);
  });
});

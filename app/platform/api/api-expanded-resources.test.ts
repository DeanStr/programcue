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
  PUBLIC_CALENDAR_SESSION_ID_LIMIT,
  PUBLIC_CALENDAR_SESSION_LIMIT,
  publicCalendarQuerySchema,
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

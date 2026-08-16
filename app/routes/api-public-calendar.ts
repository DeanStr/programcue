import ical, { ICalCalendarMethod } from "ical-generator";
import { publicProgrammeSessionUrl } from "~/modules/programme/programme-presentation";
import { publicItineraryIdentity } from "~/modules/programme/public-itinerary-identity.server";
import {
  PublicProgrammeService,
  PublishedProgrammeItineraryNotFoundError,
} from "~/modules/programme/public-programme-service.server";
import { ApiError, apiFailure, correlationId } from "~/platform/api/api.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import {
  PUBLIC_CALENDAR_SESSION_ID_LIMIT,
  PUBLIC_CALENDAR_SESSION_LIMIT,
  publicCalendarQuerySchema,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  requirePublishedProgramme,
} from "~/platform/api/api-public-programme.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-public-calendar";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    const query = parseStrictQuery(request, publicCalendarQuerySchema);
    const service = new PublicProgrammeService(env);
    const programme = requirePublishedProgramme(
      await service.getPublished(params.slug ?? ""),
    );
    let requestedIds = query.sessions
      ? query.sessions.split(",").map((id) => id.trim())
      : null;
    if (
      requestedIds &&
      (requestedIds.length > PUBLIC_CALENDAR_SESSION_LIMIT ||
        requestedIds.some(
          (id) => !id || id.length > PUBLIC_CALENDAR_SESSION_ID_LIMIT,
        ) ||
        new Set(requestedIds).size !== requestedIds.length)
    ) {
      throw new ApiError(
        400,
        "INVALID_ITINERARY",
        "sessions must contain 1-50 distinct published session IDs.",
      );
    }
    if (query.itinerary) {
      requestedIds = await service.itinerary(
        programme,
        await publicItineraryIdentity(request, env, programme.event.id),
      );
    } else if (query.share !== undefined) {
      try {
        requestedIds = await service.sharedItinerary(programme, query.share);
      } catch (error) {
        if (error instanceof PublishedProgrammeItineraryNotFoundError) {
          throw new ApiError(404, "ITINERARY_NOT_FOUND", error.message);
        }
        throw error;
      }
    }
    const sessionById = new Map(
      programme.sessions.map((session) => [session.id, session]),
    );
    const sessions = requestedIds
      ? requestedIds.map((id) => {
          const session = sessionById.get(id);
          if (!session) {
            throw new ApiError(
              404,
              "SESSION_NOT_FOUND",
              `Itinerary session ${id} is not in the published programme.`,
            );
          }
          return session;
        })
      : programme.sessions;
    const cacheHeaders = requestedIds
      ? {
          "cache-control": "private, no-store",
          "access-control-allow-origin": "*",
        }
      : {
          ...(await publishedProgrammeCacheHeaders(request, programme)),
          "access-control-allow-origin": "*",
        };
    if (
      !requestedIds &&
      "etag" in cacheHeaders &&
      publishedProgrammeNotModified(request, cacheHeaders.etag)
    ) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    const calendar = ical({
      name: programme.event.name,
      prodId: {
        company: "Program Cue",
        product: "Published programme",
        language: "EN",
      },
    });
    calendar.method(ICalCalendarMethod.PUBLISH);
    for (const session of sessions) {
      calendar.createEvent({
        id: `${session.id}@programcue`,
        start: new Date(session.startsAt * 1_000),
        end: new Date(session.endsAt * 1_000),
        summary: session.title,
        description: [
          session.description,
          session.track,
          session.speakerNames.join(", "),
        ]
          .filter(Boolean)
          .join("\n\n"),
        location: [
          session.room,
          session.building,
          session.level,
          programme.event.venue,
        ]
          .filter(Boolean)
          .join(", "),
        url: publicProgrammeSessionUrl(
          env.BETTER_AUTH_URL,
          programme.event.slug,
          session.slug,
        ),
      });
    }
    return new Response(calendar.toString(), {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `inline; filename="${programme.event.slug}-${requestedIds ? "itinerary" : "programme"}.ics"`,
        ...cacheHeaders,
      },
    });
  } catch (error) {
    const response = apiFailure(
      error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
    response.headers.set("access-control-allow-origin", "*");
    return response;
  }
}

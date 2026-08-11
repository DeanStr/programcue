import ical, { ICalCalendarMethod } from "ical-generator";

import type { Route } from "./+types/api-public-calendar";
import { publicProgrammeSessionUrl } from "~/modules/programme/programme-presentation";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  emptyPublicQuerySchema,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  requirePublishedProgramme,
} from "~/platform/api/api-public-programme.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import { apiFailure, correlationId } from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    parseStrictQuery(request, emptyPublicQuerySchema);
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(params.slug ?? ""),
    );
    const cacheHeaders = {
      ...(await publishedProgrammeCacheHeaders(request, programme)),
      "access-control-allow-origin": "*",
    };
    if (publishedProgrammeNotModified(request, cacheHeaders.etag)) {
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
    for (const session of programme.sessions) {
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
        "content-disposition": `inline; filename="${programme.event.slug}-programme.ics"`,
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

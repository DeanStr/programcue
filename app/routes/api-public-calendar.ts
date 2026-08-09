import ical, { ICalCalendarMethod } from "ical-generator";

import type { Route } from "./+types/api-public-calendar";
import { publicProgrammeSessionUrl } from "~/modules/programme/programme-presentation";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { apiSuccess, correlationId } from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const programme = await new PublicProgrammeService(env).getPublished(
    params.slug ?? "",
  );
  if (!programme)
    return apiSuccess(
      {
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Published event programme not found",
        },
        correlationId: correlationId(request),
      },
      404,
      { "access-control-allow-origin": "*" },
    );
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
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}

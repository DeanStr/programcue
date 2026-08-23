import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import {
  PublicProgrammeService,
  type PublishedProgramme,
} from "~/modules/programme/public-programme-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
} from "~/platform/api/api.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import {
  publicProgrammeQuerySchema,
  publicProgrammeResponse,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  requirePublishedProgramme,
} from "~/platform/api/api-public-programme.server";
import {
  cspNonceContext,
  getCloudflareContext,
} from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-public-programme";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character];
  });
}

export function staticProgrammeHtml(
  programme: PublishedProgramme,
  cspNonce: string,
) {
  const accent = programmeAccentPalette(programme.event.brandAccent).accent;
  const dateTime = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: programme.event.timezone,
  });
  const sessions = programme.sessions
    .map(
      (session) => `<article id="session-${escapeHtml(session.slug)}">
  <p><strong>${escapeHtml(dateTime.format(new Date(session.startsAt * 1_000)))}</strong> · ${escapeHtml(session.room)}</p>
  <h2>${escapeHtml(session.title)}</h2>
  <p>${escapeHtml(session.speakerNames.join(", ") || "Speaker to be announced")}</p>
  <p>${escapeHtml(session.description)}</p>
</article>`,
    )
    .join("\n");
  const speakers = programme.speakers
    .map((speaker) => {
      const affiliation = [speaker.jobTitle, speaker.organisationName]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      return `<article id="speaker-${escapeHtml(speaker.id)}">
  <h2>${escapeHtml(speaker.displayName)}</h2>
  ${affiliation ? `<p>${escapeHtml(affiliation)}</p>` : ""}
  <p>${escapeHtml(speaker.biography ?? "Biography coming soon.")}</p>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(programme.event.name)} programme</title>
  <style nonce="${escapeHtml(cspNonce)}">body{font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem;color:#182522}header{border-bottom:3px solid ${accent};margin-bottom:2rem}article{padding:1rem 0;border-bottom:1px solid #e0e1d8}h1,h2{line-height:1.2}small{color:#61716c}@media(max-width:40rem){body{padding:1rem}}</style>
</head>
<body>
  <header><h1>${escapeHtml(programme.event.name)}</h1><p>${escapeHtml(programme.event.startDate)}–${escapeHtml(programme.event.endDate)} · ${escapeHtml(programme.event.timezone)}</p></header>
  <main><section aria-labelledby="sessions"><h2 id="sessions">Sessions</h2>${sessions}</section><section aria-labelledby="speakers"><h2 id="speakers">Speakers</h2>${speakers}</section></main>
  <footer><small>Published version ${programme.version.versionNumber} · exported by Program Cue</small></footer>
</body>
</html>`;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const cspNonce = context.get(cspNonceContext);
  const requestCorrelationId = correlationId(request);
  try {
    const rawFormat = new URL(request.url).searchParams.get("format");
    if (rawFormat !== null && rawFormat !== "json" && rawFormat !== "html") {
      throw new ApiError(
        400,
        "INVALID_EXPORT_FORMAT",
        "Programme export format must be json or html",
      );
    }
    const input = parseStrictQuery(
      request,
      publicProgrammeQuerySchema,
      "The programme filters are invalid",
    );
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(params.slug ?? ""),
    );
    const programmeCacheHeaders = await publishedProgrammeCacheHeaders(
      request,
      programme,
      "",
      "live",
    );
    const cacheHeaders = {
      ...programmeCacheHeaders,
      // The HTML representation contains a fresh CSP nonce on every response.
      // Its programme content is equivalent, but its bytes are not, so its
      // validator must be weak rather than claiming byte-for-byte identity.
      etag:
        input.format === "html"
          ? `W/${programmeCacheHeaders.etag}`
          : programmeCacheHeaders.etag,
      "access-control-allow-origin": "*",
    };
    if (publishedProgrammeNotModified(request, cacheHeaders.etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    const response = publicProgrammeResponse(programme, input);
    if (input.format === "json") {
      return new Response(`${JSON.stringify(response, null, 2)}\n`, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${programme.event.slug}-programme.json"`,
          ...cacheHeaders,
        },
      });
    }
    if (input.format === "html") {
      const sessionIds = new Set(
        response.sessions.map((session) => session.id),
      );
      return new Response(
        staticProgrammeHtml(
          {
            ...programme,
            sessions: programme.sessions.filter((session) =>
              sessionIds.has(session.id),
            ),
            speakers: response.speakers,
          },
          cspNonce,
        ),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-disposition": `attachment; filename="${programme.event.slug}-programme.html"`,
            ...cacheHeaders,
          },
        },
      );
    }
    return apiSuccess(response, 200, {
      ...cacheHeaders,
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

import { data } from "react-router";

import type { Route } from "./+types/public-programme";
import {
  ProgrammeEmbedConfigurationError,
  parseProgrammeEmbedSearchParameters,
} from "~/modules/programme/programme-embed-configuration";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import {
  PUBLIC_PROGRAMME_SURFACES,
  type PublicProgrammeSurface,
} from "~/modules/programme/programme-presentation";
import {
  PublishedProgrammeItineraryExpiredError,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSessionNotFoundError,
  PublicProgrammeService,
  readCookie,
} from "~/modules/programme/public-programme-service.server";
import { createAuth } from "~/platform/auth/auth.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";
import {
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
} from "~/platform/api/api-public-programme.server";

const ITINERARY_COOKIE = "program_cue_itinerary";

function surfaceFromRequest(request: Request): PublicProgrammeSurface {
  const segments = new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const publicIndex = segments.indexOf("public");
  const candidate =
    publicIndex >= 0 && segments[publicIndex + 1] === "programme"
      ? segments[publicIndex + 3]
      : undefined;
  if (!candidate) return "overview";
  if (
    !PUBLIC_PROGRAMME_SURFACES.includes(
      candidate as (typeof PUBLIC_PROGRAMME_SURFACES)[number],
    ) ||
    candidate === "overview"
  ) {
    throw new Response("Published programme surface not found", {
      status: 404,
    });
  }
  return candidate as Exclude<PublicProgrammeSurface, "overview">;
}

export function itineraryCookie(
  token: string,
  expiresAt: number | null,
  requestUrl: string,
  now = Math.floor(Date.now() / 1_000),
) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  const lifetime =
    expiresAt === null
      ? ""
      : `; Expires=${new Date(expiresAt * 1_000).toUTCString()}; Max-Age=${Math.max(0, expiresAt - now)}`;
  return `${ITINERARY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${lifetime}${secure}`;
}

export const meta = () => [{ title: "Event programme · Program Cue" }];

export function headers({
  loaderHeaders,
  actionHeaders,
  errorHeaders,
}: Route.HeadersArgs) {
  if (errorHeaders) return errorHeaders;
  const responseHeaders = new Headers(loaderHeaders);
  actionHeaders.forEach((value, name) => responseHeaders.set(name, value));
  return responseHeaders;
}

async function optionalPersonId(request: Request, env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) === "true") return null;
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  return session?.user.id ?? null;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const slug = params.slug;
  if (!slug) throw new Response("Published event not found", { status: 404 });
  const service = new PublicProgrammeService(env);
  const programme = await service.getPublished(slug);
  if (!programme)
    throw new Response("Published event programme not found", { status: 404 });
  const embedded = new URL(request.url).pathname.startsWith("/embed/");
  const surface = embedded ? "overview" : surfaceFromRequest(request);
  const url = new URL(request.url);
  let embedOptions;
  try {
    embedOptions = parseProgrammeEmbedSearchParameters(
      embedded ? url.searchParams : new URLSearchParams(),
    );
  } catch (error) {
    if (error instanceof ProgrammeEmbedConfigurationError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }
  const {
    day: embedDay,
    track: embedTrack,
    format: embedFormat,
    room: embedRoom,
    query: embedQuery,
    accent: embedAccent,
  } = embedOptions;
  if (
    embedDay &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(embedDay) ||
      !programme.sessions.some(
        (session) =>
          eventLocalCalendarDate(session.startsAt, programme.event.timezone) ===
          embedDay,
      ))
  ) {
    throw new Response("Embed day must identify a published programme day", {
      status: 400,
    });
  }
  if (
    embedTrack &&
    (embedTrack.length > 120 ||
      !programme.sessions.some((session) => session.track === embedTrack))
  ) {
    throw new Response("Embed track must identify a published track", {
      status: 400,
    });
  }
  if (
    embedFormat &&
    (embedFormat.length > 120 ||
      !programme.sessions.some((session) => session.format === embedFormat))
  ) {
    throw new Response("Embed format must identify a published format", {
      status: 400,
    });
  }
  if (
    embedRoom &&
    (embedRoom.length > 120 ||
      !programme.sessions.some((session) => session.room === embedRoom))
  ) {
    throw new Response("Embed room must identify a published room", {
      status: 400,
    });
  }
  if (embedQuery.length > 100) {
    throw new Response("Embed query must contain at most 100 characters", {
      status: 400,
    });
  }
  if (embedAccent && !/^#[0-9a-f]{6}$/iu.test(embedAccent)) {
    throw new Response("Embed accent must be a six-digit hexadecimal colour", {
      status: 400,
    });
  }
  const embeddedCacheHeaders = embedded
    ? await publishedProgrammeCacheHeaders(request, programme)
    : null;
  if (
    embeddedCacheHeaders &&
    publishedProgrammeNotModified(request, embeddedCacheHeaders.etag)
  ) {
    return new Response(null, {
      status: 304,
      headers: embeddedCacheHeaders,
    });
  }
  const shared = url.searchParams.has("share");
  const shareToken = url.searchParams.get("share") ?? "";
  const personId =
    embedded || shared ? null : await optionalPersonId(request, env);
  const visitorToken = readCookie(request, ITINERARY_COOKIE);
  const identity = { personId, visitorToken };
  const itineraryVerificationRequired =
    !embedded &&
    !shared &&
    personId === null &&
    !(await service.hasActiveAnonymousItinerary(programme, visitorToken));
  let itinerary: string[];
  try {
    itinerary = embedded
      ? []
      : shared
        ? await service.sharedItinerary(programme, shareToken)
        : await service.itinerary(programme, identity);
  } catch (error) {
    if (error instanceof PublishedProgrammeItineraryNotFoundError) {
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
  return data(
    {
      programme,
      surface,
      itinerary,
      embedded,
      embedOptions,
      signedIn: personId !== null,
      itineraryVerificationRequired,
      turnstileSiteKey: itineraryVerificationRequired
        ? publicAbuseClientConfiguration(env).turnstileSiteKey
        : null,
      itinerarySynced:
        !embedded && !shared
          ? await service.itineraryIsSynced(programme, identity)
          : false,
      shared,
    },
    {
      headers: {
        ...(embedded
          ? embeddedCacheHeaders!
          : { "cache-control": "private, no-store" }),
      },
    },
  );
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (new URL(request.url).pathname.startsWith("/embed/")) {
    return data(
      {
        ok: false,
        error: "Itinerary editing is unavailable in embedded programmes.",
      },
      { status: 405, headers: { allow: "GET" } },
    );
  }
  if (new URL(request.url).searchParams.has("share")) {
    return data(
      { ok: false, error: "Shared itineraries are read-only." },
      { status: 405, headers: { allow: "GET" } },
    );
  }
  const { env } = getCloudflareContext(context);
  const slug = params.slug;
  if (!slug) throw new Response("Published event not found", { status: 404 });
  const values = await request.formData();
  const intent = values.get("intent");
  if (intent !== "add" && intent !== "remove" && intent !== "share")
    throw new Response("Unsupported itinerary action", { status: 400 });
  const sessionId = String(values.get("sessionId") ?? "");
  const service = new PublicProgrammeService(env);
  const programme = await service.getPublished(slug);
  if (!programme)
    throw new Response("Published event programme not found", { status: 404 });
  try {
    const personId = await optionalPersonId(request, env);
    const visitorToken = readCookie(request, ITINERARY_COOKIE);
    if (intent === "share") {
      if (personId && visitorToken) {
        await service.syncItinerary(programme, { personId, visitorToken });
      }
      const shareToken = await service.shareItinerary(programme, {
        personId,
        visitorToken,
      });
      const shareUrl = new URL(
        `/public/programme/${programme.event.slug}`,
        request.url,
      );
      shareUrl.searchParams.set("share", shareToken);
      return data({ ok: true, shareUrl: shareUrl.toString() });
    }
    if (
      intent === "add" &&
      personId === null &&
      !(await service.hasActiveAnonymousItinerary(programme, visitorToken))
    ) {
      await enforcePublicAbuseProtection({
        env,
        request,
        action: "public_itinerary_create",
        tenantId: programme.event.id,
        email: "anonymous-itinerary",
        turnstileToken: String(values.get("turnstile-token") ?? ""),
      });
    }
    const itinerary = await service.updateItinerary(
      programme,
      { personId, visitorToken },
      sessionId,
      intent,
    );
    if (!itinerary.token) return data({ ok: true });
    return data(
      { ok: true },
      {
        headers: {
          "set-cookie": itineraryCookie(
            itinerary.token,
            itinerary.expiresAt,
            request.url,
          ),
        },
      },
    );
  } catch (error) {
    if (error instanceof PublishedProgrammeItineraryExpiredError) {
      return data({ ok: false, error: error.message }, { status: 410 });
    }
    if (error instanceof PublishedProgrammeSessionNotFoundError) {
      return data({ ok: false, error: error.message }, { status: 404 });
    }
    if (error instanceof PublishedProgrammeItineraryNotFoundError) {
      return data({ ok: false, error: error.message }, { status: 404 });
    }
    if (error instanceof AbuseRateLimitError) {
      return data(
        { ok: false, error: error.message },
        {
          status: 429,
          headers: { "retry-after": String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof TurnstileRejectedError) {
      return data({ ok: false, error: error.message }, { status: 422 });
    }
    if (
      error instanceof AbuseProtectionConfigurationError ||
      error instanceof TurnstileUnavailableError
    ) {
      return data(
        {
          ok: false,
          error:
            "Itinerary security is temporarily unavailable. Try again later.",
        },
        { status: 503 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

import { PublicProgrammeWorkspace } from "~/components/public-programme-workspace";

export { descriptionSnippet } from "~/components/public-programme-model";

export default function PublicProgramme({ loaderData }: Route.ComponentProps) {
  return <PublicProgrammeWorkspace loaderData={loaderData} />;
}

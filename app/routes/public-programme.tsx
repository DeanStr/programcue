import type { CSSProperties } from "react";
import {
  data,
  isRouteErrorResponse,
  redirect,
  type ShouldRevalidateFunctionArgs,
  useRouteError,
} from "react-router";
import {
  onlyClientSearchParametersChanged,
  PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS,
} from "~/lib/client-search-revalidation";
import { requireValue } from "~/lib/required-value";
import {
  ProgrammeEmbedConfigurationError,
  parseProgrammeEmbedSearchParameters,
  parseProgrammeEmbedSurface,
  programmeEmbedSearchConfiguration,
} from "~/modules/programme/programme-embed-configuration";
import {
  ProgrammeEmbedService,
  ProgrammeEmbedStateError,
} from "~/modules/programme/programme-embed-service.server";
import {
  PUBLIC_PROGRAMME_SURFACES,
  type PublicProgrammeSurface,
  publicProgrammeSurfacePath,
} from "~/modules/programme/programme-presentation";
import {
  itineraryCookie,
  publicItineraryIdentity,
} from "~/modules/programme/public-itinerary-identity.server";
import {
  PublicProgrammeService,
  PublishedProgrammeItineraryExpiredError,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSessionNotFoundError,
} from "~/modules/programme/public-programme-service.server";
import { publishedSocialCardRevision } from "~/modules/public-site/public-site-presentation";
import { getValidatedPublishedPublicSite } from "~/modules/public-site/validated-public-site.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import {
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
} from "~/platform/api/api-public-programme.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_EVENT_ID } from "~/platform/demo/demo-identities";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  enforcePublicRateLimit,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";
import type { Route } from "./+types/public-programme";

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
  formMethod,
}: ShouldRevalidateFunctionArgs) {
  if (
    (formMethod && formMethod.toUpperCase() !== "GET") ||
    !currentUrl.pathname.startsWith("/public/programme/") ||
    !nextUrl.pathname.startsWith("/public/programme/")
  ) {
    return defaultShouldRevalidate;
  }

  return onlyClientSearchParametersChanged(
    currentUrl,
    nextUrl,
    PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS,
  )
    ? false
    : defaultShouldRevalidate;
}

function isEvaluationFixtureEvent(env: CloudflareEnvironment, eventId: string) {
  return (
    String(env.APP_ENV) === "production" &&
    String(env.EVALUATION_MODE) === "true" &&
    eventId === DEMO_EVENT_ID
  );
}

function surfaceFromParam(
  candidate: string | undefined,
): PublicProgrammeSurface {
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

/**
 * Every unfurl of a customer's public programme previously carried the vendor
 * name and internal copy, because this returned a static title and nothing
 * else. The event owns this page; the platform does not appear.
 */
export const meta: Route.MetaFunction = ({ loaderData }) => {
  if (loaderData && "eventSiteOnly" in loaderData) {
    const { event, configuration, contentRevision, revision } = loaderData.site;
    const description =
      configuration.tagline || event.description || event.name;
    const socialCard = new URL(
      `/public/programme/${encodeURIComponent(event.slug)}/social-card.webp`,
      loaderData.canonicalUrl,
    );
    socialCard.searchParams.set(
      "v",
      publishedSocialCardRevision({
        siteContentRevision: contentRevision,
        siteRevision: revision,
      }),
    );
    return [
      { title: event.name },
      { name: "description", content: description },
      { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: event.name },
      { property: "og:title", content: event.name },
      { property: "og:description", content: description },
      { property: "og:url", content: loaderData.canonicalUrl },
      { property: "og:image", content: socialCard.toString() },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: socialCard.toString() },
      { name: "theme-color", content: event.brandAccent },
    ];
  }
  if (!loaderData || !("programme" in loaderData) || !loaderData.programme) {
    return [{ title: "Event programme" }];
  }
  const { event, sessions, speakers } = loaderData.programme;
  const place = [event.venue, event.city].filter(Boolean).join(", ");
  const description = loaderData.sessionShare
    ? loaderData.sessionShare.description
    : loaderData.speakerShare
      ? loaderData.speakerShare.description
      : (event.description ??
        `${sessions.length} sessions and ${speakers.length} speakers${place ? ` at ${place}` : ""}.`);
  const title = loaderData.sessionShare
    ? `${loaderData.sessionShare.sessionTitle} · ${event.name}`
    : loaderData.speakerShare
      ? `${loaderData.speakerShare.speakerName} · ${event.name}`
      : `Programme · ${event.name}`;
  const generatedShareImage = loaderData.site
    ? new URL(
        `/public/programme/${encodeURIComponent(event.slug)}/social-card.webp`,
        loaderData.canonicalUrl,
      )
    : null;
  if (generatedShareImage && loaderData.speakerShare) {
    generatedShareImage.searchParams.set(
      "speaker",
      loaderData.speakerShare.speakerId,
    );
  }
  if (generatedShareImage) {
    const site = requireValue(
      loaderData.site,
      "Required loaderData.site is unavailable.",
    );
    generatedShareImage.searchParams.set(
      "v",
      publishedSocialCardRevision({
        siteContentRevision: site.contentRevision,
        siteRevision: site.revision,
        programmeContentRevision: loaderData.programme.contentRevision,
        speakerId: loaderData.speakerShare?.speakerId,
      }),
    );
  }
  const shareImage =
    generatedShareImage?.toString() ??
    loaderData.speakerShare?.imageUrl ??
    (event.bannerUrl
      ? new URL(event.bannerUrl, loaderData.canonicalUrl).toString()
      : event.heroImageUrl);
  const logoUrl = event.logoUrl
    ? new URL(event.logoUrl, loaderData.canonicalUrl).toString()
    : null;

  return [
    { title },
    ...(logoUrl ? [{ tagName: "link", rel: "icon", href: logoUrl }] : []),
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: event.name },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: loaderData.canonicalUrl },
    ...(shareImage
      ? [
          {
            property: "og:image",
            content: shareImage,
          },
        ]
      : []),
    {
      name: "twitter:card",
      content: shareImage ? "summary_large_image" : "summary",
    },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    ...(shareImage
      ? [
          {
            name: "twitter:image",
            content: shareImage,
          },
        ]
      : []),
    { name: "theme-color", content: event.brandAccent },
  ];
};

function shareDescription(value: string | null | undefined) {
  const normalised = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (normalised.length <= 180) return normalised;
  const candidate = normalised.slice(0, 180);
  const boundary = candidate.lastIndexOf(" ");
  return `${(boundary > 90 ? candidate.slice(0, boundary) : candidate).trimEnd()}…`;
}

export function headers({
  loaderHeaders,
  actionHeaders,
  errorHeaders,
}: Route.HeadersArgs) {
  if (errorHeaders) return errorHeaders;
  const responseHeaders = new Headers(loaderHeaders);
  actionHeaders.forEach((value, name) => {
    responseHeaders.set(name, value);
  });
  return responseHeaders;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const slug = params.slug;
  if (!slug) throw new Response("Published event not found", { status: 404 });
  const url = new URL(request.url);
  const embedded = url.pathname.startsWith("/embed/");
  // Preserve already-shared chronological Agenda URLs without keeping Agenda
  // as an authorable surface. Managed agenda embeds are normalised when their
  // configuration loads and installed widgets normalise in the hosted script.
  if (params.surface === "agenda") {
    const destination = new URL(request.url);
    destination.pathname = embedded
      ? `/embed/${encodeURIComponent(slug)}/schedule`
      : publicProgrammeSurfacePath(slug, "schedule");
    throw redirect(`${destination.pathname}${destination.search}`, 308);
  }
  const managedEmbedSlug =
    "embedSlug" in params && typeof params.embedSlug === "string"
      ? params.embedSlug
      : null;
  let managedEmbed = null;
  if (managedEmbedSlug) {
    try {
      managedEmbed = await new ProgrammeEmbedService(env).getPublic(
        slug,
        managedEmbedSlug,
      );
    } catch (error) {
      if (
        error instanceof ProgrammeEmbedConfigurationError ||
        error instanceof ProgrammeEmbedStateError
      ) {
        throw new Response(
          "Managed embed configuration is invalid. Contact the event organiser.",
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
    if (!managedEmbed || managedEmbed.status === "draft") {
      throw new Response("Managed embed not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    if (managedEmbed.status === "paused" || managedEmbed.status === "revoked") {
      const paused = managedEmbed.status === "paused";
      throw data(
        {
          embedUnavailable: true as const,
          eventName: managedEmbed.eventName,
          eventAccent: managedEmbed.eventAccent,
          state: managedEmbed.status,
          message: paused
            ? "This programme embed is temporarily unavailable."
            : "This programme embed is no longer available.",
        },
        {
          status: paused ? 503 : 410,
          headers: {
            "cache-control": "no-store",
            ...(paused ? { "retry-after": "300" } : {}),
          },
        },
      );
    }
    if (url.search) {
      throw new Response(
        "Managed embed URLs do not accept query-string configuration.",
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  }
  const requestedSessionValues = url.searchParams.getAll("session");
  if (requestedSessionValues.length > 1) {
    throw new Response("Choose one published session", { status: 400 });
  }
  if (requestedSessionValues.length > 0 && url.searchParams.has("speaker")) {
    throw new Response("Choose either a speaker or a session to share", {
      status: 400,
    });
  }
  const service = new PublicProgrammeService(env);
  const programme = await service.getPublished(slug);
  if (!programme) {
    if (requestedSessionValues.length) {
      throw new Response("Published session not found", { status: 404 });
    }
    if (embedded || managedEmbed || params.surface) {
      throw new Response("Published event programme not found", {
        status: 404,
      });
    }
    const site = await getValidatedPublishedPublicSite(env, slug, null);
    if (!site) throw new Response("Published event not found", { status: 404 });
    const canonicalUrl = new URL(
      `/public/programme/${encodeURIComponent(site.event.slug)}`,
      request.url,
    ).toString();
    const cacheHeaders = await publishedProgrammeCacheHeaders(
      request,
      site,
      `public-site-${site.revision}`,
      "live",
    );
    if (publishedProgrammeNotModified(request, cacheHeaders.etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    return data(
      {
        eventSiteOnly: true as const,
        site,
        canonicalUrl,
        programme: null,
        speakerShare: null,
        surface: "overview" as const,
      },
      { headers: cacheHeaders },
    );
  }
  const site = embedded
    ? null
    : await getValidatedPublishedPublicSite(env, slug, programme);
  let surface: PublicProgrammeSurface;
  try {
    surface = managedEmbed
      ? managedEmbed.configuration.surface
      : embedded
        ? parseProgrammeEmbedSurface(params.surface)
        : surfaceFromParam(params.surface);
  } catch (error) {
    if (error instanceof ProgrammeEmbedConfigurationError) {
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
  const requestedSpeakerId = url.searchParams.get("speaker");
  const featuredSpeaker = requestedSpeakerId
    ? (programme.speakers.find(
        (speaker) => speaker.id === requestedSpeakerId,
      ) ?? null)
    : null;
  if (requestedSpeakerId !== null && !featuredSpeaker) {
    throw new Response("Published speaker profile not found", { status: 404 });
  }
  const requestedSessionId = requestedSessionValues[0] ?? null;
  const featuredSession = requestedSessionId
    ? (programme.sessions.find(
        (session) => session.id === requestedSessionId,
      ) ?? null)
    : null;
  if (requestedSessionId !== null && !featuredSession) {
    throw new Response("Published session not found", { status: 404 });
  }
  if (featuredSession && (embedded || surface !== "sessions")) {
    if (embedded || managedEmbed) {
      throw new Response(
        "Published session detail is available on the sessions view",
        { status: 400 },
      );
    }
    const destination = new URL(request.url);
    destination.pathname = publicProgrammeSurfacePath(
      programme.event.slug,
      "sessions",
    );
    destination.searchParams.set("session", featuredSession.id);
    throw redirect(`${destination.pathname}${destination.search}`);
  }
  const canonicalUrl = new URL(
    managedEmbed
      ? `/embed/${encodeURIComponent(programme.event.slug)}/saved/${encodeURIComponent(managedEmbed.slug)}`
      : embedded
        ? `/embed/${encodeURIComponent(programme.event.slug)}${surface === "overview" ? "" : `/${surface}`}`
        : `/public/programme/${encodeURIComponent(programme.event.slug)}${surface === "overview" ? "" : `/${surface}`}`,
    request.url,
  );
  let speakerShare = null;
  if (featuredSpeaker) {
    canonicalUrl.pathname = `/public/programme/${encodeURIComponent(programme.event.slug)}`;
    canonicalUrl.searchParams.set("speaker", featuredSpeaker.id);
    const speakerSession = programme.sessions.find((session) =>
      featuredSpeaker.sessionIds.includes(session.id),
    );
    const fallbackDescription = speakerSession
      ? `${featuredSpeaker.displayName} is speaking at ${programme.event.name}: ${speakerSession.title}.`
      : `${featuredSpeaker.displayName} is speaking at ${programme.event.name}.`;
    const releasedHeadshotPath = await service.getReleasedPublishedHeadshotPath(
      programme.event.slug,
      featuredSpeaker.id,
    );
    const shareUrl = canonicalUrl.toString();
    speakerShare = {
      speakerId: featuredSpeaker.id,
      speakerName: featuredSpeaker.displayName,
      sessionTitle: speakerSession?.title ?? null,
      description:
        shareDescription(featuredSpeaker.biography) || fallbackDescription,
      url: shareUrl,
      text: speakerSession
        ? `${featuredSpeaker.displayName} is speaking at ${programme.event.name}: ${speakerSession.title}.`
        : `${featuredSpeaker.displayName} is speaking at ${programme.event.name}.`,
      imageUrl: releasedHeadshotPath
        ? new URL(releasedHeadshotPath, request.url).toString()
        : null,
    };
  }
  if (featuredSession) {
    canonicalUrl.searchParams.set("session", featuredSession.id);
  }
  const sessionShare = featuredSession
    ? {
        sessionId: featuredSession.id,
        sessionTitle: featuredSession.title,
        description:
          shareDescription(featuredSession.description) ||
          `${featuredSession.title} is part of ${programme.event.name}.`,
        url: canonicalUrl.toString(),
      }
    : null;
  let embedOptions: ReturnType<typeof parseProgrammeEmbedSearchParameters>;
  try {
    embedOptions = managedEmbed
      ? programmeEmbedSearchConfiguration(managedEmbed.configuration)
      : parseProgrammeEmbedSearchParameters(
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
  const rejectEmbedSelection = (message: string): never => {
    if (managedEmbed) {
      throw new Response(
        "Managed embed configuration no longer matches the published programme. Contact the event organiser.",
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    throw new Response(message, { status: 400 });
  };
  if (
    embedDay &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(embedDay) ||
      !programme.sessions.some(
        (session) =>
          eventLocalCalendarDate(session.startsAt, programme.event.timezone) ===
          embedDay,
      ))
  ) {
    rejectEmbedSelection("Embed day must identify a published programme day");
  }
  if (
    embedTrack &&
    (embedTrack.length > 120 ||
      !programme.sessions.some((session) => session.track === embedTrack))
  ) {
    rejectEmbedSelection("Embed track must identify a published track");
  }
  if (
    embedFormat &&
    (embedFormat.length > 120 ||
      !programme.sessions.some((session) => session.format === embedFormat))
  ) {
    rejectEmbedSelection("Embed format must identify a published format");
  }
  if (
    embedRoom &&
    (embedRoom.length > 120 ||
      !programme.sessions.some((session) => session.room === embedRoom))
  ) {
    rejectEmbedSelection("Embed room must identify a published room");
  }
  if (embedQuery.length > 100) {
    rejectEmbedSelection("Embed query must contain at most 100 characters");
  }
  if (embedAccent && !/^#[0-9a-f]{6}$/iu.test(embedAccent)) {
    rejectEmbedSelection("Embed accent must be a six-digit hexadecimal colour");
  }
  const embeddedCacheHeaders = embedded
    ? await publishedProgrammeCacheHeaders(
        request,
        programme,
        managedEmbed
          ? `managed-embed-${managedEmbed.id}-${managedEmbed.revision}`
          : "",
      )
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
  const identity =
    embedded || shared
      ? { personId: null, visitorToken: null }
      : await publicItineraryIdentity(request, env, programme.event.id);
  const { personId, visitorToken } = identity;
  const itineraryVerificationRequired =
    !embedded &&
    !shared &&
    personId === null &&
    !isEvaluationFixtureEvent(env, programme.event.id) &&
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
      site,
      canonicalUrl: canonicalUrl.toString(),
      speakerShare,
      sessionShare,
      sessionFocusId: featuredSession?.id ?? null,
      surface,
      itinerary,
      embedded,
      embedOptions,
      managedEmbedRevision: managedEmbed?.revision ?? null,
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
      calendarExportQuery: shared
        ? new URLSearchParams({ share: shareToken }).toString()
        : new URLSearchParams({ itinerary: "mine" }).toString(),
    },
    {
      headers: {
        ...(embedded
          ? requireValue(
              embeddedCacheHeaders,
              "Required embeddedCacheHeaders is unavailable.",
            )
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
    const { personId, visitorToken } = await publicItineraryIdentity(
      request,
      env,
      programme.event.id,
    );
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
      const protection = {
        env,
        request,
        action: "public_itinerary_create" as const,
        tenantId: programme.event.id,
        email: "anonymous-itinerary",
      };
      if (isEvaluationFixtureEvent(env, programme.event.id)) {
        await enforcePublicRateLimit(protection);
      } else {
        await enforcePublicAbuseProtection({
          ...protection,
          turnstileToken: String(values.get("turnstile-token") ?? ""),
        });
      }
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
          "set-cookie": await itineraryCookie(
            env,
            itinerary.token,
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
import { PublicEventSiteWorkspace } from "~/components/public-site-content";

export { descriptionSnippet } from "~/components/public-programme-model";

export default function PublicProgramme({ loaderData }: Route.ComponentProps) {
  if ("eventSiteOnly" in loaderData)
    return <PublicEventSiteWorkspace site={loaderData.site} />;
  return <PublicProgrammeWorkspace loaderData={loaderData} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (
    isRouteErrorResponse(error) &&
    error.data &&
    typeof error.data === "object" &&
    "embedUnavailable" in error.data
  ) {
    const unavailable = error.data as {
      eventName: string;
      eventAccent: string;
      message: string;
    };
    return (
      <main
        className="public-shell event-branded embedded"
        style={{ "--event-accent": unavailable.eventAccent } as CSSProperties}
      >
        <section className="card pad empty-state" role="status">
          <span className="pc-page-eyebrow">{unavailable.eventName}</span>
          <h1>Programme unavailable</h1>
          <p>{unavailable.message}</p>
        </section>
      </main>
    );
  }
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? typeof error.data === "string"
      ? error.data
      : error.statusText || "Published programme unavailable"
    : "Published programme unavailable";
  return (
    <main className="public-shell">
      <section className="card pad empty-state" role="alert">
        <h1>
          {status === 404 ? "Programme not found" : "Programme unavailable"}
        </h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

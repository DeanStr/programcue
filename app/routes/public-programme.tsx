import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { data, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/public-programme";
import { TurnstileWidget } from "~/components/turnstile-widget";
import { formatProgrammeEventDay } from "~/modules/programme/programme-presentation";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import {
  PublishedProgrammeItineraryExpiredError,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSessionNotFoundError,
  PublicProgrammeService,
  readCookie,
  type PublishedSpeaker,
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
  const url = new URL(request.url);
  const embedDay = embedded
    ? url.searchParams.get("day")?.trim() || null
    : null;
  const embedTrack = embedded
    ? url.searchParams.get("track")?.trim() || null
    : null;
  const embedQuery = embedded
    ? url.searchParams.get("query")?.trim() || ""
    : "";
  const embedAccent = embedded
    ? url.searchParams.get("accent")?.trim() || null
    : null;
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
    (embedTrack.length > 100 ||
      !programme.sessions.some((session) => session.track === embedTrack))
  ) {
    throw new Response("Embed track must identify a published track", {
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
      itinerary,
      embedded,
      embedOptions: {
        day: embedDay,
        track: embedTrack,
        query: embedQuery,
        accent: embedAccent,
      },
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

function formatDay(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function formatTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

const DESCRIPTION_SNIPPET_LENGTH = 180;

export function descriptionSnippet(description: string) {
  const collapsed = normaliseDescription(description);
  if (collapsed.length <= DESCRIPTION_SNIPPET_LENGTH) return collapsed;
  const cut = collapsed.slice(0, DESCRIPTION_SNIPPET_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > DESCRIPTION_SNIPPET_LENGTH / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function normaliseDescription(description: string) {
  return description.replace(/\s+/gu, " ").trim();
}

function initials(name: string) {
  return (
    name
      .split(/\s+/u)
      .map((part) => part[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2) || "PC"
  );
}

function distinctSorted(values: Array<string | null>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ].sort((left, right) => left.localeCompare(right));
}

function speakerAffiliation(
  speaker: Pick<PublishedSpeaker, "jobTitle" | "organisationName">,
) {
  return [speaker.jobTitle, speaker.organisationName]
    .filter(Boolean)
    .join(" · ");
}

export default function PublicProgramme({ loaderData }: Route.ComponentProps) {
  const { programme } = loaderData;
  const location = useLocation();
  const embedded = loaderData.embedded;
  const shared = loaderData.shared;
  const embedOptions = loaderData.embedOptions;
  const fetcher = useFetcher<typeof action>();
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const previousFetcherState = useRef(fetcher.state);
  const shareUrl =
    fetcher.data &&
    "shareUrl" in fetcher.data &&
    typeof fetcher.data.shareUrl === "string"
      ? fetcher.data.shareUrl
      : null;
  const saved = loaderData.itinerary;
  const [query, setQuery] = useState(embedOptions.query);
  const days = useMemo(
    () => [
      ...new Set(
        programme.sessions.map((session) =>
          formatDay(session.startsAt, programme.event.timezone),
        ),
      ),
    ],
    [programme],
  );
  const initialEmbedDay = embedOptions.day
    ? programme.sessions.find(
        (session) =>
          eventLocalCalendarDate(session.startsAt, programme.event.timezone) ===
          embedOptions.day,
      )
    : null;
  const [day, setDay] = useState(
    initialEmbedDay
      ? formatDay(initialEmbedDay.startsAt, programme.event.timezone)
      : "All days",
  );
  const [track, setTrack] = useState("");
  const [format, setFormat] = useState("");
  const [room, setRoom] = useState("");
  const [expandedDescriptions, setExpandedDescriptions] = useState<string[]>(
    [],
  );
  const tracks = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.track)),
    [programme.sessions],
  );
  const formats = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.format)),
    [programme.sessions],
  );
  const rooms = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.room)),
    [programme.sessions],
  );
  const speakerById = useMemo(
    () =>
      new Map(
        programme.speakers.map((speaker) => [speaker.id, speaker] as const),
      ),
    [programme.speakers],
  );
  const [selectedId, setSelectedId] = useState(programme.sessions[0]?.id ?? "");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const speakerProfileRef = useRef<HTMLElement | null>(null);
  const speakerProfileReturnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!embedded) return;
    const publishHeight = () => {
      window.parent.postMessage(
        {
          type: "programcue:resize",
          eventSlug: programme.event.slug,
          height: Math.ceil(document.documentElement.scrollHeight),
        },
        "*",
      );
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(document.body);
    window.addEventListener("load", publishHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("load", publishHeight);
    };
  }, [embedded, programme.event.slug]);
  useEffect(() => {
    if (location.hash.startsWith("#session-")) {
      const slug = location.hash.slice("#session-".length);
      const linked = programme.sessions.find(
        (session) => session.slug === slug,
      );
      if (linked) setSelectedId(linked.id);
    } else if (location.hash.startsWith("#speaker-")) {
      const personId = location.hash.slice("#speaker-".length);
      const linked = programme.speakers.find(
        (speaker) => speaker.id === personId,
      );
      if (linked) setSelectedSpeakerId(linked.id);
    }
  }, [location.hash, programme.sessions, programme.speakers]);
  const normalisedQuery = query.trim().toLocaleLowerCase();
  const sessionsMatchingFacets = useMemo(
    () =>
      programme.sessions.filter((session) => {
        const matchesDay =
          day === "All days" ||
          formatDay(session.startsAt, programme.event.timezone) === day;
        const matchesEmbedTrack =
          !embedOptions.track || session.track === embedOptions.track;
        const matchesTrack = !track || session.track === track;
        const matchesFormat = !format || session.format === format;
        const matchesRoom = !room || session.room === room;
        return (
          matchesDay &&
          matchesEmbedTrack &&
          matchesTrack &&
          matchesFormat &&
          matchesRoom
        );
      }),
    [day, embedOptions.track, format, programme, room, track],
  );
  const visible = useMemo(
    () =>
      sessionsMatchingFacets.filter((session) =>
        [
          session.title,
          session.description,
          session.speakerNames.join(" "),
          session.track,
          session.format,
          session.room,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalisedQuery),
      ),
    [normalisedQuery, sessionsMatchingFacets],
  );
  const sessionFiltersActive =
    day !== "All days" || Boolean(track) || Boolean(format) || Boolean(room);
  const filtersActive = sessionFiltersActive || query.trim() !== "";
  const selected =
    visible.find((session) => session.id === selectedId) ?? visible[0] ?? null;
  const visibleSessionIds = new Set(visible.map((session) => session.id));
  const facetSpeakerIds = new Set(
    sessionsMatchingFacets.flatMap((session) => session.speakerIds),
  );
  const visibleSpeakerIds = new Set(
    visible.flatMap((session) => session.speakerIds),
  );
  const visibleSpeakers = programme.speakers.filter((speaker) => {
    const matchesFacets =
      (!embedded && !sessionFiltersActive) || facetSpeakerIds.has(speaker.id);
    const matchesQuery =
      !normalisedQuery ||
      visibleSpeakerIds.has(speaker.id) ||
      [
        speaker.displayName,
        speaker.jobTitle,
        speaker.organisationName,
        speaker.biography,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalisedQuery);
    return matchesFacets && matchesQuery;
  });
  const selectedSpeaker =
    visibleSpeakers.find((speaker) => speaker.id === selectedSpeakerId) ?? null;
  const selectedSpeakerSessions = selectedSpeaker
    ? programme.sessions.filter(
        (session) =>
          selectedSpeaker.sessionIds.includes(session.id) &&
          visibleSessionIds.has(session.id),
      )
    : [];
  const savedSessions = programme.sessions.filter((session) =>
    saved.includes(session.id),
  );
  const itineraryConflicts = savedSessions.flatMap((session, index) =>
    savedSessions
      .slice(index + 1)
      .filter(
        (other) =>
          session.startsAt < other.endsAt && other.startsAt < session.endsAt,
      )
      .map((other) => [session.title, other.title] as const),
  );

  useEffect(() => {
    if (previousFetcherState.current !== "idle" && fetcher.state === "idle") {
      setTurnstileResetKey((value) => value + 1);
    }
    previousFetcherState.current = fetcher.state;
  }, [fetcher.state]);

  // Opening a speaker profile moves reading position to the panel; closing it
  // returns focus to the exact control that opened it.
  useEffect(() => {
    if (selectedSpeakerId) speakerProfileRef.current?.focus();
  }, [selectedSpeakerId]);

  // Do not silently reopen a profile if later filter changes remove its
  // speaker from the result set and those filters are subsequently cleared.
  useEffect(() => {
    if (selectedSpeakerId && !selectedSpeaker) {
      setSelectedSpeakerId("");
      speakerProfileReturnFocusRef.current = null;
    }
  }, [selectedSpeaker, selectedSpeakerId]);

  function openSpeakerProfile(speakerId: string, trigger: HTMLElement) {
    speakerProfileReturnFocusRef.current = trigger;
    setSelectedSpeakerId(speakerId);
  }

  function closeSpeakerProfile() {
    const returnFocus = speakerProfileReturnFocusRef.current;
    const fallbackFocus = selectedSpeakerId
      ? document.getElementById(`speaker-profile-link-${selectedSpeakerId}`)
      : null;
    setSelectedSpeakerId("");
    speakerProfileReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (fallbackFocus?.isConnected) fallbackFocus.focus();
    });
  }

  function toggleDescription(sessionId: string) {
    setExpandedDescriptions((current) =>
      current.includes(sessionId)
        ? current.filter((value) => value !== sessionId)
        : [...current, sessionId],
    );
  }

  function clearFilters() {
    setQuery("");
    setDay("All days");
    setTrack("");
    setFormat("");
    setRoom("");
  }

  function selectSavedSession(sessionId: string) {
    if (!visibleSessionIds.has(sessionId)) clearFilters();
    setSelectedId(sessionId);
  }

  function toggle(sessionId: string) {
    if (shared) return;
    void fetcher.submit(
      {
        intent: saved.includes(sessionId) ? "remove" : "add",
        sessionId,
        "turnstile-token": turnstileToken,
      },
      { method: "post" },
    );
  }

  return (
    <div
      className={`public-shell event-branded${embedded ? " embedded" : ""}`}
      style={
        {
          "--event-accent": embedOptions.accent ?? programme.event.brandAccent,
        } as React.CSSProperties
      }
    >
      {!embedded ? (
        <header className="public-top">
          <Link
            className="brand"
            to={`/public/programme/${programme.event.slug}`}
            style={{ color: "var(--ink)", padding: 0 }}
          >
            <span className="brand-mark">P</span>
            <span>Program Cue</span>
          </Link>
          <nav className="public-nav" aria-label="Programme">
            <a className="active" href="#programme" aria-current="page">
              Programme
            </a>
            <a href="#speakers">Speakers</a>
          </nav>
          <details className="public-mobile-nav">
            <summary className="btn small">Browse</summary>
            <nav aria-label="Programme sections">
              <a href="#programme" aria-current="page">
                Programme
              </a>
              <a href="#speakers">Speakers</a>
            </nav>
          </details>
          <a className="btn" href="#itinerary">
            ♡ {shared ? "Shared itinerary" : "My itinerary"}{" "}
            <span className="status info">{saved.length}</span>
          </a>
        </header>
      ) : null}
      <section
        className="hero"
        style={
          {
            "--event-accent":
              embedOptions.accent ?? programme.event.brandAccent,
            background: embedOptions.accent
              ? `linear-gradient(135deg, #0f172a, ${embedOptions.accent})`
              : undefined,
          } as React.CSSProperties
        }
      >
        <span className="status info">
          Published version {programme.version.versionNumber}
        </span>
        <h1>{programme.event.name}</h1>
        <p
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <CalendarDays aria-hidden="true" size={15} />{" "}
          <span>
            {formatProgrammeEventDay(programme.event.startDate)}–
            {formatProgrammeEventDay(programme.event.endDate)}
          </span>
          <span aria-hidden="true">·</span>
          <MapPin aria-hidden="true" size={15} />{" "}
          <span>
            {[programme.event.venue, programme.event.city]
              .filter(Boolean)
              .join(", ")}
          </span>
        </p>
      </section>
      <main id="main" className="public-main">
        <div className="public-content" id="programme">
          {fetcher.data && "error" in fetcher.data ? (
            <div className="validation-item error mb" role="alert">
              <strong>Itinerary not updated</strong>
              <span>{String(fetcher.data.error)}</span>
            </div>
          ) : null}
          {shareUrl ? (
            <div className="validation-item ok mb" role="status">
              <strong>Share link ready</strong>
              <a href={shareUrl}>{shareUrl}</a>
              <span>The link is read-only. Creating another rotates it.</span>
            </div>
          ) : null}
          <div className="public-filters">
            {embedOptions.track ? (
              <span className="status info">Track · {embedOptions.track}</span>
            ) : null}
            <input
              className="field"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions, speakers, or topics"
              aria-label="Search sessions, speakers, or topics"
              style={{ flex: 1 }}
            />
            <select
              className="select"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              aria-label="Filter by day"
            >
              <option>All days</option>
              {days.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            {!embedOptions.track && tracks.length > 1 ? (
              <select
                className="select"
                value={track}
                onChange={(event) => setTrack(event.target.value)}
                aria-label="Filter by track"
              >
                <option value="">All tracks</option>
                {tracks.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : null}
            {formats.length > 1 ? (
              <select
                className="select"
                value={format}
                onChange={(event) => setFormat(event.target.value)}
                aria-label="Filter by format"
              >
                <option value="">All formats</option>
                {formats.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : null}
            {rooms.length > 1 ? (
              <select
                className="select"
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                aria-label="Filter by room"
              >
                <option value="">All rooms</option>
                {rooms.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={clearFilters}
              disabled={!filtersActive}
            >
              Clear filters
            </button>
          </div>
          <p className="public-filter-summary help" role="status">
            Showing {visible.length} of {programme.sessions.length} published
            session{programme.sessions.length === 1 ? "" : "s"}
            {filtersActive ? " for the current filters" : ""}.
          </p>
          <div className="programme-list">
            {visible.length ? (
              visible.map((session) => {
                const sessionSpeakers = session.speakerIds.map(
                  (speakerId, index) => {
                    const speaker = speakerById.get(speakerId)!;
                    return {
                      id: speakerId,
                      name: session.speakerNames[index]!,
                      affiliation: speakerAffiliation(speaker),
                    };
                  },
                );
                const description = normaliseDescription(session.description);
                const snippet = descriptionSnippet(description);
                const expanded = expandedDescriptions.includes(session.id);
                return (
                  <div
                    className={`programme-entry${session.id === selected?.id ? " active" : ""}`}
                    key={session.id}
                  >
                    <button
                      type="button"
                      id={`session-${session.slug}`}
                      className={`programme-row${session.id === selected?.id ? " active" : ""}`}
                      aria-pressed={session.id === selected?.id}
                      onClick={() => setSelectedId(session.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        borderTop: 0,
                        borderLeft: 0,
                        borderRight: 0,
                      }}
                    >
                      <div>
                        <strong>
                          {formatTime(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </strong>
                        <small className="subtle" style={{ display: "block" }}>
                          {formatDay(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </small>
                      </div>
                      <div>
                        <span className="pill">{session.format}</span>
                        <h3>{session.title}</h3>
                        <div className="programme-row-speakers">
                          {sessionSpeakers.length ? (
                            sessionSpeakers.map((speaker) => (
                              <div
                                className="programme-row-speaker"
                                key={speaker.id}
                              >
                                <span className="speaker">{speaker.name}</span>
                                {speaker.affiliation ? (
                                  <small className="subtle programme-row-affiliation">
                                    {" "}
                                    <span aria-hidden="true">— </span>
                                    {speaker.affiliation}
                                  </small>
                                ) : null}
                              </div>
                            ))
                          ) : (
                            <span className="speaker">
                              Speaker to be announced
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="room-col">
                        <strong>{session.room}</strong>
                        <small className="subtle" style={{ display: "block" }}>
                          {[session.building, session.level]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <div className="track-col">{session.track}</div>
                      <div>
                        {!embedded && saved.includes(session.id) ? (
                          <span className="status success">Saved ✓</span>
                        ) : !embedded && !shared ? (
                          <span className="pill">＋</span>
                        ) : null}
                      </div>
                    </button>
                    {snippet ? (
                      <div className="programme-entry-description">
                        <p id={`session-description-${session.id}`}>
                          {expanded ? description : snippet}
                        </p>
                        {snippet === description ? null : (
                          <button
                            type="button"
                            className="btn small"
                            aria-expanded={expanded}
                            aria-controls={`session-description-${session.id}`}
                            aria-label={`${expanded ? "Show less" : "Show more"} of the ${session.title} description`}
                            onClick={() => toggleDescription(session.id)}
                          >
                            {expanded ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <section className="card pad">
                <h2>No matching sessions</h2>
                <p className="subtle">Clear a filter or broaden the search.</p>
                {filtersActive ? (
                  <button type="button" className="btn" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : null}
              </section>
            )}
          </div>
          <section
            id="speakers"
            className="mt"
            aria-labelledby="speakers-title"
          >
            <div className="card-title">
              <div>
                <span className="pc-page-eyebrow">Meet the programme</span>
                <h2 id="speakers-title">Speakers</h2>
              </div>
              <span className="status info">{visibleSpeakers.length}</span>
            </div>
            {visibleSpeakers.length ? (
              <div className="grid grid-3">
                {visibleSpeakers.map((speaker) => (
                  <article
                    id={`speaker-${speaker.id}`}
                    className="card pad"
                    key={speaker.id}
                  >
                    <div className="row-main mb">
                      {speaker.imageUrl ? (
                        <img
                          className="avatar"
                          src={speaker.imageUrl}
                          alt=""
                          width={48}
                          height={48}
                        />
                      ) : (
                        <span className="avatar" aria-hidden="true">
                          {speaker.displayName
                            .split(" ")
                            .map((part) => part[0])
                            .join("")
                            .slice(0, 2)}
                        </span>
                      )}
                      <div>
                        <h3>{speaker.displayName}</h3>
                        <p className="help">
                          {[speaker.jobTitle, speaker.organisationName]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </div>
                    <p>
                      {speaker.biography
                        ? descriptionSnippet(speaker.biography)
                        : "Biography coming soon."}
                    </p>
                    <p className="help">
                      {speaker.sessionIds.length} session
                      {speaker.sessionIds.length === 1 ? "" : "s"}
                    </p>
                    <a
                      className="btn small"
                      id={`speaker-profile-link-${speaker.id}`}
                      href="#programme-speaker-profile"
                      aria-label={`View profile and sessions for ${speaker.displayName}`}
                      onClick={(event) =>
                        openSpeakerProfile(speaker.id, event.currentTarget)
                      }
                    >
                      View profile and sessions
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <p>No speakers match this search.</p>
              </div>
            )}
            {selectedSpeaker ? (
              <article
                className="card pad mt"
                id="programme-speaker-profile"
                aria-live="polite"
                aria-labelledby="programme-speaker-profile-name"
                tabIndex={-1}
                ref={speakerProfileRef}
              >
                <div className="card-title">
                  <div>
                    <span className="pill">Speaker profile</span>
                    <h2 id="programme-speaker-profile-name">
                      {selectedSpeaker.displayName}
                    </h2>
                    <p className="help">
                      {[
                        selectedSpeaker.jobTitle,
                        selectedSpeaker.organisationName,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Role and organisation to be confirmed"}
                    </p>
                  </div>
                  <div className="public-profile-actions">
                    <a
                      className="btn small"
                      href={`#speaker-${selectedSpeaker.id}`}
                    >
                      Share profile link
                    </a>
                    <button
                      type="button"
                      className="btn small"
                      onClick={closeSpeakerProfile}
                    >
                      Close profile
                    </button>
                  </div>
                </div>
                {selectedSpeaker.pronunciation ? (
                  <p className="help">
                    Pronunciation · {selectedSpeaker.pronunciation}
                  </p>
                ) : null}
                <p>{selectedSpeaker.biography || "Biography coming soon."}</p>
                <h3>
                  Sessions{" "}
                  <span className="status info">
                    {selectedSpeakerSessions.length}
                  </span>
                </h3>
                <div className="stack">
                  {selectedSpeakerSessions.length ? (
                    selectedSpeakerSessions.map((session) => (
                      <a
                        href={`#session-${session.slug}`}
                        key={session.id}
                        onClick={() => setSelectedId(session.id)}
                      >
                        {formatDay(session.startsAt, programme.event.timezone)}{" "}
                        ·{" "}
                        {formatTime(session.startsAt, programme.event.timezone)}{" "}
                        · {session.title} · {session.room}
                      </a>
                    ))
                  ) : (
                    <p className="subtle">
                      No sessions match the current filters.
                    </p>
                  )}
                </div>
              </article>
            ) : null}
          </section>
        </div>
        <aside id="itinerary">
          {!embedded ? (
            <section
              className="card itinerary"
              aria-busy={fetcher.state !== "idle" || undefined}
            >
              <div className="card-title">
                <h2>{shared ? "Shared itinerary" : "My itinerary"}</h2>
                <span className="status info right">{saved.length}</span>
              </div>
              {itineraryConflicts.length ? (
                <div className="validation-item warn">
                  <strong>Schedule conflict</strong>
                  <p>{itineraryConflicts[0].join(" overlaps ")}</p>
                </div>
              ) : null}
              {fetcher.data &&
              "error" in fetcher.data &&
              typeof fetcher.data.error === "string" ? (
                <p className="validation-item error" role="alert">
                  {fetcher.data.error}
                </p>
              ) : null}
              {loaderData.itineraryVerificationRequired ? (
                <div className="stack mb">
                  <p className="help">
                    Complete the security check once to start this browser's
                    itinerary.
                  </p>
                  <TurnstileWidget
                    siteKey={loaderData.turnstileSiteKey}
                    action="public_itinerary_create"
                    onTokenChange={setTurnstileToken}
                    resetKey={turnstileResetKey}
                  />
                </div>
              ) : null}
              {savedSessions.length ? (
                <>
                  {savedSessions.map((session) => {
                    const sessionSpeakers = session.speakerIds.map(
                      (speakerId, index) => {
                        const speaker = speakerById.get(speakerId)!;
                        return {
                          id: speakerId,
                          name: session.speakerNames[index]!,
                          affiliation: speakerAffiliation(speaker),
                        };
                      },
                    );
                    return (
                      <button
                        type="button"
                        className="itinerary-item"
                        style={{ width: "100%", textAlign: "left" }}
                        key={session.id}
                        aria-pressed={session.id === selected?.id}
                        onClick={() => selectSavedSession(session.id)}
                      >
                        <strong>
                          {formatDay(
                            session.startsAt,
                            programme.event.timezone,
                          )}{" "}
                          ·{" "}
                          {formatTime(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </strong>
                        <span className="itinerary-title">{session.title}</span>
                        <span className="itinerary-meta">
                          {[session.room, session.format, session.track]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {sessionSpeakers.length ? (
                          <span className="itinerary-speakers">
                            {sessionSpeakers.map((speaker) => (
                              <span key={speaker.id}>
                                {speaker.name}
                                {speaker.affiliation
                                  ? ` — ${speaker.affiliation}`
                                  : ""}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {!shared ? (
                    <fetcher.Form method="post" className="mt">
                      <input type="hidden" name="intent" value="share" />
                      <button
                        className="btn"
                        type="submit"
                        disabled={fetcher.state !== "idle"}
                      >
                        Create read-only share link
                      </button>
                    </fetcher.Form>
                  ) : null}
                  {loaderData.itinerarySynced && !shared ? (
                    <p className="help">
                      Synced to your signed-in account across devices.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="subtle">No saved sessions yet.</p>
              )}
            </section>
          ) : null}
          {selected ? (
            <section className="card session-detail-panel mt">
              <div className="card-title">
                <span className="pill">{selected.format}</span>
              </div>
              <h2>{selected.title}</h2>
              <div className="stack mb">
                {selected.speakerIds.length ? (
                  selected.speakerIds.map((speakerId, index) => {
                    const speaker = speakerById.get(speakerId)!;
                    const name = selected.speakerNames[index]!;
                    const affiliation = speakerAffiliation(speaker);
                    return (
                      <div className="row-main" key={speakerId}>
                        {speaker.imageUrl ? (
                          <img
                            className="avatar"
                            src={speaker.imageUrl}
                            alt=""
                            width={40}
                            height={40}
                          />
                        ) : (
                          <span className="avatar" aria-hidden="true">
                            {initials(name)}
                          </span>
                        )}
                        <div>
                          <strong>{name}</strong>
                          <small>
                            {affiliation ||
                              "Role and organisation not provided"}
                          </small>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="row-main">
                    <span className="avatar" aria-hidden="true">
                      PC
                    </span>
                    <div>
                      <strong>Speaker to be announced</strong>
                      <small>{selected.track}</small>
                    </div>
                  </div>
                )}
              </div>
              {!embedded && !shared ? (
                <button
                  type="button"
                  className={`btn${saved.includes(selected.id) ? "" : " primary"}`}
                  disabled={
                    fetcher.state !== "idle" ||
                    (!saved.includes(selected.id) &&
                      loaderData.itineraryVerificationRequired &&
                      loaderData.turnstileSiteKey !== null &&
                      !turnstileToken)
                  }
                  onClick={() => toggle(selected.id)}
                >
                  {fetcher.state !== "idle"
                    ? "Updating itinerary…"
                    : saved.includes(selected.id)
                      ? "Remove from itinerary"
                      : "Add to itinerary"}
                </button>
              ) : null}
              <h3>About this session</h3>
              <p>{selected.description || "A description is coming soon."}</p>
              <Link
                className="btn small"
                to={`/public/programme/${programme.event.slug}#session-${selected.slug}`}
              >
                Shareable session link
              </Link>
              {selected.speakerIds.length ? (
                <div className="stack mt">
                  {selected.speakerIds.map((speakerId, index) => (
                    <a
                      key={speakerId}
                      href={`#speaker-${speakerId}`}
                      onClick={(event) =>
                        openSpeakerProfile(speakerId, event.currentTarget)
                      }
                    >
                      View {selected.speakerNames[index]}’s profile
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="divider" />
              <h3>Details</h3>
              <dl className="public-detail-list">
                <dt>When</dt>
                <dd>
                  {formatDay(selected.startsAt, programme.event.timezone)} ·{" "}
                  {formatTime(selected.startsAt, programme.event.timezone)}–
                  {formatTime(selected.endsAt, programme.event.timezone)}
                </dd>
                <dt>Where</dt>
                <dd>
                  {[selected.room, selected.building, selected.level]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
                <dt>Track</dt>
                <dd>{selected.track ?? "Not assigned to a public track"}</dd>
                <dt>Format</dt>
                <dd>{selected.format}</dd>
              </dl>
            </section>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

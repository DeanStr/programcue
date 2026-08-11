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
  const slug = params.slug ?? env.PUBLIC_EVENT_SLUG;
  if (!slug)
    throw new Response("PUBLIC_EVENT_SLUG is not configured", { status: 503 });
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
  const slug = params.slug ?? env.PUBLIC_EVENT_SLUG;
  if (!slug)
    throw new Response("PUBLIC_EVENT_SLUG is not configured", { status: 503 });
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
  const [selectedId, setSelectedId] = useState(programme.sessions[0]?.id ?? "");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(
    programme.sessions[0]?.speakerIds[0] ?? programme.speakers[0]?.id ?? "",
  );
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
  const visible = useMemo(
    () =>
      programme.sessions.filter((session) => {
        const matchesDay =
          day === "All days" ||
          formatDay(session.startsAt, programme.event.timezone) === day;
        const matchesTrack =
          !embedOptions.track || session.track === embedOptions.track;
        const haystack = [
          session.title,
          session.speakerNames.join(" "),
          session.track,
          session.format,
          session.room,
        ]
          .join(" ")
          .toLowerCase();
        return (
          matchesDay &&
          matchesTrack &&
          haystack.includes(query.trim().toLowerCase())
        );
      }),
    [day, embedOptions.track, programme, query],
  );
  const selected =
    visible.find((session) => session.id === selectedId) ?? visible[0] ?? null;
  const visibleSessionIds = new Set(visible.map((session) => session.id));
  const visibleSpeakerIds = new Set(
    visible.flatMap((session) => session.speakerIds),
  );
  const visibleSpeakers = programme.speakers.filter(
    (speaker) =>
      (!embedded || visibleSpeakerIds.has(speaker.id)) &&
      [
        speaker.displayName,
        speaker.jobTitle,
        speaker.organisationName,
        speaker.biography,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const selectedSpeaker =
    visibleSpeakers.find((speaker) => speaker.id === selectedSpeakerId) ??
    visibleSpeakers[0] ??
    null;
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
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery("");
                setDay("All days");
              }}
            >
              Clear filters
            </button>
          </div>
          <div className="programme-list">
            {visible.length ? (
              visible.map((session) => (
                <button
                  type="button"
                  id={`session-${session.slug}`}
                  className={`programme-row${session.id === selectedId ? " active" : ""}`}
                  key={session.id}
                  aria-pressed={session.id === selectedId}
                  onClick={() => {
                    setSelectedId(session.id);
                    if (session.speakerIds[0])
                      setSelectedSpeakerId(session.speakerIds[0]);
                  }}
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
                      {formatTime(session.startsAt, programme.event.timezone)}
                    </strong>
                    <small className="subtle" style={{ display: "block" }}>
                      {formatDay(session.startsAt, programme.event.timezone)}
                    </small>
                  </div>
                  <div>
                    <span className="pill">{session.format}</span>
                    <h3>{session.title}</h3>
                    <div className="speaker">
                      {session.speakerNames.join(", ") ||
                        "Speaker to be announced"}
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
              ))
            ) : (
              <section className="card pad">
                <h2>No matching sessions</h2>
                <p className="subtle">Clear a filter or broaden the search.</p>
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
                    <p>{speaker.biography || "Biography coming soon."}</p>
                    <a
                      className="btn small"
                      href={`#speaker-${speaker.id}`}
                      onClick={() => setSelectedSpeakerId(speaker.id)}
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
              <article className="card pad mt" aria-live="polite">
                <div className="card-title">
                  <div>
                    <span className="pill">Speaker profile</span>
                    <h2>{selectedSpeaker.displayName}</h2>
                  </div>
                  <a
                    className="btn small"
                    href={`#speaker-${selectedSpeaker.id}`}
                  >
                    Share profile link
                  </a>
                </div>
                {selectedSpeaker.pronunciation ? (
                  <p className="help">
                    Pronunciation · {selectedSpeaker.pronunciation}
                  </p>
                ) : null}
                <p>{selectedSpeaker.biography || "Biography coming soon."}</p>
                <h3>Sessions</h3>
                <div className="stack">
                  {programme.sessions
                    .filter(
                      (session) =>
                        selectedSpeaker.sessionIds.includes(session.id) &&
                        (!embedded || visibleSessionIds.has(session.id)),
                    )
                    .map((session) => (
                      <a
                        href={`#session-${session.slug}`}
                        key={session.id}
                        onClick={() => setSelectedId(session.id)}
                      >
                        {formatDay(session.startsAt, programme.event.timezone)}{" "}
                        ·{" "}
                        {formatTime(session.startsAt, programme.event.timezone)}{" "}
                        · {session.title}
                      </a>
                    ))}
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
                  {savedSessions.map((session) => (
                    <button
                      type="button"
                      className="itinerary-item"
                      style={{ width: "100%", textAlign: "left" }}
                      key={session.id}
                      aria-pressed={session.id === selectedId}
                      onClick={() => setSelectedId(session.id)}
                    >
                      <strong>
                        {formatDay(session.startsAt, programme.event.timezone)}{" "}
                        ·{" "}
                        {formatTime(session.startsAt, programme.event.timezone)}
                      </strong>
                      <p>{session.title}</p>
                      <small>{session.room}</small>
                    </button>
                  ))}
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
              <div className="row-main mb">
                <span className="avatar">
                  {selected.speakerNames[0]
                    ?.split(" ")
                    .map((part) => part[0])
                    .join("") || "PC"}
                </span>
                <div>
                  <strong>
                    {selected.speakerNames.join(", ") ||
                      "Speaker to be announced"}
                  </strong>
                  <small>{selected.track}</small>
                </div>
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
              <p>{selected.description}</p>
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
                      onClick={() => setSelectedSpeakerId(speakerId)}
                    >
                      View {selected.speakerNames[index]}’s profile
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="divider" />
              <h3>Details</h3>
              <p>
                {formatDay(selected.startsAt, programme.event.timezone)} ·{" "}
                {formatTime(selected.startsAt, programme.event.timezone)}–
                {formatTime(selected.endsAt, programme.event.timezone)}
                <br />
                {selected.room}
              </p>
            </section>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

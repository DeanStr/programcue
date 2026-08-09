import { useEffect, useMemo, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { data, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/public-programme";
import { formatProgrammeEventDay } from "~/modules/programme/programme-presentation";
import {
  PublishedProgrammeItineraryExpiredError,
  PublishedProgrammeSessionNotFoundError,
  PublicProgrammeService,
  readCookie,
} from "~/modules/programme/public-programme-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

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
  const itinerary = embedded
    ? []
    : await service.itinerary(programme, readCookie(request, ITINERARY_COOKIE));
  return data(
    { programme, itinerary, embedded },
    {
      headers: {
        "cache-control": embedded
          ? "public, max-age=60, stale-while-revalidate=300"
          : "private, no-store",
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
  const { env } = getCloudflareContext(context);
  const slug = params.slug ?? env.PUBLIC_EVENT_SLUG;
  if (!slug)
    throw new Response("PUBLIC_EVENT_SLUG is not configured", { status: 503 });
  const values = await request.formData();
  const intent = values.get("intent");
  if (intent !== "add" && intent !== "remove")
    throw new Response("Unsupported itinerary action", { status: 400 });
  const sessionId = String(values.get("sessionId") ?? "");
  const service = new PublicProgrammeService(env);
  const programme = await service.getPublished(slug);
  if (!programme)
    throw new Response("Published event programme not found", { status: 404 });
  try {
    const itinerary = await service.updateItinerary(
      programme,
      readCookie(request, ITINERARY_COOKIE),
      sessionId,
      intent,
    );
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
  const fetcher = useFetcher<typeof action>();
  const saved = loaderData.itinerary;
  const [query, setQuery] = useState("");
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
  const [day, setDay] = useState("All days");
  const [selectedId, setSelectedId] = useState(programme.sessions[0]?.id ?? "");
  useEffect(() => {
    if (!location.hash.startsWith("#session-")) return;
    const slug = location.hash.slice("#session-".length);
    const linked = programme.sessions.find((session) => session.slug === slug);
    if (linked) setSelectedId(linked.id);
  }, [location.hash, programme.sessions]);
  const visible = useMemo(
    () =>
      programme.sessions.filter((session) => {
        const matchesDay =
          day === "All days" ||
          formatDay(session.startsAt, programme.event.timezone) === day;
        const haystack = [
          session.title,
          session.speakerNames.join(" "),
          session.track,
          session.format,
          session.room,
        ]
          .join(" ")
          .toLowerCase();
        return matchesDay && haystack.includes(query.trim().toLowerCase());
      }),
    [day, programme, query],
  );
  const selected =
    programme.sessions.find((session) => session.id === selectedId) ??
    programme.sessions[0] ??
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

  function toggle(sessionId: string) {
    void fetcher.submit(
      { intent: saved.includes(sessionId) ? "remove" : "add", sessionId },
      { method: "post" },
    );
  }

  return (
    <div className={`public-shell${embedded ? " embedded" : ""}`}>
      {!embedded ? (
        <header className="public-top">
          <a
            className="brand"
            href={`/public/programme/${programme.event.slug}`}
            style={{ color: "var(--ink)", padding: 0 }}
          >
            <span className="brand-mark">P</span>
            <span>Program Cue</span>
          </a>
          <nav className="public-nav" aria-label="Programme">
            <a className="active" href="#programme" aria-current="page">
              Programme
            </a>
          </nav>
          <a className="btn" href="#itinerary">
            ♡ My itinerary <span className="status info">{saved.length}</span>
          </a>
        </header>
      ) : null}
      <section
        className="hero"
        style={
          {
            "--event-accent": programme.event.brandAccent,
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
          <div className="public-filters">
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
                    ) : !embedded ? (
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
        </div>
        <aside id="itinerary">
          {!embedded ? (
            <section
              className="card itinerary"
              aria-busy={fetcher.state !== "idle" || undefined}
            >
              <div className="card-title">
                <h2>My itinerary</h2>
                <span className="status info right">{saved.length}</span>
              </div>
              {itineraryConflicts.length ? (
                <div className="validation-item warn">
                  <strong>Schedule conflict</strong>
                  <p>{itineraryConflicts[0].join(" overlaps ")}</p>
                </div>
              ) : null}
              {savedSessions.length ? (
                savedSessions.map((session) => (
                  <button
                    type="button"
                    className="itinerary-item"
                    style={{ width: "100%", textAlign: "left" }}
                    key={session.id}
                    aria-pressed={session.id === selectedId}
                    onClick={() => setSelectedId(session.id)}
                  >
                    <strong>
                      {formatDay(session.startsAt, programme.event.timezone)} ·{" "}
                      {formatTime(session.startsAt, programme.event.timezone)}
                    </strong>
                    <p>{session.title}</p>
                    <small>{session.room}</small>
                  </button>
                ))
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
              {!embedded ? (
                <button
                  type="button"
                  className={`btn${saved.includes(selected.id) ? "" : " primary"}`}
                  disabled={fetcher.state !== "idle"}
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

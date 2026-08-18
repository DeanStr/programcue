import { CalendarDays, MapPin, Search } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  PublicEventFooter,
  PublicEventHeader,
} from "~/components/public-event-chrome";
import {
  descriptionSnippet,
  eventHeroImagePath,
  formatDay,
  formatTime,
  groupSessionsByDay,
  initials,
  normaliseDescription,
  type PublicProgrammeLoaderData,
  type PublicProgrammeModel,
  speakerAffiliation,
  usePublicProgrammeModel,
} from "~/components/public-programme-model";
import {
  ProgrammeDayHeading,
  PublicShareActions,
  PublicSpeakerAvatar,
  PublicSpeakerShareActions,
  SaveSessionButton,
  SessionPlace,
  SessionSpeakerLines,
  SessionTags,
  SessionTime,
} from "~/components/public-programme-parts";
import { PublicProgrammeSurfaceContent } from "~/components/public-programme-surfaces";
import { PublicSiteHome } from "~/components/public-site-content";
import { TurnstileWidget } from "~/components/turnstile-widget";
import { requireValue } from "~/lib/required-value";
import {
  formatProgrammeDuration,
  formatProgrammeEventDay,
  formatProgrammeTimeRange,
  programmeAccentCssVars,
  programmeAccentPalette,
  publicProgrammeSurfacePath,
  publicSessionDetailPath,
  publicSessionPagePath,
  publicSpeakerProfilePath,
} from "~/modules/programme/programme-presentation";

/**
 * The header, hero and footer wrap every published surface, so they live here
 * and the surface modules only render their own content.
 */
function PublicProgrammeViewNavigation({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const { surface, programme } = model;
  const speakerViews = ["speakers", "gallery"].includes(surface);
  // The same condition the page uses to pick its main width.
  const wideSurface = surface === "overview" || surface === "sessions";
  const views = speakerViews
    ? [
        {
          label: "Directory",
          href: publicProgrammeSurfacePath(programme.event.slug, "speakers"),
          active: surface === "speakers",
        },
        {
          label: "Gallery",
          href: publicProgrammeSurfacePath(programme.event.slug, "gallery"),
          active: surface === "gallery",
        },
      ]
    : [
        {
          label: "List",
          href: publicProgrammeSurfacePath(programme.event.slug, "sessions"),
          active: surface === "overview" || surface === "sessions",
        },
        {
          label: "Agenda",
          href: publicProgrammeSurfacePath(programme.event.slug, "agenda"),
          active: surface === "agenda",
        },
        {
          label: "Schedule",
          href: publicProgrammeSurfacePath(programme.event.slug, "schedule"),
          active: surface === "schedule",
        },
      ];
  return (
    <nav
      className={`public-view-navigation${wideSurface ? " is-wide" : ""}`}
      aria-label={speakerViews ? "Speaker views" : "Programme views"}
    >
      <span>{speakerViews ? "Speakers" : "Programme"}</span>
      {views.map((view) => (
        <Link
          key={view.label}
          className={view.active ? "active" : undefined}
          aria-current={view.active ? "page" : undefined}
          to={view.href}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
/**
 * The masthead of a published programme. It used to carry three big numbers —
 * sessions, speakers, days — each of which the page states again within one
 * screen, and one of which was counting the days that happened to hold a
 * session rather than the days of the event, so it contradicted the range
 * printed directly above it. What replaces them is the one thing the list
 * cannot say from the top of the page: what the programme opens with, and how
 * to take the whole thing away in a calendar.
 */
function PublicProgrammeHero({ model }: { model: PublicProgrammeModel }) {
  const { programme, embedded } = model;
  const place = [programme.event.venue, programme.event.city]
    .filter(Boolean)
    .join(", ");
  const heroImage = eventHeroImagePath(programme.event);
  const opening = programme.sessions[0] ?? null;
  return (
    <section
      className={`hero${heroImage ? " has-image" : ""}`}
      style={
        heroImage
          ? ({
              "--hero-image": `url(${JSON.stringify(heroImage)})`,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="hero-body">
        {embedded && programme.event.logoUrl ? (
          <img
            className="public-hero-logo"
            src={programme.event.logoUrl}
            alt={`${programme.event.name} logo`}
          />
        ) : null}
        <h1>{programme.event.name}</h1>
        {model.loaderData.site?.configuration.tagline ? (
          <p className="public-site-tagline">
            {model.loaderData.site.configuration.tagline}
          </p>
        ) : programme.event.description ? (
          <p className="public-site-tagline">{programme.event.description}</p>
        ) : null}
        <p className="hero-meta">
          {model.showEmbedField("time") ? (
            <span>
              <CalendarDays aria-hidden="true" size={15} />
              <span>
                {formatProgrammeEventDay(programme.event.startDate)}–
                {formatProgrammeEventDay(programme.event.endDate)}
              </span>
            </span>
          ) : null}
          {model.showEmbedField("location") && place ? (
            <span>
              <MapPin aria-hidden="true" size={15} />
              <span>{place}</span>
            </span>
          ) : null}
        </p>
        {embedded ? null : (
          <div className="hero-actions">
            <a
              className="btn hero-action"
              href={`/api/v1/public/events/${encodeURIComponent(programme.event.slug)}/calendar.ics`}
            >
              <CalendarDays aria-hidden="true" size={15} />
              Add to calendar
            </a>
          </div>
        )}
      </div>
      {opening && !embedded ? (
        <div className="hero-opening">
          <p className="hero-opening-label">Opens with</p>
          <p className="hero-opening-title">{opening.title}</p>
          <p className="hero-opening-meta">
            <time dateTime={new Date(opening.startsAt * 1_000).toISOString()}>
              {formatDay(opening.startsAt, programme.event.timezone)} ·{" "}
              {formatProgrammeTimeRange(
                opening.startsAt,
                opening.endsAt,
                programme.event.timezone,
              )}
            </time>
            <span>{opening.room}</span>
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** One speaker card, used by the overview roster and the speaker directory. */
export function PublicSpeakerCard({
  speaker,
  model,
}: {
  speaker: PublicProgrammeModel["orderedSpeakers"][number];
  model: PublicProgrammeModel;
}) {
  const affiliation = speakerAffiliation(speaker);
  return (
    <article
      id={`speaker-${speaker.id}`}
      className="card pad public-speaker-card"
      key={speaker.id}
    >
      <div className="public-speaker-card-identity">
        {model.showSpeakerDetails && model.showEmbedField("images") ? (
          <PublicSpeakerAvatar speaker={speaker} size={56} />
        ) : null}
        <div>
          <h3>{speaker.displayName}</h3>
          {model.showSpeakerDetails &&
          model.showEmbedField("affiliations") &&
          affiliation ? (
            <p className="help">{affiliation}</p>
          ) : null}
        </div>
      </div>
      {model.showSpeakerDetails &&
      model.showEmbedField("biography") &&
      speaker.biography ? (
        <p className="public-speaker-card-bio">
          {descriptionSnippet(speaker.biography)}
        </p>
      ) : null}
      {model.showSpeakerDetails ? (
        <div className="public-speaker-card-foot">
          {model.showEmbedField("sessions") ? (
            <span className="help">
              {speaker.sessionIds.length} session
              {speaker.sessionIds.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <a
            className="btn small"
            id={`speaker-profile-link-${speaker.id}`}
            href={publicSpeakerProfilePath(
              model.programme.event.slug,
              speaker.id,
            )}
            aria-label={`View profile and sessions for ${speaker.displayName}`}
            onClick={(event) => {
              event.preventDefault();
              model.openSpeakerProfile(speaker.id, event.currentTarget);
            }}
          >
            View profile and sessions
          </a>
        </div>
      ) : null}
    </article>
  );
}

function PublicProgrammeFilters({ model }: { model: PublicProgrammeModel }) {
  const {
    showControl,
    query,
    setQuery,
    day,
    setDay,
    days,
    track,
    setTrack,
    tracks,
    format,
    setFormat,
    formats,
    room,
    setRoom,
    rooms,
    clearFilters,
    clearableFiltersActive,
    visible,
    programme,
    filtersActive,
    clearedSavedFilterNotice,
  } = model;
  return (
    <div className="public-filters-bar" id="programme">
      {clearedSavedFilterNotice ? (
        <p className="validation-item info" role="status">
          {clearedSavedFilterNotice}
        </p>
      ) : null}
      <div className="public-filters">
        {showControl("search") ? (
          <div className="public-search">
            <Search aria-hidden="true" size={16} />
            <input
              className="field"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions, speakers, or topics"
              aria-label="Search sessions, speakers, or topics"
              type="search"
            />
          </div>
        ) : null}
        {showControl("day") ? (
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
        ) : null}
        {showControl("track") && tracks.length > 1 ? (
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
        {showControl("format") && formats.length > 1 ? (
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
        {showControl("room") && rooms.length > 1 ? (
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
      </div>
      {/* Reset sits with the result count, not among the facets: it undoes them
          rather than being one of them, and it kept wrapping onto a line of its
          own at the end of the control row. */}
      <div className="public-filter-summary">
        <p className="help" role="status">
          Showing {visible.length} of {programme.sessions.length} published
          session{programme.sessions.length === 1 ? "" : "s"}
          {filtersActive ? " for the current filters" : ""}.
        </p>
        <button
          type="button"
          className="btn small"
          onClick={clearFilters}
          disabled={!clearableFiltersActive}
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}

/**
 * A programme whose keynote draws exactly like a 45-minute breakout has given
 * up its main editorial job, so the sessions the whole room attends get the
 * larger title and an accent rail. Driven off the published format, because
 * that is the only ranking the organiser has actually stated.
 */
function isFeatureSession(session: { format: string }) {
  const format = session.format.toLocaleLowerCase("en");
  return format.includes("keynote") || format.includes("plenary");
}

function ProgrammeSessionEntry({
  session,
  model,
}: {
  session: PublicProgrammeModel["visible"][number];
  model: PublicProgrammeModel;
}) {
  const { programme, embedded, shared, selected, expandedDescriptions } = model;
  const description = normaliseDescription(session.description);
  const snippet = descriptionSnippet(description);
  const expanded = expandedDescriptions.includes(session.id);
  const active = session.id === selected?.id;
  const feature = isFeatureSession(session);
  return (
    <div
      className={`programme-entry${feature ? " feature" : ""}${active ? " active" : ""}`}
    >
      <button
        type="button"
        className={`programme-row${active ? " active" : ""}${model.showEmbedField("time") ? "" : " without-time"}`}
        aria-pressed={active}
        onClick={() => model.openSessionDetail(session.id)}
      >
        {model.showEmbedField("time") ? (
          <span className="session-time">
            <SessionTime
              session={session}
              timezone={programme.event.timezone}
            />
          </span>
        ) : null}
        {/* Title first. The coloured pills used to render above it, so the
            first thing the eye landed on in every row was the track. They sit
            with the place in the meta line now, still behind their own embed
            field switches. */}
        <span className="session-main">
          <h3>{session.title}</h3>
          <SessionSpeakerLines session={session} model={model} />
          <span className="session-meta">
            {model.showEmbedField("location") ? (
              <SessionPlace session={session} />
            ) : null}
            {model.showEmbedField("track") || model.showEmbedField("format") ? (
              <SessionTags
                session={session}
                showTrack={model.showEmbedField("track")}
                showFormat={model.showEmbedField("format")}
              />
            ) : null}
          </span>
        </span>
      </button>
      {!embedded && !shared ? (
        <SaveSessionButton session={session} model={model} />
      ) : null}
      {/* Clamped, not cut: a 32px button plus its gap used to be spent hiding
          about a line of text, five times down the same edge. The full
          description is in the row and the expander only unclamps it. */}
      {model.showEmbedField("description") && (snippet || !description) ? (
        <div className="programme-entry-description">
          <p
            id={`session-description-${session.id}`}
            className={expanded ? undefined : "is-clamped"}
          >
            {description || "Description not provided."}
          </p>
          {snippet && snippet !== description ? (
            <button
              type="button"
              className="session-disclosure"
              aria-expanded={expanded}
              aria-controls={`session-description-${session.id}`}
              aria-label={`${expanded ? "Show less" : "Show more"} of the ${session.title} description`}
              onClick={() => model.toggleDescription(session.id)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProgrammeSessionList({ model }: { model: PublicProgrammeModel }) {
  const { visible, programme, clearableFiltersActive, clearFilters } = model;
  if (!visible.length) {
    return (
      <section className="card pad public-empty">
        <h2>No matching sessions</h2>
        <p className="subtle">Clear a filter or broaden the search.</p>
        {clearableFiltersActive ? (
          <button type="button" className="btn" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <div className="programme-days">
      {groupSessionsByDay(visible, programme.event.timezone).map((group) => (
        <section className="programme-day" key={group.key}>
          <ProgrammeDayHeading
            label={group.label}
            count={group.sessions.length}
          />
          <div className="programme-list">
            {group.sessions.map((session) => (
              <ProgrammeSessionEntry
                key={session.id}
                session={session}
                model={model}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function VenuePanel({ model }: { model: PublicProgrammeModel }) {
  const { event } = model.programme;
  if (!event.venueAddress && !event.venueMapUrl) return null;
  return (
    <section className="card pad public-venue" aria-labelledby="venue-heading">
      <div className="card-title">
        <h2 id="venue-heading">Venue</h2>
      </div>
      {event.venue ? <p className="public-venue-name">{event.venue}</p> : null}
      {event.venueAddress ? (
        <address className="public-venue-address">{event.venueAddress}</address>
      ) : null}
      {event.venueMapUrl ? (
        <a
          className="public-venue-map"
          href={event.venueMapUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <MapPin aria-hidden size={14} />
          Open map
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </section>
  );
}

/**
 * The curated homepage and the filterable programme are different kinds of
 * surface — an edit and a working list — and on the overview they meet with no
 * announcement. The change from open editorial rules to bordered cards then
 * reads as the page contradicting itself rather than as a second zone
 * beginning. This names the seam, in the heading language the homepage above it
 * already uses.
 */
function ProgrammeSeamHeading() {
  return (
    <div className="public-site-section public-programme-seam">
      <div className="public-site-section-heading">
        <h2>Full programme</h2>
      </div>
    </div>
  );
}

function ItineraryPanel({ model }: { model: PublicProgrammeModel }) {
  const [calendarDownloadRequested, setCalendarDownloadRequested] =
    useState(false);
  const {
    fetcher,
    shared,
    saved,
    savedSessions,
    itineraryConflicts,
    loaderData,
    programme,
    speakerById,
    selected,
    selectSavedSession,
  } = model;
  const calendarExportHref = `/api/v1/public/events/${encodeURIComponent(
    programme.event.slug,
  )}/calendar.ics?${loaderData.calendarExportQuery}`;
  return (
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
      <ItineraryVerificationPrompt model={model} />
      {savedSessions.length ? (
        <>
          <div className="itinerary-items">
            {savedSessions.map((session) => {
              const sessionSpeakers = session.speakerIds.map(
                (speakerId, index) => ({
                  id: speakerId,
                  name: requireValue(
                    session.speakerNames[index],
                    "Required session.speakerNames[index] is unavailable.",
                  ),
                  affiliation: speakerAffiliation(
                    requireValue(
                      speakerById.get(speakerId),
                      "Required speakerById.get(speakerId) is unavailable.",
                    ),
                  ),
                }),
              );
              return (
                <button
                  type="button"
                  className="itinerary-item"
                  key={session.id}
                  aria-pressed={session.id === selected?.id}
                  onClick={() => selectSavedSession(session.id)}
                >
                  <strong>
                    {formatDay(session.startsAt, programme.event.timezone)} ·{" "}
                    {formatProgrammeTimeRange(
                      session.startsAt,
                      session.endsAt,
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
          </div>
          {!shared ? (
            <div className="page-actions mt">
              <a
                className="btn primary"
                href={calendarExportHref}
                download
                onClick={() => setCalendarDownloadRequested(true)}
              >
                <CalendarDays aria-hidden size={15} /> Export itinerary
              </a>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="share" />
                <button
                  className="btn"
                  type="submit"
                  disabled={fetcher.state !== "idle"}
                >
                  Create read-only share link
                </button>
              </fetcher.Form>
            </div>
          ) : (
            <a
              className="btn primary mt"
              href={calendarExportHref}
              download
              onClick={() => setCalendarDownloadRequested(true)}
            >
              <CalendarDays aria-hidden size={15} /> Export itinerary
            </a>
          )}
          {calendarDownloadRequested ? (
            <p className="validation-item ok mt" role="status">
              Calendar download requested. Check your browser downloads.
            </p>
          ) : null}
          {loaderData.itinerarySynced && !shared ? (
            <p className="help">
              Synced to your signed-in account across devices.
            </p>
          ) : null}
        </>
      ) : (
        /* One line, inside the card. The icon-in-a-dashed-box zero state was
           300px of the highest-value space on the page spent stating nought. */
        <p className="itinerary-zero">
          Nothing saved yet — choose Save on any session to build a personal
          itinerary you can share.
        </p>
      )}
    </section>
  );
}

/**
 * The rail earns its width by holding what the row beside it cannot: the whole
 * abstract, the speakers' biographies, and any clash with a session already
 * saved. It used to restate the row's title, time, place, both pills and
 * speaker line, so a third of the viewport showed the same session twice at
 * the same moment, with the withheld remainder of the description sitting
 * 400px from the "Show more" that withheld it.
 */
function SessionDetailPanel({ model }: { model: PublicProgrammeModel }) {
  const location = useLocation();
  const {
    selected,
    programme,
    speakerById,
    embedded,
    shared,
    showSpeakerDirectory,
    selectedConflicts,
    sessionDetailRef,
  } = model;
  if (!selected) return null;
  const canonicalSessionPath = publicSessionDetailPath(
    programme.event.slug,
    selected.id,
  );
  const sessionPagePath = publicSessionPagePath(
    programme.event.slug,
    selected.id,
    location.search,
  );
  const onSessionPage =
    location.pathname ===
      publicProgrammeSurfacePath(programme.event.slug, "sessions") &&
    new URLSearchParams(location.search).get("session") === selected.id;
  const classification = [
    model.showEmbedField("track") ? selected.track : null,
    model.showEmbedField("format") ? selected.format : null,
    model.showEmbedField("time")
      ? formatProgrammeDuration(selected.startsAt, selected.endsAt)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section
      className="card session-detail-panel"
      aria-labelledby="session-detail-title"
      ref={sessionDetailRef}
      tabIndex={-1}
    >
      <h2 id="session-detail-title">{selected.title}</h2>
      {/* One caption line, so the panel still stands on its own when it is
          stacked under the list on a phone and the row is a screen away. Each
          half is still behind its own embed field switch. */}
      {model.showEmbedField("time") || model.showEmbedField("location") ? (
        <p className="session-detail-when">
          {[
            model.showEmbedField("time")
              ? `${formatDay(selected.startsAt, programme.event.timezone)} · ${formatProgrammeTimeRange(
                  selected.startsAt,
                  selected.endsAt,
                  programme.event.timezone,
                )}`
              : null,
            model.showEmbedField("location") ? selected.room : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {classification ? (
        <p className="session-detail-classification">{classification}</p>
      ) : null}
      {selectedConflicts.length ? (
        <p className="validation-item warn">
          <strong>Schedule conflict</strong>
          <span>
            Overlaps{" "}
            {
              requireValue(
                selectedConflicts[0],
                "Required selectedConflicts[0] is unavailable.",
              ).title
            }
            , already in your itinerary.
          </span>
        </p>
      ) : null}
      {!embedded && !shared ? (
        <SaveSessionButton session={selected} model={model} variant="detail" />
      ) : null}
      {model.showEmbedField("description") ? (
        <>
          <h3>About this session</h3>
          <p className="session-detail-description">
            {selected.description || "A description is coming soon."}
          </p>
        </>
      ) : null}
      {model.showSpeakerDetails ? (
        <>
          <h3>{selected.speakerIds.length === 1 ? "Speaker" : "Speakers"}</h3>
          <div className="session-detail-speakers">
            {selected.speakerIds.length ? (
              selected.speakerIds.map((speakerId, index) => {
                const speaker = requireValue(
                  speakerById.get(speakerId),
                  "Required speakerById.get(speakerId) is unavailable.",
                );
                const name = requireValue(
                  selected.speakerNames[index],
                  "Required selected.speakerNames[index] is unavailable.",
                );
                const affiliation = speakerAffiliation(speaker);
                return (
                  <div className="session-detail-speaker" key={speakerId}>
                    <div className="session-detail-speaker-identity">
                      {model.showEmbedField("images") && speaker.imageUrl ? (
                        <img
                          className="avatar"
                          src={speaker.imageUrl}
                          alt=""
                          width={40}
                          height={40}
                          loading="lazy"
                        />
                      ) : model.showEmbedField("images") ? (
                        <span className="avatar" aria-hidden="true">
                          {initials(name)}
                        </span>
                      ) : null}
                      <div>
                        <strong>{name}</strong>
                        {model.showEmbedField("affiliations") && affiliation ? (
                          <small>{affiliation}</small>
                        ) : null}
                      </div>
                    </div>
                    {model.showEmbedField("biography") && speaker.biography ? (
                      <p>{descriptionSnippet(speaker.biography)}</p>
                    ) : null}
                    {showSpeakerDirectory ? (
                      <a
                        className="session-detail-profile-link"
                        href={publicSpeakerProfilePath(
                          programme.event.slug,
                          speakerId,
                        )}
                        onClick={(event) => {
                          event.preventDefault();
                          model.openSpeakerProfile(
                            speakerId,
                            event.currentTarget,
                          );
                        }}
                      >
                        View {name}’s profile
                      </a>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="subtle">Speaker to be announced.</p>
            )}
          </div>
        </>
      ) : (
        <>
          <h3>{selected.speakerIds.length === 1 ? "Speaker" : "Speakers"}</h3>
          <p className="public-session-speaker-names">
            {selected.speakerNames.length
              ? selected.speakerNames.join(", ")
              : "Speaker to be announced."}
          </p>
        </>
      )}
      <div className="divider" />
      <div className="public-profile-actions">
        <PublicShareActions
          url={new URL(
            canonicalSessionPath,
            model.loaderData.canonicalUrl,
          ).toString()}
          title={`${selected.title} · ${programme.event.name}`}
          text={
            model.loaderData.sessionShare?.sessionId === selected.id
              ? model.loaderData.sessionShare.description
              : `${selected.title} is part of ${programme.event.name}.`
          }
          copyLabel="Copy session link"
          shareLabel="Share session"
          resetKey={selected.id}
          failedMessage="This browser could not share the session. Copy the address from the address bar instead."
        />
        {onSessionPage ? null : (
          <Link className="btn small" to={sessionPagePath}>
            Open session page
          </Link>
        )}
      </div>
    </section>
  );
}

function ItineraryVerificationPrompt({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const {
    loaderData,
    itineraryVerificationPrompted,
    itineraryVerificationRef,
    turnstileToken,
    updateTurnstileToken,
    turnstileResetKey,
  } = model;
  if (!loaderData.itineraryVerificationRequired) return null;
  const raised = itineraryVerificationPrompted || Boolean(turnstileToken);
  return (
    /* The check is a consequence of the first save, not a condition of reading
       the page: it used to open above the itinerary before the visitor had
       touched anything, so the panel's first sentence was a warning about a
       list they had not started. The sentence stays in the accessibility tree
       throughout, because every save control describes itself by it. */
    <fieldset
      className={`itinerary-verification stack mb pc-plain-fieldset${itineraryVerificationPrompted ? " prompted" : ""}${raised ? "" : " latent"}`}
      ref={itineraryVerificationRef}
      tabIndex={-1}
      aria-labelledby="itinerary-verification-help"
    >
      <p
        className={
          itineraryVerificationPrompted
            ? "validation-item warn"
            : raised
              ? "help"
              : "sr-only"
        }
        id="itinerary-verification-help"
        role={raised ? "status" : undefined}
      >
        {turnstileToken
          ? "Security check complete. Choose Save again to start this browser's itinerary."
          : "Complete this security check once, then choose Save again to start this browser's itinerary."}
      </p>
      {raised ? (
        <TurnstileWidget
          siteKey={loaderData.turnstileSiteKey}
          action="public_itinerary_create"
          onTokenChange={updateTurnstileToken}
          resetKey={turnstileResetKey}
        />
      ) : null}
    </fieldset>
  );
}

function OverviewSpeakers({ model }: { model: PublicProgrammeModel }) {
  const {
    showSpeakerDirectory,
    visibleSpeakers,
    selectedSpeaker,
    selectedSpeakerSessions,
    programme,
    speakerProfileRef,
    closeSpeakerProfile,
  } = model;
  return (
    <section
      id="speakers"
      className="public-speakers-section"
      aria-labelledby="speakers-title"
      hidden={!showSpeakerDirectory}
    >
      {/* A section is named by its heading. The eyebrow above this one said
          "Meet the programme", which is the heading again in smaller caps and
          in the platform accent rather than the event's accent. */}
      <div className="public-section-head">
        <h2 id="speakers-title">Speakers</h2>
        <p className="public-section-count">
          {visibleSpeakers.length} presenting
        </p>
      </div>
      {visibleSpeakers.length ? (
        /* auto-fill, so two speakers make two cards rather than two thirds of
           a row with a visibly empty third track. */
        <div className="grid public-speaker-roster">
          {visibleSpeakers.map((speaker) => (
            <PublicSpeakerCard
              key={speaker.id}
              speaker={speaker}
              model={model}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>No speakers match this search.</p>
        </div>
      )}
      {selectedSpeaker ? (
        <article
          className="card pad mt public-speaker-profile"
          id="programme-speaker-profile"
          aria-live="polite"
          aria-labelledby="programme-speaker-profile-name"
          tabIndex={-1}
          ref={speakerProfileRef}
        >
          <div className="card-title">
            <div className="public-speaker-profile-identity">
              {model.showEmbedField("images") ? (
                <PublicSpeakerAvatar speaker={selectedSpeaker} size={72} />
              ) : null}
              <div>
                <span className="pill">Speaker profile</span>
                <h2 id="programme-speaker-profile-name">
                  {selectedSpeaker.displayName}
                </h2>
                {model.showEmbedField("affiliations") &&
                speakerAffiliation(selectedSpeaker) ? (
                  <p className="help">{speakerAffiliation(selectedSpeaker)}</p>
                ) : null}
              </div>
            </div>
            <div className="public-profile-actions">
              {!model.embedded ? (
                <PublicSpeakerShareActions model={model} />
              ) : null}
              <button
                type="button"
                className="btn small"
                onClick={closeSpeakerProfile}
              >
                Close profile
              </button>
            </div>
          </div>
          {model.showEmbedField("biography") &&
          selectedSpeaker.pronunciation ? (
            <p className="help">
              Pronunciation · {selectedSpeaker.pronunciation}
            </p>
          ) : null}
          {model.showEmbedField("biography") && selectedSpeaker.biography ? (
            <p>{selectedSpeaker.biography}</p>
          ) : null}
          {model.showEmbedField("sessions") ? (
            <>
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
                      href={publicSessionDetailPath(
                        programme.event.slug,
                        session.id,
                      )}
                      key={session.id}
                    >
                      {model.showEmbedField("time") ? (
                        <>
                          {formatDay(
                            session.startsAt,
                            programme.event.timezone,
                          )}{" "}
                          ·{" "}
                          {formatTime(
                            session.startsAt,
                            programme.event.timezone,
                          )}{" "}
                          ·{" "}
                        </>
                      ) : null}
                      {session.title}
                      {model.showEmbedField("location") && session.room ? (
                        <> · {session.room}</>
                      ) : null}
                    </a>
                  ))
                ) : (
                  <p className="subtle">
                    No sessions match the current filters.
                  </p>
                )}
              </div>
            </>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

export function PublicProgrammeWorkspace({
  loaderData: initialLoaderData,
}: {
  loaderData: PublicProgrammeLoaderData;
}) {
  const model = usePublicProgrammeModel(initialLoaderData);
  const { loaderData, programme, embedded, embedOptions, fetcher, shareUrl } =
    model;
  const overviewSurface =
    loaderData.surface === "overview" || loaderData.surface === "sessions";
  const homeSurface = loaderData.surface === "overview";
  const homeConfiguration =
    homeSurface && loaderData.site ? loaderData.site.configuration : null;
  /* The curated homepage states the venue on a rail of its own. Leaving the
     sidebar card in place printed the same address twice on one page, under two
     headings, with two different words for the same map link. */
  const homeStatesVenue = Boolean(
    homeConfiguration?.sectionOrder.includes("venue") &&
      homeConfiguration.sectionVisibility.venue,
  );
  const accentPalette = programmeAccentPalette(
    embedOptions.accent ?? programme.event.brandAccent,
  );
  return (
    <div
      className={`public-shell event-branded${embedded ? " embedded" : ""}${embedded && embedOptions.density === "compact" ? " embed-compact" : ""}`}
      data-public-theme={
        embedded
          ? embedOptions.theme
          : (loaderData.site?.configuration.theme ?? "system")
      }
      style={programmeAccentCssVars(accentPalette) as CSSProperties}
    >
      {!embedded ? (
        <PublicEventHeader
          event={programme.event}
          programme={programme}
          site={loaderData.site?.configuration ?? null}
          activeSurface={loaderData.surface}
          itinerary={{ shared: model.shared, savedCount: model.saved.length }}
        />
      ) : null}
      <main
        aria-label={embedded ? "Embedded programme preview" : undefined}
        id="main"
        className="public-page-main"
      >
        <PublicProgrammeHero model={model} />
        {!embedded ? <PublicProgrammeViewNavigation model={model} /> : null}
        {homeSurface && loaderData.site ? (
          <>
            <PublicSiteHome
              event={programme.event}
              programme={programme}
              site={loaderData.site}
            />
            <ProgrammeSeamHeading />
          </>
        ) : null}
        <div
          className={`public-main${!overviewSurface ? " public-surface-main" : ""}`}
        >
          {!overviewSurface ? (
            <div className="public-surface-content">
              <ItineraryVerificationPrompt model={model} />
              {embedded && embedOptions.controls.length ? (
                <PublicProgrammeFilters model={model} />
              ) : null}
              <PublicProgrammeSurfaceContent model={model} />
            </div>
          ) : (
            <>
              <div className="public-content">
                {fetcher.data && "error" in fetcher.data ? (
                  <div className="validation-item error mb" role="alert">
                    <strong>Itinerary not updated</strong>
                    <span>{String(fetcher.data.error)}</span>
                  </div>
                ) : null}
                {shareUrl ? (
                  <div className="public-share-notice mb" role="status">
                    <strong>Share link ready</strong>
                    <a href={shareUrl}>{shareUrl}</a>
                    <span>
                      The link is read-only. Creating another rotates it.
                    </span>
                  </div>
                ) : null}
                {embedOptions.controls.length || !embedded ? (
                  <PublicProgrammeFilters model={model} />
                ) : null}
                <ProgrammeSessionList model={model} />
              </div>
              {/* The rail precedes the roster in source order, so on a phone —
                where it stops being a rail — a tapped session's detail is the
                next thing under the list rather than 2,400px below it. */}
              <aside id="itinerary">
                {!embedded ? <ItineraryPanel model={model} /> : null}
                <SessionDetailPanel model={model} />
                {!embedded && !homeStatesVenue ? (
                  <VenuePanel model={model} />
                ) : null}
              </aside>
              <OverviewSpeakers model={model} />
            </>
          )}
        </div>
      </main>
      {!embedded ? (
        <PublicEventFooter event={programme.event} programme={programme} />
      ) : null}
    </div>
  );
}

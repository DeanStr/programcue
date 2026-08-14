import { useRef, useState, type CSSProperties } from "react";
import { CalendarDays, Heart, MapPin, Search } from "lucide-react";
import { Link } from "react-router";

import { TurnstileWidget } from "~/components/turnstile-widget";
import {
  formatProgrammeDuration,
  formatProgrammeEventDay,
  formatProgrammeTimeRange,
  programmeAccentPalette,
  publicProgrammeSurfacePath,
} from "~/modules/programme/programme-presentation";
import { PublicProgrammeSurfaceContent } from "~/components/public-programme-surfaces";
import {
  ProgrammeDayHeading,
  PublicSpeakerAvatar,
  SaveSessionButton,
  SessionPlace,
  SessionSpeakerLines,
  SessionTags,
  SessionTime,
} from "~/components/public-programme-parts";
import {
  descriptionSnippet,
  eventHeroImagePath,
  formatDay,
  formatTime,
  groupSessionsByDay,
  initials,
  normaliseDescription,
  speakerAffiliation,
  type PublicProgrammeLoaderData,
  type PublicProgrammeModel,
  usePublicProgrammeModel,
} from "~/components/public-programme-model";

/**
 * The header, hero and footer wrap every published surface, so they live here
 * and the surface modules only render their own content.
 */
function PublicProgrammeHeader({ model }: { model: PublicProgrammeModel }) {
  const { programme, loaderData, shared, saved } = model;
  const mobileNavigationRef = useRef<HTMLDetailsElement>(null);
  const slug = programme.event.slug;
  const overviewSurface =
    loaderData.surface === "overview" || loaderData.surface === "sessions";
  const programmeHref = `/public/programme/${slug}`;
  const links = [
    {
      key: "sessions",
      label: "All sessions",
      href: overviewSurface ? "#programme" : programmeHref,
      active: overviewSurface,
      routed: false,
    },
    {
      key: "speakers",
      label: "Speakers",
      href: overviewSurface
        ? "#speakers"
        : publicProgrammeSurfacePath(slug, "speakers"),
      active: loaderData.surface === "speakers",
      routed: false,
    },
    {
      key: "agenda",
      label: "Day agenda",
      href: publicProgrammeSurfacePath(slug, "agenda"),
      active: loaderData.surface === "agenda",
      routed: true,
    },
    {
      key: "schedule",
      label: "Full schedule",
      href: publicProgrammeSurfacePath(slug, "schedule"),
      active: loaderData.surface === "schedule",
      routed: true,
    },
    {
      key: "gallery",
      label: "Speaker Gallery",
      href: publicProgrammeSurfacePath(slug, "gallery"),
      active: loaderData.surface === "gallery",
      routed: true,
    },
  ];
  const itineraryHref = overviewSurface
    ? "#itinerary"
    : `${programmeHref}#itinerary`;

  const navLink = (link: (typeof links)[number], onActivate?: () => void) =>
    link.routed ? (
      <Link
        key={link.key}
        to={link.href}
        className={link.active ? "active" : undefined}
        aria-current={link.active ? "page" : undefined}
        onClick={onActivate}
      >
        {link.label}
      </Link>
    ) : (
      <a
        key={link.key}
        href={link.href}
        className={link.active ? "active" : undefined}
        aria-current={link.active ? "page" : undefined}
        onClick={onActivate}
      >
        {link.label}
      </a>
    );

  return (
    <header className="public-top">
      {/* The event owns this page. The platform is credited in the footer, not
          in the masthead where it used to outrank the customer's own name. */}
      <Link
        aria-label={`${programme.event.name} programme`}
        className="brand"
        to={programmeHref}
      >
        <span className="public-brand-mark" aria-hidden="true" />
        <span className="public-brand-name">{programme.event.name}</span>
      </Link>
      <nav className="public-nav" aria-label="Programme">
        {links.map((link) => navLink(link))}
      </nav>
      <details className="public-mobile-nav" ref={mobileNavigationRef}>
        <summary className="btn small">Browse</summary>
        <nav aria-label="Programme sections">
          {links.map((link) =>
            navLink(link, () =>
              mobileNavigationRef.current?.removeAttribute("open"),
            ),
          )}
        </nav>
      </details>
      {/* A lucide heart, not "♡": the keyboard glyph falls back to the system
          emoji font beside monochrome vector icons. */}
      <a className="btn public-itinerary-link" href={itineraryHref}>
        <Heart aria-hidden="true" size={15} />
        <span>{shared ? "Shared itinerary" : "My itinerary"}</span>
        <span className="status info">{saved.length}</span>
      </a>
    </header>
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
          ? ({ "--hero-image": `url("${heroImage}")` } as CSSProperties)
          : undefined
      }
    >
      <div className="hero-body">
        <h1>{programme.event.name}</h1>
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
              Add to calendar (.ics)
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

function PublicProgrammeFooter({ model }: { model: PublicProgrammeModel }) {
  const { programme } = model;
  const published = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: programme.event.timezone,
  }).format(new Date(programme.version.publishedAt * 1_000));
  return (
    <footer className="public-footer">
      <div>
        <p className="public-footer-primary">
          All times shown in {programme.event.timezone}.
        </p>
        <p className="public-footer-secondary">
          Programme version {programme.version.versionNumber} · published{" "}
          {published}
        </p>
      </div>
      <div className="public-footer-actions">
        <a
          className="btn small"
          href={`/api/v1/public/events/${encodeURIComponent(programme.event.slug)}/calendar.ics`}
        >
          Add to calendar (.ics)
        </a>
        <p className="public-footer-secondary">Powered by Program Cue</p>
      </div>
    </footer>
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
            href="#programme-speaker-profile"
            aria-label={`View profile and sessions for ${speaker.displayName}`}
            onClick={(event) =>
              model.openSpeakerProfile(speaker.id, event.currentTarget)
            }
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
  } = model;
  return (
    <div className="public-filters-bar">
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
        id={`session-${session.slug}`}
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
                  name: session.speakerNames[index]!,
                  affiliation: speakerAffiliation(speakerById.get(speakerId)!),
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
            Overlaps {selectedConflicts[0]!.title}, already in your itinerary.
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
                const speaker = speakerById.get(speakerId)!;
                const name = selected.speakerNames[index]!;
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
                        href={`#speaker-${speakerId}`}
                        onClick={(event) =>
                          model.openSpeakerProfile(
                            speakerId,
                            event.currentTarget,
                          )
                        }
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
      <Link
        className="btn small"
        to={`/public/programme/${programme.event.slug}#session-${selected.slug}`}
      >
        Shareable session link
      </Link>
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
    <div
      className={`itinerary-verification stack mb${itineraryVerificationPrompted ? " prompted" : ""}${raised ? "" : " latent"}`}
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
    </div>
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
    setSelectedId,
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
          in the platform's violet rather than the event's accent. */}
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
              <a className="btn small" href={`#speaker-${selectedSpeaker.id}`}>
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
                      href={`#session-${session.slug}`}
                      key={session.id}
                      onClick={() => setSelectedId(session.id)}
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
  const accentPalette = programmeAccentPalette(
    embedOptions.accent ?? programme.event.brandAccent,
  );
  return (
    <div
      className={`public-shell event-branded${embedded ? " embedded" : ""}${embedded && embedOptions.density === "compact" ? " embed-compact" : ""}`}
      style={
        {
          "--event-accent": accentPalette.accent,
          "--accent-ink": accentPalette.ink,
          "--accent-on-solid": accentPalette.onAccent,
        } as CSSProperties
      }
    >
      {!embedded ? <PublicProgrammeHeader model={model} /> : null}
      <PublicProgrammeHero model={model} />
      <main
        id="main"
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
            <div className="public-content" id="programme">
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
            </aside>
            <OverviewSpeakers model={model} />
          </>
        )}
      </main>
      {!embedded ? <PublicProgrammeFooter model={model} /> : null}
    </div>
  );
}

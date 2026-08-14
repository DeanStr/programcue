import { useRef, useState, type CSSProperties } from "react";
import { CalendarDays, MapPin, Search } from "lucide-react";
import { Link } from "react-router";

import { TurnstileWidget } from "~/components/turnstile-widget";
import {
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
  const { programme, loaderData, shared, saved, showSpeakers } = model;
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
    ...(showSpeakers
      ? [
          {
            key: "speakers",
            label: "Speakers",
            href: overviewSurface
              ? "#speakers"
              : publicProgrammeSurfacePath(slug, "speakers"),
            active: loaderData.surface === "speakers",
            routed: false,
          },
        ]
      : []),
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
    ...(showSpeakers
      ? [
          {
            key: "gallery",
            label: "Speaker Gallery",
            href: publicProgrammeSurfacePath(slug, "gallery"),
            active: loaderData.surface === "gallery",
            routed: true,
          },
        ]
      : []),
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
      <a className="btn public-itinerary-link" href={itineraryHref}>
        <span aria-hidden="true">♡</span>
        <span>{shared ? "Shared itinerary" : "My itinerary"}</span>
        <span className="status info">{saved.length}</span>
      </a>
    </header>
  );
}

function PublicProgrammeHero({ model }: { model: PublicProgrammeModel }) {
  const { programme, embedded } = model;
  const place = [programme.event.venue, programme.event.city]
    .filter(Boolean)
    .join(", ");
  const dayCount = new Set(
    programme.sessions.map((session) =>
      formatDay(session.startsAt, programme.event.timezone),
    ),
  ).size;
  const stats = [
    { label: "Sessions", value: programme.sessions.length },
    { label: "Speakers", value: programme.speakers.length },
    { label: dayCount === 1 ? "Day" : "Days", value: dayCount },
  ];
  return (
    <section className="hero">
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
          <dl className="hero-stats">
            {stats.map((stat) => (
              <div key={stat.label}>
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
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
        {model.showEmbedField("images") ? (
          <PublicSpeakerAvatar speaker={speaker} size={56} />
        ) : null}
        <div>
          <h3>{speaker.displayName}</h3>
          {model.showEmbedField("affiliations") && affiliation ? (
            <p className="help">{affiliation}</p>
          ) : null}
        </div>
      </div>
      {model.showEmbedField("biography") && speaker.biography ? (
        <p className="public-speaker-card-bio">
          {descriptionSnippet(speaker.biography)}
        </p>
      ) : null}
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
  return (
    <div className={`programme-entry${active ? " active" : ""}`}>
      <button
        type="button"
        id={`session-${session.slug}`}
        className={`programme-row${active ? " active" : ""}${model.showEmbedField("time") ? "" : " without-time"}`}
        aria-pressed={active}
        onClick={() => model.setSelectedId(session.id)}
      >
        {model.showEmbedField("time") ? (
          <span className="session-time">
            <SessionTime
              session={session}
              timezone={programme.event.timezone}
            />
          </span>
        ) : null}
        <span className="session-main">
          {model.showEmbedField("track") || model.showEmbedField("format") ? (
            <SessionTags
              session={session}
              showTrack={model.showEmbedField("track")}
              showFormat={model.showEmbedField("format")}
            />
          ) : null}
          <h3>{session.title}</h3>
          <SessionSpeakerLines session={session} model={model} />
          {model.showEmbedField("location") ? (
            <SessionPlace session={session} />
          ) : null}
        </span>
      </button>
      {!embedded && !shared ? (
        <SaveSessionButton session={session} model={model} />
      ) : null}
      {model.showEmbedField("description") && (snippet || !description) ? (
        <div className="programme-entry-description">
          <p id={`session-description-${session.id}`}>
            {description
              ? expanded
                ? description
                : snippet
              : "Description not provided."}
          </p>
          {snippet && snippet !== description ? (
            <button
              type="button"
              className="btn small"
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
        <div className="itinerary-empty">
          <span aria-hidden="true">♡</span>
          <p className="subtle">No saved sessions yet.</p>
          <p className="help">
            Save a session to build a personal itinerary you can share.
          </p>
        </div>
      )}
    </section>
  );
}

function SessionDetailPanel({ model }: { model: PublicProgrammeModel }) {
  const {
    selected,
    programme,
    speakerById,
    embedded,
    shared,
    saved,
    fetcher,
    showSpeakers,
  } = model;
  if (!selected) return null;
  return (
    <section className="card session-detail-panel">
      <span className="pc-page-eyebrow">Session detail</span>
      <h2>{selected.title}</h2>
      {model.showEmbedField("time") ? (
        <p className="session-detail-when">
          {formatDay(selected.startsAt, programme.event.timezone)} ·{" "}
          {formatProgrammeTimeRange(
            selected.startsAt,
            selected.endsAt,
            programme.event.timezone,
          )}
        </p>
      ) : null}
      {model.showEmbedField("location") ? (
        <SessionPlace session={selected} />
      ) : null}
      {model.showEmbedField("track") || model.showEmbedField("format") ? (
        <div className="public-detail-tags mt">
          {model.showEmbedField("track") && selected.track ? (
            <span className="pill track">{selected.track}</span>
          ) : null}
          {model.showEmbedField("format") ? (
            <span className="pill format">{selected.format}</span>
          ) : null}
        </div>
      ) : null}
      {model.showEmbedField("speakers") ? (
        <div className="stack mt mb">
          {selected.speakerIds.length ? (
            selected.speakerIds.map((speakerId, index) => {
              const speaker = speakerById.get(speakerId)!;
              const name = selected.speakerNames[index]!;
              const affiliation = speakerAffiliation(speaker);
              return (
                <div className="row-main" key={speakerId}>
                  {model.showEmbedField("images") && speaker.imageUrl ? (
                    <img
                      className="avatar"
                      src={speaker.imageUrl}
                      alt=""
                      width={40}
                      height={40}
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
              );
            })
          ) : (
            <div className="row-main">
              <span className="avatar" aria-hidden="true">
                PC
              </span>
              <div>
                <strong>Speaker to be announced</strong>
                {model.showEmbedField("track") && selected.track ? (
                  <small>{selected.track}</small>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
      {!embedded && !shared ? (
        <button
          type="button"
          className={`btn${saved.includes(selected.id) ? "" : " primary"}`}
          aria-describedby={
            model.requiresItineraryVerification(selected.id)
              ? "itinerary-verification-help"
              : undefined
          }
          disabled={fetcher.state !== "idle"}
          onClick={() => model.toggle(selected.id)}
        >
          {fetcher.state !== "idle"
            ? "Updating itinerary…"
            : saved.includes(selected.id)
              ? "Remove from itinerary"
              : "Add to itinerary"}
        </button>
      ) : null}
      {model.showEmbedField("description") ? (
        <>
          <h3>About this session</h3>
          <p className="session-detail-description">
            {selected.description || "A description is coming soon."}
          </p>
        </>
      ) : null}
      {showSpeakers &&
      model.showEmbedField("speakers") &&
      selected.speakerIds.length ? (
        <div className="stack mt">
          {selected.speakerIds.map((speakerId, index) => (
            <a
              key={speakerId}
              href={`#speaker-${speakerId}`}
              onClick={(event) =>
                model.openSpeakerProfile(speakerId, event.currentTarget)
              }
            >
              View {selected.speakerNames[index]}’s profile
            </a>
          ))}
        </div>
      ) : null}
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
  return (
    <div
      className={`itinerary-verification stack mb${itineraryVerificationPrompted ? " prompted" : ""}`}
      ref={itineraryVerificationRef}
      tabIndex={-1}
      aria-labelledby="itinerary-verification-help"
    >
      <p
        className={
          itineraryVerificationPrompted ? "validation-item warn" : "help"
        }
        id="itinerary-verification-help"
        role={
          itineraryVerificationPrompted || turnstileToken ? "status" : undefined
        }
      >
        {turnstileToken
          ? "Security check complete. Choose Save again to start this browser's itinerary."
          : "Complete this security check once, then choose Save again to start this browser's itinerary."}
      </p>
      <TurnstileWidget
        siteKey={loaderData.turnstileSiteKey}
        action="public_itinerary_create"
        onTokenChange={updateTurnstileToken}
        resetKey={turnstileResetKey}
      />
    </div>
  );
}

function OverviewSpeakers({ model }: { model: PublicProgrammeModel }) {
  const {
    showSpeakers,
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
      className="mt public-speakers-section"
      aria-labelledby="speakers-title"
      hidden={!showSpeakers}
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
              <OverviewSpeakers model={model} />
            </div>
            <aside id="itinerary">
              {!embedded ? <ItineraryPanel model={model} /> : null}
              <SessionDetailPanel model={model} />
            </aside>
          </>
        )}
      </main>
      {!embedded ? <PublicProgrammeFooter model={model} /> : null}
    </div>
  );
}

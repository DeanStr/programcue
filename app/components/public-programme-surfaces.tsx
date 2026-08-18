import { type ReactNode, type Ref, useRef, useState } from "react";
import {
  formatProgrammeDuration,
  formatProgrammeTimeRange,
  publicSessionDetailPath,
} from "~/modules/programme/programme-presentation";
import type {
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import {
  descriptionSnippet,
  formatDay,
  groupSessionsByDay,
  initials,
  normaliseDescription,
  type PublicProgrammeModel,
  sessionSpeakerDetails,
  speakerAffiliation,
} from "./public-programme-model";
import {
  ProgrammeDayHeading,
  PublicSpeakerAvatar,
  PublicSpeakerShareActions,
  SaveSessionButton,
  SessionPlace,
  SessionTags,
  SessionTime,
} from "./public-programme-parts";

function PublicDayTabs({
  model,
  label,
}: {
  model: PublicProgrammeModel;
  label: string;
}) {
  const activeDay =
    model.day === "All days" ? (model.days[0] ?? "All days") : model.day;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveToDay(index: number) {
    const nextDay = model.days[index];
    if (!nextDay) return;
    model.setDay(nextDay);
    tabRefs.current[index]?.focus();
  }

  return (
    <fieldset className="public-day-tabs pc-plain-fieldset" aria-label={label}>
      {model.days.map((day) => (
        <button
          type="button"
          className="btn small"
          aria-pressed={activeDay === day}
          ref={(element) => {
            tabRefs.current[model.days.indexOf(day)] = element;
          }}
          key={day}
          onClick={() => model.setDay(day)}
          onKeyDown={(event) => {
            const currentIndex = model.days.indexOf(day);
            if (currentIndex < 0 || model.days.length < 1) return;
            let nextIndex: number | null = null;
            if (event.key === "ArrowRight") {
              nextIndex = (currentIndex + 1) % model.days.length;
            } else if (event.key === "ArrowLeft") {
              nextIndex =
                (currentIndex - 1 + model.days.length) % model.days.length;
            } else if (event.key === "Home") {
              nextIndex = 0;
            } else if (event.key === "End") {
              nextIndex = model.days.length - 1;
            }
            if (nextIndex === null) return;
            event.preventDefault();
            moveToDay(nextIndex);
          }}
        >
          {day}
        </button>
      ))}
    </fieldset>
  );
}

function PublicSpeakerMetadata({ speaker }: { speaker: PublishedSpeaker }) {
  const affiliation = speakerAffiliation(speaker);
  if (!affiliation) return null;
  return <span className="public-speaker-metadata">{affiliation}</span>;
}

function PublicSpeakerPhoto({
  speaker,
  large = false,
}: {
  speaker: PublishedSpeaker;
  large?: boolean;
}) {
  if (speaker.imageUrl) {
    return (
      <img
        className={
          large ? "public-speaker-photo large" : "public-speaker-photo"
        }
        src={speaker.imageUrl}
        alt={`${speaker.displayName} headshot`}
        width={large ? 184 : 240}
        height={large ? 184 : 240}
        loading={large ? "eager" : "lazy"}
      />
    );
  }
  return (
    <span
      className={
        large
          ? "public-speaker-photo placeholder large"
          : "public-speaker-photo placeholder"
      }
      role="img"
      aria-label={`${speaker.displayName} headshot not available`}
    >
      {initials(speaker.displayName)}
      <small>Photo not available</small>
    </span>
  );
}

function PublicSessionSpeakers({
  session,
  model,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
}) {
  const speakers = sessionSpeakerDetails(session, model.speakerById);
  return speakers.length ? (
    <div className="public-session-speakers">
      {speakers.map((speaker) => (
        <div className="public-session-speaker" key={speaker.id}>
          {model.showEmbedField("images") ? (
            <PublicSpeakerAvatar speaker={speaker} size={32} />
          ) : null}
          <span>
            <strong>{speaker.displayName}</strong>
            {model.showEmbedField("affiliations") &&
            speakerAffiliation(speaker) ? (
              <span>{speakerAffiliation(speaker)}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <p className="subtle">Speaker to be announced</p>
  );
}

function PublicSessionSpeakerNames({
  session,
  model,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
}) {
  const speakers = sessionSpeakerDetails(session, model.speakerById);
  return speakers.length ? (
    <p className="public-session-speaker-names">
      <span className="sr-only">Speakers: </span>
      {speakers.map((speaker) => speaker.displayName).join(", ")}
    </p>
  ) : (
    <p className="subtle">Speaker to be announced</p>
  );
}

export function PublicSessionDetails({
  session,
  model,
  detailRef,
  onClose,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  detailRef?: Ref<HTMLElement>;
  onClose: () => void;
}) {
  return (
    <article
      id="public-session-detail"
      className="card pad public-surface-detail"
      aria-labelledby="public-session-detail-title"
      ref={detailRef}
      tabIndex={-1}
    >
      <div className="public-surface-detail-heading">
        <h2 id="public-session-detail-title">{session.title}</h2>
        <div className="page-actions">
          {model.showEmbedField("track") || model.showEmbedField("format") ? (
            <SessionTags
              session={session}
              showTrack={model.showEmbedField("track")}
              showFormat={model.showEmbedField("format")}
            />
          ) : null}
          <button type="button" className="btn small" onClick={onClose}>
            Close session details
          </button>
        </div>
      </div>
      {/* Speakers already appear on the agenda card. */}
      <div className="public-surface-detail-body">
        <div>
          {model.showEmbedField("description") ? (
            <p className="public-detail-description">
              {normaliseDescription(session.description) ||
                "Description not provided."}
            </p>
          ) : null}
        </div>
        <aside className="public-surface-detail-facts">
          <dl className="public-detail-list">
            {model.showEmbedField("time") ? (
              <>
                <dt>When</dt>
                <dd>
                  {formatDay(session.startsAt, model.programme.event.timezone)}
                  <br />
                  {formatProgrammeTimeRange(
                    session.startsAt,
                    session.endsAt,
                    model.programme.event.timezone,
                  )}{" "}
                  · {formatProgrammeDuration(session.startsAt, session.endsAt)}
                </dd>
              </>
            ) : null}
            {model.showEmbedField("location") ? (
              <>
                <dt>Where</dt>
                <dd>
                  {[session.room, session.building, session.level]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
    </article>
  );
}

function SessionCardDescription({
  session,
  model,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
}) {
  const description = normaliseDescription(session.description);
  const snippet = descriptionSnippet(description);
  const expanded = model.expandedDescriptions.includes(session.id);
  return (
    <div className="public-surface-description">
      <p id={`public-${session.id}-description`}>
        {expanded ? description : snippet || "Description not provided."}
      </p>
      {snippet !== description ? (
        <button
          type="button"
          className="btn small"
          aria-expanded={expanded}
          aria-controls={`public-${session.id}-description`}
          aria-label={`${expanded ? "Show less" : "Show more"} of the ${session.title} description`}
          onClick={() => model.toggleDescription(session.id)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

const SPARSE_SPEAKER_SEARCH = 6;
const SPARSE_AGENDA_DAYS = 3;

/**
 * A published surface is named like a section in an event site, not like an
 * admin index. Search and a count badge earn their place only when the
 * fixture is long enough that a visitor would look for them.
 */
function SurfaceHeading({
  kicker,
  title,
  id,
  description,
  count,
  children,
  sparse = false,
}: {
  kicker?: string;
  title: string;
  id: string;
  description?: string;
  count?: string;
  children?: ReactNode;
  sparse?: boolean;
}) {
  const aside = sparse ? (
    children
  ) : count || children ? (
    <>
      {count ? <span className="status info">{count}</span> : null}
      {children}
    </>
  ) : null;
  return (
    <div className={`public-surface-heading${sparse ? " is-sparse" : ""}`}>
      <div className="public-surface-heading-copy">
        {kicker ? <p className="public-surface-kicker">{kicker}</p> : null}
        <h1 id={id}>{title}</h1>
        {description ? <p className="subtle">{description}</p> : null}
      </div>
      {aside ? (
        <div className="public-surface-heading-aside">{aside}</div>
      ) : null}
    </div>
  );
}

function SpeakerSearchField({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="public-surface-search">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search by name"
        type="search"
      />
    </div>
  );
}

export function PublicAgendaSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const detailRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const activeDay =
    model.day === "All days" ? (model.days[0] ?? "All days") : model.day;
  const showEveryDay = model.embedded && model.day === "All days";
  const sessions = showEveryDay
    ? model.visible
    : model.visible.filter(
        (session) =>
          formatDay(session.startsAt, model.programme.event.timezone) ===
          activeDay,
      );
  const sparse = model.days.length <= SPARSE_AGENDA_DAYS;
  const agendaDays = groupSessionsByDay(
    sessions,
    model.programme.event.timezone,
  );
  const selectedSession = detailsOpen
    ? (sessions.find((session) => session.id === model.selected?.id) ??
      sessions[0] ??
      null)
    : null;
  const openSessionDetails = (
    sessionId: string,
    trigger: HTMLButtonElement,
  ) => {
    returnFocusRef.current = trigger;
    setDetailsOpen(true);
    model.setSelectedId(sessionId);
    requestAnimationFrame(() => detailRef.current?.focus());
  };
  const closeSessionDetails = () => {
    const fallbackFocus = selectedSession
      ? document.getElementById(`agenda-session-trigger-${selectedSession.id}`)
      : null;
    const returnFocus = returnFocusRef.current?.isConnected
      ? returnFocusRef.current
      : fallbackFocus;
    setDetailsOpen(false);
    requestAnimationFrame(() => returnFocus?.focus());
  };
  return (
    <section
      className="public-surface public-agenda-surface"
      aria-labelledby="public-agenda-title"
    >
      <SurfaceHeading
        title="Agenda"
        id="public-agenda-title"
        description={
          sparse
            ? undefined
            : showEveryDay
              ? "Every published session, grouped by day."
              : "Published sessions for the selected day."
        }
        count={sparse ? undefined : `${sessions.length} sessions`}
        sparse={sparse}
      />
      {!model.embedded && model.showControl("day") ? (
        <PublicDayTabs model={model} label="Agenda days" />
      ) : null}
      {sessions.length ? (
        <div className="public-agenda-days">
          {agendaDays.map((group) => (
            <section className="public-agenda-day" key={group.key}>
              <ProgrammeDayHeading
                label={group.label}
                count={group.sessions.length}
              />
              <ol className="agenda-board" aria-label={`${group.label} agenda`}>
                {group.sessions.map((session) => {
                  const open = session.id === selectedSession?.id;
                  return (
                    <li
                      className={`agenda-card${open ? " active" : ""}`}
                      key={session.id}
                    >
                      {model.showEmbedField("time") ? (
                        <div className="agenda-card-time">
                          <SessionTime
                            session={session}
                            timezone={model.programme.event.timezone}
                          />
                        </div>
                      ) : null}
                      <div className="agenda-card-body">
                        <h2 className="agenda-card-title">
                          <button
                            id={`agenda-session-trigger-${session.id}`}
                            type="button"
                            className="agenda-card-trigger"
                            aria-expanded={open}
                            aria-controls="public-session-detail"
                            aria-label={`${open ? "Hide" : "View"} details for ${session.title}`}
                            onClick={(event) =>
                              open
                                ? closeSessionDetails()
                                : openSessionDetails(
                                    session.id,
                                    event.currentTarget,
                                  )
                            }
                          >
                            {session.title}
                          </button>
                        </h2>
                        {model.showSpeakerDetails ? (
                          <PublicSessionSpeakers
                            session={session}
                            model={model}
                          />
                        ) : (
                          <PublicSessionSpeakerNames
                            session={session}
                            model={model}
                          />
                        )}
                        {model.showEmbedField("location") ||
                        model.showEmbedField("track") ||
                        model.showEmbedField("format") ? (
                          <div className="agenda-card-meta">
                            {model.showEmbedField("location") ? (
                              <SessionPlace session={session} />
                            ) : null}
                            {model.showEmbedField("track") ||
                            model.showEmbedField("format") ? (
                              <SessionTags
                                session={session}
                                showTrack={model.showEmbedField("track")}
                                showFormat={model.showEmbedField("format")}
                              />
                            ) : null}
                          </div>
                        ) : null}
                        {open ? (
                          <PublicSessionDetails
                            session={session}
                            model={model}
                            detailRef={detailRef}
                            onClose={closeSessionDetails}
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <p className="empty">No published sessions on this day.</p>
      )}
    </section>
  );
}

/**
 * The chronological read: one day at a time, in programme order, with the
 * calendar date stated once by the day heading rather than repeated on every
 * card.
 */
export function PublicScheduleSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const activeDay =
    model.day === "All days" ? (model.days[0] ?? "All days") : model.day;
  const days = groupSessionsByDay(
    model.embedded && model.day === "All days"
      ? model.visible
      : model.visible.filter(
          (session) =>
            formatDay(session.startsAt, model.programme.event.timezone) ===
            activeDay,
        ),
    model.programme.event.timezone,
  );
  const sessionCount = days.reduce(
    (total, group) => total + group.sessions.length,
    0,
  );
  return (
    <section className="public-surface" aria-labelledby="public-schedule-title">
      <SurfaceHeading
        title="Schedule Itinerary"
        id="public-schedule-title"
        description="A day-by-day itinerary of the published programme, with complete session and speaker details."
        count={`${sessionCount} sessions`}
      />
      {!model.embedded && model.showControl("day") ? (
        <PublicDayTabs model={model} label="Schedule itinerary days" />
      ) : null}
      {days.length ? (
        days.map((group) => (
          <section className="public-itinerary-day" key={group.key}>
            <ProgrammeDayHeading
              label={group.label}
              count={group.sessions.length}
            />
            <ol className="public-itinerary-list" aria-label={group.label}>
              {group.sessions.map((session) => (
                <li
                  className={`public-itinerary-card${model.showEmbedField("time") ? "" : " without-time"}`}
                  key={session.id}
                >
                  {model.showEmbedField("time") ? (
                    <div className="public-itinerary-time">
                      <SessionTime
                        session={session}
                        timezone={model.programme.event.timezone}
                      />
                    </div>
                  ) : null}
                  <div className="public-itinerary-content">
                    <div className="public-itinerary-title-row">
                      <h2>{session.title}</h2>
                      {model.embedded || model.shared ? null : (
                        <SaveSessionButton session={session} model={model} />
                      )}
                    </div>
                    {model.showEmbedField("location") ||
                    model.showEmbedField("track") ||
                    model.showEmbedField("format") ? (
                      <div className="public-itinerary-meta">
                        {model.showEmbedField("location") ? (
                          <SessionPlace session={session} />
                        ) : null}
                        {model.showEmbedField("track") ||
                        model.showEmbedField("format") ? (
                          <SessionTags
                            session={session}
                            showTrack={model.showEmbedField("track")}
                            showFormat={model.showEmbedField("format")}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {model.showEmbedField("description") ? (
                      <SessionCardDescription session={session} model={model} />
                    ) : null}
                    {model.showSpeakerDetails ? (
                      <PublicSessionSpeakers session={session} model={model} />
                    ) : (
                      <PublicSessionSpeakerNames
                        session={session}
                        model={model}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))
      ) : (
        <p className="empty">No published sessions match the current day.</p>
      )}
    </section>
  );
}

function SpeakerDirectoryCard({
  speaker,
  model,
}: {
  speaker: PublishedSpeaker;
  model: PublicProgrammeModel;
}) {
  const content = (
    <>
      {model.showSpeakerDetails && model.showEmbedField("images") ? (
        <PublicSpeakerPhoto speaker={speaker} />
      ) : null}
      <span className="public-speaker-directory-copy">
        <strong>{speaker.displayName}</strong>
        {model.showSpeakerDetails && model.showEmbedField("affiliations") ? (
          <PublicSpeakerMetadata speaker={speaker} />
        ) : null}
        {model.showSpeakerDetails &&
        model.showEmbedField("biography") &&
        speaker.biography ? (
          <span className="public-speaker-directory-bio">
            {descriptionSnippet(speaker.biography)}
          </span>
        ) : null}
        {model.showSpeakerDetails && model.showEmbedField("sessions") ? (
          <span className="help">
            {speaker.sessionIds.length} public session
            {speaker.sessionIds.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {model.showSpeakerDetails ? (
          <span className="public-speaker-profile-cue">View profile</span>
        ) : null}
      </span>
    </>
  );
  return model.showSpeakerDetails ? (
    <article className="public-speaker-directory-card">
      <button
        type="button"
        className="public-speaker-directory-trigger"
        id={`public-speaker-card-${speaker.id}`}
        aria-label={`Open speaker details for ${speaker.displayName}`}
        onClick={(event) =>
          model.openSpeakerProfile(speaker.id, event.currentTarget)
        }
      >
        {content}
      </button>
    </article>
  ) : (
    <article
      className="public-speaker-directory-card"
      id={`public-speaker-card-${speaker.id}`}
    >
      <div className="public-speaker-directory-trigger is-static">
        {content}
      </div>
    </article>
  );
}

export function PublicSpeakersSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const publishedCount =
    model.orderedSpeakers?.length ?? model.directorySpeakers.length;
  const sparse = publishedCount <= SPARSE_SPEAKER_SEARCH;
  const showSearch = !model.embedded && model.showControl("search");
  const pair = model.directorySpeakers.length <= 2;
  return (
    <section
      className={`public-surface public-speakers-surface${pair ? " is-pair" : ""}`}
      aria-labelledby="public-speakers-title"
    >
      <SurfaceHeading
        kicker="The people on stage"
        title="Speakers"
        id="public-speakers-title"
        description={
          sparse
            ? undefined
            : model.showSpeakerDetails
              ? "Meet the people presenting this event."
              : "Meet the people presenting this event."
        }
        count={
          sparse ? undefined : `${model.directorySpeakers.length} speakers`
        }
        sparse={sparse}
      >
        {showSearch ? (
          <SpeakerSearchField
            id="public-speaker-search"
            value={model.directoryQuery}
            onChange={model.setDirectoryQuery}
            label="Search speakers by name"
          />
        ) : null}
      </SurfaceHeading>
      <div className={`public-speaker-directory-grid${pair ? " is-pair" : ""}`}>
        {model.directorySpeakers.length ? (
          model.directorySpeakers.map((speaker) => (
            <SpeakerDirectoryCard
              key={speaker.id}
              speaker={speaker}
              model={model}
            />
          ))
        ) : (
          <p className="empty">No speakers match this search.</p>
        )}
      </div>
      {model.selectedSpeaker ? (
        <SpeakerDetailPanel model={model} variant="directory" />
      ) : null}
    </section>
  );
}

function SpeakerGalleryCard({
  speaker,
  model,
}: {
  speaker: PublishedSpeaker;
  model: PublicProgrammeModel;
}) {
  const content = (
    <>
      {model.showSpeakerDetails && model.showEmbedField("images") ? (
        <PublicSpeakerPhoto speaker={speaker} />
      ) : null}
      <span className="speaker-gallery-card-copy">
        <strong>{speaker.displayName}</strong>
        {model.showSpeakerDetails && model.showEmbedField("affiliations") ? (
          <PublicSpeakerMetadata speaker={speaker} />
        ) : null}
        {model.showSpeakerDetails && model.showEmbedField("sessions") ? (
          <span className="speaker-gallery-card-sessions">
            {speaker.sessionIds.length} session
            {speaker.sessionIds.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {model.showSpeakerDetails ? (
          <span className="public-speaker-profile-cue">View profile</span>
        ) : null}
      </span>
    </>
  );
  return model.showSpeakerDetails ? (
    <button
      type="button"
      className="speaker-gallery-card"
      id={`speaker-gallery-card-${speaker.id}`}
      aria-label={`Open speaker details for ${speaker.displayName}`}
      onClick={(event) =>
        model.openSpeakerProfile(speaker.id, event.currentTarget)
      }
    >
      {content}
    </button>
  ) : (
    <article
      className="speaker-gallery-card is-static"
      id={`speaker-gallery-card-${speaker.id}`}
    >
      {content}
    </article>
  );
}

function SpeakerDetailPanel({
  model,
  variant,
}: {
  model: PublicProgrammeModel;
  variant: "directory" | "gallery";
}) {
  const speaker = model.selectedSpeaker;
  if (!speaker) return null;
  const biography = normaliseDescription(speaker.biography ?? "");
  const biographySnippet = descriptionSnippet(biography);
  const biographyIsLong = biographySnippet !== biography;
  const biographyId = `${variant}-speaker-biography-${speaker.id}`;
  return (
    <article
      className={`card pad public-speaker-detail${variant === "gallery" ? " public-speaker-gallery-detail" : ""}`}
      id={
        variant === "gallery"
          ? "speaker-gallery-detail"
          : "public-speaker-detail"
      }
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${variant}-speaker-detail-name`}
      tabIndex={-1}
      ref={model.speakerProfileRef}
    >
      <div className="public-speaker-detail-heading">
        {model.showEmbedField("images") ? (
          <PublicSpeakerPhoto speaker={speaker} large />
        ) : null}
        <div>
          <h2 id={`${variant}-speaker-detail-name`}>{speaker.displayName}</h2>
          {model.showEmbedField("affiliations") ? (
            <PublicSpeakerMetadata speaker={speaker} />
          ) : null}
          <div className="public-profile-actions">
            {!model.embedded ? (
              <PublicSpeakerShareActions model={model} />
            ) : null}
            <button
              type="button"
              className="btn small"
              onClick={model.closeSpeakerProfile}
            >
              Close speaker details
            </button>
          </div>
        </div>
      </div>
      {model.showEmbedField("biography") && biography ? (
        <>
          <h3>Biography</h3>
          <p id={biographyId}>
            {model.expandedSpeakerBiography ? biography : biographySnippet}
          </p>
          {biographyIsLong ? (
            <button
              type="button"
              className="btn small"
              aria-expanded={model.expandedSpeakerBiography}
              aria-controls={biographyId}
              onClick={model.toggleSpeakerBiography}
            >
              {model.expandedSpeakerBiography ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      ) : null}
      {model.showEmbedField("sessions") ? (
        <>
          <h3>
            Sessions{" "}
            <span className="status info">
              {model.selectedSpeakerAllSessions.length}
            </span>
          </h3>
          <div className="public-speaker-session-list">
            {model.selectedSpeakerAllSessions.length ? (
              model.selectedSpeakerAllSessions.map((session) => (
                <a
                  href={publicSessionDetailPath(
                    model.programme.event.slug,
                    session.id,
                  )}
                  key={session.id}
                >
                  <strong>{session.title}</strong>
                  {model.showEmbedField("time") ? (
                    <span>
                      {formatDay(
                        session.startsAt,
                        model.programme.event.timezone,
                      )}{" "}
                      ·{" "}
                      {formatProgrammeTimeRange(
                        session.startsAt,
                        session.endsAt,
                        model.programme.event.timezone,
                      )}
                    </span>
                  ) : null}
                  {model.showEmbedField("location") ? (
                    <span>{session.room}</span>
                  ) : null}
                </a>
              ))
            ) : (
              <p className="subtle">No published sessions.</p>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

export function PublicSpeakerGallerySurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const publishedCount =
    model.orderedSpeakers?.length ?? model.gallerySpeakers.length;
  const sparse = publishedCount <= SPARSE_SPEAKER_SEARCH;
  const showSearch = !model.embedded && model.showControl("search");
  const pair = model.gallerySpeakers.length <= 2;
  return (
    <section
      className={`public-surface speaker-gallery-surface${pair ? " is-pair" : ""}`}
      aria-labelledby="speaker-gallery-title"
    >
      <SurfaceHeading
        kicker="The people on stage"
        title="Speaker Gallery"
        id="speaker-gallery-title"
        description={
          sparse
            ? undefined
            : model.showSpeakerDetails
              ? "Published portraits from this event."
              : "Published portraits from this event."
        }
        count={sparse ? undefined : `${model.gallerySpeakers.length} speakers`}
        sparse={sparse}
      >
        {showSearch ? (
          <SpeakerSearchField
            id="speaker-gallery-search"
            value={model.galleryQuery}
            onChange={model.setGalleryQuery}
            label="Search speaker gallery by name"
          />
        ) : null}
      </SurfaceHeading>
      {model.gallerySpeakers.length ? (
        <div className={`speaker-gallery-grid${pair ? " is-pair" : ""}`}>
          {model.gallerySpeakers.map((speaker) => (
            <SpeakerGalleryCard
              key={speaker.id}
              speaker={speaker}
              model={model}
            />
          ))}
        </div>
      ) : (
        <p className="empty">No speakers match this search.</p>
      )}
      {model.selectedSpeaker ? (
        <SpeakerDetailPanel model={model} variant="gallery" />
      ) : null}
    </section>
  );
}

export function PublicProgrammeSurfaceContent({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  if (model.surface === "agenda") return <PublicAgendaSurface model={model} />;
  if (model.surface === "schedule")
    return <PublicScheduleSurface model={model} />;
  if (model.surface === "speakers")
    return <PublicSpeakersSurface model={model} />;
  if (model.surface === "gallery")
    return <PublicSpeakerGallerySurface model={model} />;
  return null;
}

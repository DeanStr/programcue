import { useRef, type ReactNode, type Ref } from "react";

import {
  descriptionSnippet,
  formatDay,
  groupSessionsByDay,
  initials,
  normaliseDescription,
  sessionSpeakerDetails,
  speakerAffiliation,
  type PublicProgrammeModel,
} from "./public-programme-model";
import {
  ProgrammeDayHeading,
  PublicSpeakerAvatar,
  SaveSessionButton,
  SessionPlace,
  SessionTags,
  SessionTime,
} from "./public-programme-parts";
import {
  formatProgrammeDuration,
  formatProgrammeTimeRange,
} from "~/modules/programme/programme-presentation";
import type {
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";

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
    <div className="public-day-tabs" role="group" aria-label={label}>
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
    </div>
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
    <div className="public-session-speakers" aria-label="Speakers">
      {speakers.map((speaker) => (
        <div className="public-session-speaker" key={speaker.id}>
          <PublicSpeakerAvatar speaker={speaker} size={32} />
          <span>
            <strong>{speaker.displayName}</strong>
            {speakerAffiliation(speaker) ? (
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

export function PublicSessionDetails({
  session,
  model,
  detailRef,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  detailRef?: Ref<HTMLElement>;
}) {
  return (
    <article
      className="card pad public-surface-detail"
      aria-labelledby="public-session-detail-title"
      ref={detailRef}
      tabIndex={-1}
    >
      <div className="public-surface-detail-heading">
        <div>
          <span className="pc-page-eyebrow">Session detail</span>
          <h2 id="public-session-detail-title">{session.title}</h2>
        </div>
        <SessionTags session={session} />
      </div>
      <div className="public-surface-detail-body">
        <div>
          <p className="public-detail-description">
            {normaliseDescription(session.description) ||
              "Description not provided."}
          </p>
        </div>
        <aside className="public-surface-detail-facts">
          <dl className="public-detail-list">
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
            <dt>Where</dt>
            <dd>
              {[session.room, session.building, session.level]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </dl>
          <h3>Speakers</h3>
          <PublicSessionSpeakers session={session} model={model} />
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

/**
 * Heading, count and the surface's own control sit on one line. Keeping the
 * search beside the count stops a directory of a handful of speakers from
 * reading as an empty page with a stray badge in the corner.
 */
function SurfaceHeading({
  eyebrow,
  title,
  id,
  description,
  count,
  children,
}: {
  eyebrow: string;
  title: string;
  id: string;
  description: string;
  count: string;
  children?: ReactNode;
}) {
  return (
    <div className="public-surface-heading">
      <div className="public-surface-heading-copy">
        <span className="pc-page-eyebrow">{eyebrow}</span>
        <h1 id={id}>{title}</h1>
        <p className="subtle">{description}</p>
      </div>
      <div className="public-surface-heading-aside">
        <span className="status info">{count}</span>
        {children}
      </div>
    </div>
  );
}

export function PublicAgendaSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const detailRef = useRef<HTMLElement>(null);
  const activeDay =
    model.day === "All days" ? (model.days[0] ?? "All days") : model.day;
  const sessions = model.visible.filter(
    (session) =>
      formatDay(session.startsAt, model.programme.event.timezone) === activeDay,
  );
  const selectedSession =
    sessions.find((session) => session.id === model.selected?.id) ??
    sessions[0] ??
    null;
  const openSessionDetails = (sessionId: string) => {
    model.setSelectedId(sessionId);
    requestAnimationFrame(() => detailRef.current?.focus());
  };
  return (
    <section className="public-surface" aria-labelledby="public-agenda-title">
      <SurfaceHeading
        eyebrow="Public programme"
        title="Agenda"
        id="public-agenda-title"
        description="Every published session for the selected day, side by side."
        count={`${sessions.length} sessions`}
      />
      <PublicDayTabs model={model} label="Agenda days" />
      <div
        className="agenda-board"
        role="list"
        aria-label={`${activeDay} agenda`}
      >
        {sessions.length ? (
          sessions.map((session) => (
            <article
              className={`agenda-card${session.id === selectedSession?.id ? " active" : ""}`}
              key={session.id}
              role="listitem"
            >
              <div className="agenda-card-time">
                <SessionTime
                  session={session}
                  timezone={model.programme.event.timezone}
                />
              </div>
              <h2 className="agenda-card-title">
                <button
                  type="button"
                  className="agenda-card-trigger"
                  aria-pressed={session.id === selectedSession?.id}
                  aria-label={`View details for ${session.title}`}
                  onClick={() => openSessionDetails(session.id)}
                >
                  {session.title}
                  <span className="agenda-card-action" aria-hidden="true">
                    View details
                  </span>
                </button>
              </h2>
              <div className="agenda-card-meta">
                <SessionPlace session={session} />
                <SessionTags session={session} />
              </div>
              <p className="public-surface-description agenda-card-description">
                {descriptionSnippet(
                  normaliseDescription(session.description),
                ) || "Description not provided."}
              </p>
              <PublicSessionSpeakers session={session} model={model} />
            </article>
          ))
        ) : (
          <p className="empty">No published sessions on this day.</p>
        )}
      </div>
      {selectedSession ? (
        <PublicSessionDetails
          session={selectedSession}
          model={model}
          detailRef={detailRef}
        />
      ) : null}
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
    model.visible.filter(
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
        eyebrow="Browse chronologically"
        title="Schedule Itinerary"
        id="public-schedule-title"
        description="A day-by-day itinerary of the published programme, with complete session and speaker details."
        count={`${sessionCount} sessions`}
      />
      <PublicDayTabs model={model} label="Schedule itinerary days" />
      {days.length ? (
        days.map((group) => (
          <section className="public-itinerary-day" key={group.key}>
            <ProgrammeDayHeading
              label={group.label}
              count={group.sessions.length}
            />
            <ol className="public-itinerary-list" aria-label={group.label}>
              {group.sessions.map((session) => (
                <li className="public-itinerary-card" key={session.id}>
                  <div className="public-itinerary-time">
                    <SessionTime
                      session={session}
                      timezone={model.programme.event.timezone}
                    />
                  </div>
                  <div className="public-itinerary-content">
                    <div className="public-itinerary-title-row">
                      <h2>{session.title}</h2>
                      {model.embedded || model.shared ? null : (
                        <SaveSessionButton session={session} model={model} />
                      )}
                    </div>
                    <div className="public-itinerary-meta">
                      <SessionPlace session={session} />
                      <SessionTags session={session} />
                    </div>
                    <SessionCardDescription session={session} model={model} />
                    <PublicSessionSpeakers session={session} model={model} />
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
  return (
    <article className="card pad public-speaker-directory-card">
      <button
        type="button"
        className="public-speaker-directory-trigger"
        id={`public-speaker-card-${speaker.id}`}
        aria-label={`Open speaker details for ${speaker.displayName}`}
        onClick={(event) =>
          model.openSpeakerProfile(speaker.id, event.currentTarget)
        }
      >
        <PublicSpeakerPhoto speaker={speaker} />
        <span>
          <strong>{speaker.displayName}</strong>
          <PublicSpeakerMetadata speaker={speaker} />
        </span>
      </button>
      <p>
        {speaker.biography
          ? descriptionSnippet(speaker.biography)
          : "Biography not provided."}
      </p>
      <span className="help">
        {speaker.sessionIds.length} public session
        {speaker.sessionIds.length === 1 ? "" : "s"}
      </span>
    </article>
  );
}

export function PublicSpeakersSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  return (
    <section className="public-surface" aria-labelledby="public-speakers-title">
      <SurfaceHeading
        eyebrow="Published directory"
        title="Speakers"
        id="public-speakers-title"
        description="Meet the people presenting this event."
        count={`${model.directorySpeakers.length} speakers`}
      >
        <div className="public-surface-search">
          <label className="sr-only" htmlFor="public-speaker-search">
            Search speakers by name
          </label>
          <input
            id="public-speaker-search"
            className="field"
            value={model.directoryQuery}
            onChange={(event) => model.setDirectoryQuery(event.target.value)}
            placeholder="Search by name"
            type="search"
          />
        </div>
      </SurfaceHeading>
      <div className="grid grid-3 public-speaker-directory-grid">
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
  return (
    <button
      type="button"
      className="speaker-gallery-card"
      id={`speaker-gallery-card-${speaker.id}`}
      aria-label={`Open speaker details for ${speaker.displayName}`}
      onClick={(event) =>
        model.openSpeakerProfile(speaker.id, event.currentTarget)
      }
    >
      <PublicSpeakerPhoto speaker={speaker} />
      <span className="speaker-gallery-card-copy">
        <strong>{speaker.displayName}</strong>
        <PublicSpeakerMetadata speaker={speaker} />
        <span className="speaker-gallery-card-sessions">
          {speaker.sessionIds.length} session
          {speaker.sessionIds.length === 1 ? "" : "s"}
        </span>
      </span>
    </button>
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
        <PublicSpeakerPhoto speaker={speaker} large />
        <div>
          <span className="pc-page-eyebrow">Speaker details</span>
          <h2 id={`${variant}-speaker-detail-name`}>{speaker.displayName}</h2>
          <PublicSpeakerMetadata speaker={speaker} />
          <div className="public-profile-actions">
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
      <h3>Biography</h3>
      <p id={biographyId}>
        {biography
          ? model.expandedSpeakerBiography
            ? biography
            : biographySnippet
          : "Biography not provided."}
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
              href={`/public/programme/${encodeURIComponent(model.programme.event.slug)}#session-${session.slug}`}
              key={session.id}
            >
              <strong>{session.title}</strong>
              <span>
                {formatDay(session.startsAt, model.programme.event.timezone)} ·{" "}
                {formatProgrammeTimeRange(
                  session.startsAt,
                  session.endsAt,
                  model.programme.event.timezone,
                )}
              </span>
              <span>{session.room}</span>
            </a>
          ))
        ) : (
          <p className="subtle">No published sessions.</p>
        )}
      </div>
    </article>
  );
}

export function PublicSpeakerGallerySurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  return (
    <section
      className="public-surface speaker-gallery-surface"
      aria-labelledby="speaker-gallery-title"
    >
      <SurfaceHeading
        eyebrow="Visual speaker showcase"
        title="Speaker Gallery"
        id="speaker-gallery-title"
        description="Browse the published speaker community by name. Open a card for biography and session details."
        count={`${model.gallerySpeakers.length} speakers`}
      >
        <div className="public-surface-search">
          <label className="sr-only" htmlFor="speaker-gallery-search">
            Search speaker gallery by name
          </label>
          <input
            id="speaker-gallery-search"
            className="field"
            value={model.galleryQuery}
            onChange={(event) => model.setGalleryQuery(event.target.value)}
            placeholder="Search by name"
            type="search"
          />
        </div>
      </SurfaceHeading>
      {model.gallerySpeakers.length ? (
        <div className="speaker-gallery-grid" aria-label="Speaker Gallery">
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

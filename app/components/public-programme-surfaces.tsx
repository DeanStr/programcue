import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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
  formatTime,
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

/**
 * The information-rich chronological read. Schedule keeps this stable meaning;
 * Timetable owns the separate room-by-time comparison.
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
        title="Day-by-day schedule"
        id="public-schedule-title"
        description="Browse the published programme in chronological order, with the details included in this view."
        count={`${sessionCount} sessions`}
      />
      {!model.embedded && model.showControl("day") ? (
        <PublicDayTabs model={model} label="Day-by-day schedule days" />
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

const TIMETABLE_MARKER_SECONDS = 30 * 60;

export function publicTimetableLayout(
  sessions: readonly PublishedSession[],
  timezone: string,
) {
  if (!sessions.length) return null;
  const startsAt = Math.min(...sessions.map((session) => session.startsAt));
  const endsAt = Math.max(...sessions.map((session) => session.endsAt));
  const localStartParts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(startsAt * 1_000));
  const localStartMinute = Number(
    localStartParts.find((part) => part.type === "minute")?.value,
  );
  const localStartSecond = Number(
    localStartParts.find((part) => part.type === "second")?.value,
  );
  const rangeStartsAt =
    startsAt - ((localStartMinute % 30) * 60 + localStartSecond);
  const rangeEndsAt =
    rangeStartsAt +
    Math.ceil((endsAt - rangeStartsAt) / TIMETABLE_MARKER_SECONDS) *
      TIMETABLE_MARKER_SECONDS;
  const rooms = [...new Set(sessions.map((session) => session.room))].sort(
    (left, right) =>
      left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }),
  );
  const markers: number[] = [];
  for (
    let marker = rangeStartsAt;
    marker <= rangeEndsAt;
    marker += TIMETABLE_MARKER_SECONDS
  ) {
    markers.push(marker);
  }
  return {
    rangeStartsAt,
    rangeMinutes: Math.max(30, (rangeEndsAt - rangeStartsAt) / 60),
    rooms,
    markers,
  };
}

function PublicTimetableDay({
  sessions,
  label,
  model,
  selectedSessionId,
  detailSession,
  openSessionDetails,
  closeSessionDetails,
}: {
  sessions: PublishedSession[];
  label: string;
  model: PublicProgrammeModel;
  selectedSessionId: string | null;
  detailSession: PublishedSession | null;
  openSessionDetails: (
    session: PublishedSession,
    trigger: HTMLButtonElement,
  ) => void;
  closeSessionDetails: () => void;
}) {
  const layout = publicTimetableLayout(
    sessions,
    model.programme.event.timezone,
  );
  if (!layout) return null;
  const columns = `5.5rem repeat(${layout.rooms.length}, minmax(12rem, 1fr))`;
  const rows = `auto repeat(${layout.rangeMinutes}, 2.5px)`;
  return (
    <section className="public-timetable-day" aria-label={`${label} timetable`}>
      <ProgrammeDayHeading label={label} count={sessions.length} />
      <div className="public-timetable-frame">
        <div
          className="public-timetable-grid"
          style={
            {
              "--timetable-columns": columns,
              "--timetable-rows": rows,
              "--timetable-min-width": `${88 + layout.rooms.length * 192}px`,
            } as CSSProperties
          }
        >
          <div className="public-timetable-corner" aria-hidden="true">
            {model.showEmbedField("time") ? "Time" : null}
          </div>
          {layout.rooms.map((room, index) => (
            <div
              className="public-timetable-room"
              style={{ gridColumn: index + 2, gridRow: 1 }}
              key={room}
            >
              {model.showEmbedField("location") ? room : `Room ${index + 1}`}
            </div>
          ))}
          {layout.markers.map((marker, index) => (
            <div
              className={`public-timetable-marker${index === 0 ? " is-first" : ""}`}
              style={{
                gridColumn: `1 / ${layout.rooms.length + 2}`,
                gridRow: Math.floor((marker - layout.rangeStartsAt) / 60) + 2,
              }}
              key={marker}
              aria-hidden="true"
            >
              {model.showEmbedField("time") ? (
                <time dateTime={new Date(marker * 1_000).toISOString()}>
                  {formatTime(marker, model.programme.event.timezone)}
                </time>
              ) : null}
            </div>
          ))}
          {sessions.map((session) => {
            const roomIndex = layout.rooms.indexOf(session.room);
            const startMinute = Math.floor(
              (session.startsAt - layout.rangeStartsAt) / 60,
            );
            const durationMinutes = Math.max(
              1,
              Math.ceil((session.endsAt - session.startsAt) / 60),
            );
            const detailsExpanded = selectedSessionId === session.id;
            return (
              <article
                className="public-timetable-session"
                style={
                  {
                    "--timetable-column": roomIndex + 2,
                    "--timetable-row": `${startMinute + 2} / span ${durationMinutes}`,
                  } as CSSProperties
                }
                key={session.id}
              >
                <div className="public-timetable-session-heading">
                  <h2>
                    <button
                      type="button"
                      className="public-timetable-session-trigger"
                      aria-haspopup={model.embedded ? undefined : "dialog"}
                      aria-controls={
                        model.embedded && detailsExpanded
                          ? `public-timetable-inline-detail-${session.id}`
                          : undefined
                      }
                      aria-expanded={detailsExpanded}
                      aria-label={`${model.embedded && detailsExpanded ? "Close" : "Open"} details for ${session.title}`}
                      onClick={(event) =>
                        openSessionDetails(session, event.currentTarget)
                      }
                    >
                      {session.title}
                    </button>
                  </h2>
                  {model.embedded || model.shared ? null : (
                    <SaveSessionButton session={session} model={model} />
                  )}
                </div>
                {model.showEmbedField("time") ? (
                  <span className="session-time">
                    <SessionTime
                      session={session}
                      timezone={model.programme.event.timezone}
                    />
                  </span>
                ) : null}
                {model.showEmbedField("location") ? (
                  <span className="public-timetable-session-room">
                    <span className="sr-only">Room: </span>
                    {session.room}
                  </span>
                ) : null}
                {model.showEmbedField("track") ||
                model.showEmbedField("format") ? (
                  <SessionTags
                    session={session}
                    showTrack={model.showEmbedField("track")}
                    showFormat={model.showEmbedField("format")}
                  />
                ) : null}
                <PublicSessionSpeakerNames session={session} model={model} />
              </article>
            );
          })}
        </div>
      </div>
      {model.embedded && detailSession ? (
        <PublicTimetableSessionInlineDetail
          session={detailSession}
          model={model}
          close={closeSessionDetails}
          key={detailSession.id}
        />
      ) : null}
    </section>
  );
}

function PublicTimetableSessionDetail({
  session,
  model,
  close,
  closeButtonRef,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  close: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const speakers = sessionSpeakerDetails(session, model.speakerById);
  const titleId = `public-timetable-detail-title-${session.id}`;
  const description = normaliseDescription(session.description);

  return (
    <article className="public-timetable-detail">
      <header className="public-timetable-detail-heading">
        <div>
          <h2 id={titleId}>{session.title}</h2>
          {model.showEmbedField("track") || model.showEmbedField("format") ? (
            <SessionTags
              session={session}
              showTrack={model.showEmbedField("track")}
              showFormat={model.showEmbedField("format")}
            />
          ) : null}
        </div>
        <button
          type="button"
          className="btn small"
          ref={closeButtonRef}
          onClick={close}
        >
          Close session details
        </button>
      </header>

      {model.showEmbedField("time") || model.showEmbedField("location") ? (
        <dl className="public-timetable-detail-facts">
          {model.showEmbedField("time") ? (
            <div>
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
            </div>
          ) : null}
          {model.showEmbedField("location") ? (
            <div>
              <dt>Where</dt>
              <dd>
                <SessionPlace session={session} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {model.showEmbedField("description") ? (
        <section aria-labelledby={`${titleId}-about`}>
          <h3 id={`${titleId}-about`}>About this session</h3>
          <p>{description || "Description not provided."}</p>
        </section>
      ) : null}

      <section aria-labelledby={`${titleId}-speakers`}>
        <h3 id={`${titleId}-speakers`}>
          {speakers.length === 1 ? "Speaker" : "Speakers"}
        </h3>
        {model.showSpeakerDetails && speakers.length ? (
          <div className="public-timetable-detail-speakers">
            {speakers.map((speaker) => {
              const affiliation = speakerAffiliation(speaker);
              return (
                <article key={speaker.id}>
                  <div className="public-timetable-detail-speaker-heading">
                    {model.showEmbedField("images") ? (
                      <PublicSpeakerAvatar speaker={speaker} size={40} />
                    ) : null}
                    <div>
                      <strong>{speaker.displayName}</strong>
                      {model.showEmbedField("affiliations") && affiliation ? (
                        <span>{affiliation}</span>
                      ) : null}
                    </div>
                  </div>
                  {model.showEmbedField("biography") && speaker.biography ? (
                    <p>{normaliseDescription(speaker.biography)}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <PublicSessionSpeakerNames session={session} model={model} />
        )}
      </section>

      {model.embedded ? null : (
        <footer className="public-timetable-detail-actions">
          {model.shared ? null : (
            <SaveSessionButton session={session} model={model} />
          )}
          <a
            className="btn small"
            href={publicSessionDetailPath(
              model.programme.event.slug,
              session.id,
            )}
          >
            Open session page
          </a>
        </footer>
      )}
    </article>
  );
}

function PublicTimetableSessionInlineDetail({
  session,
  model,
  close,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  close: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <section
      className="public-timetable-inline-detail"
      id={`public-timetable-inline-detail-${session.id}`}
      aria-labelledby={`public-timetable-detail-title-${session.id}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      <PublicTimetableSessionDetail
        session={session}
        model={model}
        close={close}
        closeButtonRef={closeButtonRef}
      />
    </section>
  );
}

function PublicTimetableSessionDialog({
  session,
  model,
  dialogRef,
  close,
  closed,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  dialogRef: RefObject<HTMLDialogElement | null>;
  close: () => void;
  closed: () => void;
}) {
  const titleId = `public-timetable-detail-title-${session.id}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [dialogRef]);

  return (
    <dialog
      className="public-timetable-detail-dialog"
      aria-labelledby={titleId}
      ref={dialogRef}
      onClose={closed}
    >
      <PublicTimetableSessionDetail
        session={session}
        model={model}
        close={close}
      />
    </dialog>
  );
}

export function PublicTimetableSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);
  const detailDialogRef = useRef<HTMLDialogElement>(null);
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const detailsClosed = () => {
    setDetailSessionId(null);
    const returnFocus = detailReturnFocusRef.current;
    detailReturnFocusRef.current = null;
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      });
    }
  };
  const closeDetails = () => {
    if (model.embedded) {
      detailsClosed();
      return;
    }
    const dialog = detailDialogRef.current;
    if (dialog?.open) dialog.close();
  };
  const openDetails = (
    session: PublishedSession,
    trigger: HTMLButtonElement,
  ) => {
    if (model.embedded && detailSessionId === session.id) {
      detailsClosed();
      return;
    }
    detailReturnFocusRef.current = trigger;
    setDetailSessionId(session.id);
  };
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
  const detailSession =
    detailSessionId === null
      ? null
      : (days
          .flatMap((group) => group.sessions)
          .find((session) => session.id === detailSessionId) ?? null);

  useEffect(() => {
    if (detailSessionId === null || detailSession !== null) return;
    setDetailSessionId(null);
    detailReturnFocusRef.current = null;
  }, [detailSession, detailSessionId]);

  return (
    <section
      className="public-surface"
      aria-labelledby="public-timetable-title"
    >
      <SurfaceHeading
        title="Timetable"
        id="public-timetable-title"
        description="Compare times and rooms at a glance. Open a session to see the details included in this timetable."
        count={`${sessionCount} sessions`}
      />
      {!model.embedded && model.showControl("day") ? (
        <PublicDayTabs model={model} label="Timetable days" />
      ) : null}
      {days.length ? (
        days.map((group) => (
          <PublicTimetableDay
            sessions={group.sessions}
            label={group.label}
            model={model}
            selectedSessionId={detailSession?.id ?? null}
            detailSession={
              detailSession &&
              group.sessions.some((session) => session.id === detailSession.id)
                ? detailSession
                : null
            }
            openSessionDetails={openDetails}
            closeSessionDetails={closeDetails}
            key={group.key}
          />
        ))
      ) : (
        <p className="empty">No published sessions match the current day.</p>
      )}
      {!model.embedded && detailSession ? (
        <PublicTimetableSessionDialog
          session={detailSession}
          model={model}
          dialogRef={detailDialogRef}
          close={closeDetails}
          closed={detailsClosed}
        />
      ) : null}
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
  const showSearch =
    !model.embedded &&
    model.showControl("search") &&
    (!sparse || model.directoryQuery.trim() !== "");
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
          sparse ? undefined : "Meet the people presenting this event."
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
  const showSearch =
    !model.embedded &&
    model.showControl("search") &&
    (!sparse || model.galleryQuery.trim() !== "");
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
          sparse ? undefined : "Published portraits from this event."
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
  if (model.surface === "schedule")
    return <PublicScheduleSurface model={model} />;
  if (model.surface === "timetable")
    return <PublicTimetableSurface model={model} />;
  if (model.surface === "speakers")
    return <PublicSpeakersSurface model={model} />;
  if (model.surface === "gallery")
    return <PublicSpeakerGallerySurface model={model} />;
  return null;
}

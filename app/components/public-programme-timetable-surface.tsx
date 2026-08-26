import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, ButtonAnchor } from "~/components/ui/button";
import {
  formatProgrammeDuration,
  formatProgrammeTimeRange,
  publicSessionDetailPath,
} from "~/modules/programme/programme-presentation";
import type { PublishedSession } from "~/modules/programme/public-programme-service.server";
import {
  formatDay,
  formatTime,
  groupSessionsByDay,
  normaliseDescription,
  type PublicProgrammeModel,
  sessionSpeakerDetails,
  speakerAffiliation,
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
  PublicDayTabs,
  PublicSessionSpeakerNames,
  SurfaceHeading,
} from "./public-programme-surface-shared";

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
        <Button type="button" size="small" ref={closeButtonRef} onClick={close}>
          Close session details
        </Button>
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
          <ButtonAnchor
            size="small"
            href={publicSessionDetailPath(
              model.programme.event.slug,
              session.id,
            )}
          >
            Open session page
          </ButtonAnchor>
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

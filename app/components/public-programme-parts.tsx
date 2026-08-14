import { MapPin, Plus } from "lucide-react";

import {
  formatProgrammeDuration,
  formatProgrammeTimeRange,
} from "~/modules/programme/programme-presentation";
import {
  initials,
  speakerAffiliation,
  type PublicProgrammeModel,
} from "./public-programme-model";
import type {
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";

/**
 * A published list is grouped by day so the calendar date is stated once. The
 * date is the largest organising fact on a programme, so it is set as a chapter
 * break rather than as a caption: at 12px caps it was drawing at the same
 * weight as a track pill. The heading sticks while its own day scrolls, which
 * is what tells a reader on a phone which day the row under their thumb
 * belongs to.
 */
export function ProgrammeDayHeading({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <h2 className="programme-day-divider">
      <span className="programme-day-date">{label}</span>
      <span className="programme-day-count">
        {count} session{count === 1 ? "" : "s"}
      </span>
    </h2>
  );
}

/**
 * Clock range plus length. The calendar date is deliberately absent: it belongs
 * to the day heading above, and repeating it on every row was the single
 * biggest source of wrapped, unreadable text in the previous layout.
 */
export function SessionTime({
  session,
  timezone,
}: {
  session: PublishedSession;
  timezone: string;
}) {
  return (
    <>
      <time
        className="session-time-range"
        dateTime={new Date(session.startsAt * 1_000).toISOString()}
      >
        {formatProgrammeTimeRange(session.startsAt, session.endsAt, timezone)}
      </time>
      <span className="session-time-duration">
        {formatProgrammeDuration(session.startsAt, session.endsAt)}
      </span>
    </>
  );
}

/** Track and format are different facts, so they are given different colours. */
export function SessionTags({ session }: { session: PublishedSession }) {
  return (
    <span className="public-detail-tags">
      {session.track ? (
        <span className="pill track">{session.track}</span>
      ) : null}
      <span className="pill format">{session.format}</span>
    </span>
  );
}

export function SessionPlace({ session }: { session: PublishedSession }) {
  const detail = [session.building, session.level].filter(Boolean).join(" · ");
  return (
    <span className="session-place">
      <MapPin aria-hidden="true" size={13} />
      <strong>{session.room}</strong>
      {detail ? <span>{detail}</span> : null}
    </span>
  );
}

export function SessionSpeakerLines({
  session,
  model,
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
}) {
  if (!session.speakerIds.length) {
    return (
      <span className="programme-row-speakers">
        <span className="speaker subtle">Speaker to be announced</span>
      </span>
    );
  }
  return (
    <span className="programme-row-speakers">
      {session.speakerIds.map((speakerId, index) => {
        const speaker = model.speakerById.get(speakerId)!;
        const affiliation = speakerAffiliation(speaker);
        return (
          <span className="programme-row-speaker" key={speakerId}>
            {speaker.imageUrl ? (
              <img
                className="avatar sm"
                src={speaker.imageUrl}
                alt=""
                width={28}
                height={28}
                loading="lazy"
              />
            ) : (
              <span className="avatar sm" aria-hidden="true">
                {initials(session.speakerNames[index]!)}
              </span>
            )}
            <span className="speaker">{session.speakerNames[index]}</span>
            {affiliation ? (
              <small className="subtle programme-row-affiliation">
                {" "}
                <span aria-hidden="true">— </span>
                {affiliation}
              </small>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A real control, named for the session it acts on. The previous "＋" was a
 * decorative span inside the row button, so it could not be reached, labelled
 * or pressed on its own.
 *
 * The detail variant is the same control at the same weight, only wider and
 * self-labelling: the panel used to answer the row's quiet pill with a
 * saturated primary button, so one action wore two labels and two weights on
 * screen at the same moment.
 */
export function SaveSessionButton({
  session,
  model,
  variant = "row",
}: {
  session: PublishedSession;
  model: PublicProgrammeModel;
  variant?: "row" | "detail";
}) {
  const saved = model.saved.includes(session.id);
  const verificationRequired = model.requiresItineraryVerification(session.id);
  const pending = model.fetcher.state !== "idle";
  const detail = variant === "detail";
  return (
    <button
      type="button"
      className={`session-save${saved ? " saved" : ""}${detail ? " wide" : ""}`}
      aria-pressed={saved}
      aria-label={
        detail
          ? undefined
          : saved
            ? `Remove ${session.title} from my itinerary`
            : `Save ${session.title} to my itinerary`
      }
      aria-describedby={
        verificationRequired ? "itinerary-verification-help" : undefined
      }
      title={
        verificationRequired
          ? "Security verification is required before the first save"
          : undefined
      }
      disabled={pending}
      onClick={() => model.toggle(session.id)}
    >
      {detail ? (
        <span>
          {pending
            ? "Updating itinerary…"
            : saved
              ? "Remove from itinerary"
              : "Add to itinerary"}
        </span>
      ) : saved ? (
        /* One checkmark. The lucide glyph beside the literal "✓" shipped the
           same mark twice. */
        <span>Saved ✓</span>
      ) : (
        <>
          <Plus aria-hidden="true" size={15} />
          <span>Save</span>
        </>
      )}
    </button>
  );
}

export function PublicSpeakerAvatar({
  speaker,
  size,
}: {
  speaker: PublishedSpeaker;
  size: number;
}) {
  if (speaker.imageUrl) {
    return (
      <img
        className="public-speaker-avatar"
        src={speaker.imageUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="public-speaker-avatar placeholder"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {initials(speaker.displayName)}
    </span>
  );
}

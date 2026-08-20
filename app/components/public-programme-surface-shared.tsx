import { type ReactNode, useRef } from "react";
import type {
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import {
  descriptionSnippet,
  initials,
  normaliseDescription,
  type PublicProgrammeModel,
  sessionSpeakerDetails,
  speakerAffiliation,
} from "./public-programme-model";
import { PublicSpeakerAvatar } from "./public-programme-parts";

export function PublicDayTabs({
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

export function PublicSpeakerMetadata({
  speaker,
}: {
  speaker: PublishedSpeaker;
}) {
  const affiliation = speakerAffiliation(speaker);
  if (!affiliation) return null;
  return <span className="public-speaker-metadata">{affiliation}</span>;
}

export function PublicSpeakerPhoto({
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

export function PublicSessionSpeakerNames({
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

export function PublicSessionSpeakers({
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

export function SessionCardDescription({
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

export const SPARSE_SPEAKER_SEARCH = 6;

/**
 * A published surface is named like a section in an event site, not like an
 * admin index. Search and a count badge earn their place only when the
 * fixture is long enough that a visitor would look for them.
 */
export function SurfaceHeading({
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

export function SpeakerSearchField({
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

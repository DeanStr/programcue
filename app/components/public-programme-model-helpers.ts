import type { parseProgrammeEmbedSearchParameters } from "~/modules/programme/programme-embed-configuration";
import type { PublicProgrammeSurface } from "~/modules/programme/programme-presentation";
import type {
  PublishedProgramme,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import type { PublishedPublicSite } from "~/modules/public-site/public-site-service.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";

export type PublicProgrammeLoaderData = {
  programme: PublishedProgramme;
  surface: PublicProgrammeSurface;
  itinerary: string[];
  embedded: boolean;
  embedOptions: ReturnType<typeof parseProgrammeEmbedSearchParameters>;
  signedIn: boolean;
  itineraryVerificationRequired: boolean;
  turnstileSiteKey: string | null;
  itinerarySynced: boolean;
  shared: boolean;
  calendarExportQuery: string;
  canonicalUrl: string;
  speakerShare: {
    speakerId: string;
    speakerName: string;
    sessionTitle: string | null;
    description: string;
    url: string;
    text: string;
    imageUrl: string | null;
  } | null;
  sessionShare: {
    sessionId: string;
    sessionTitle: string;
    description: string;
    url: string;
  } | null;
  sessionFocusId: string | null;
  site?: PublishedPublicSite | null;
};

export function formatDay(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function formatTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

const DESCRIPTION_SNIPPET_LENGTH = 180;

export function descriptionSnippet(description: string) {
  const collapsed = normaliseDescription(description);
  if (collapsed.length <= DESCRIPTION_SNIPPET_LENGTH) return collapsed;
  const cut = collapsed.slice(0, DESCRIPTION_SNIPPET_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > DESCRIPTION_SNIPPET_LENGTH / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function normaliseDescription(description: string) {
  return description.replace(/\s+/gu, " ").trim();
}

/**
 * A managed published banner takes precedence over the retired external hero
 * URL. Any persisted non-null value that violates its contract is corrupt
 * configuration and must not be silently hidden.
 */
export function eventHeroImagePath(event: PublishedProgramme["event"]) {
  if (event.bannerUrl !== null) {
    if (!/^\/public\/brand\/[a-z0-9-]+\/banner$/u.test(event.bannerUrl))
      throw new Error("Published programme banner URL is invalid.");
    return event.bannerUrl;
  }
  const value = event.heroImageUrl;
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || value.length > 2_048) throw new Error();
    return url.href;
  } catch {
    throw new Error("Published programme hero image URL is invalid.");
  }
}

function firstGrapheme(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segment = new Intl.Segmenter("en", {
      granularity: "grapheme",
    }).segment(value);
    return [...segment][0]?.segment ?? "";
  }
  return [...value][0] ?? "";
}

function isEmojiGrapheme(value: string) {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

export function initials(name: string) {
  const letters = name
    .split(/\s+/u)
    .map((part) => firstGrapheme(part))
    .filter((part) => part && !isEmojiGrapheme(part));
  const fallback = firstGrapheme(name.trim());
  return (
    letters.slice(0, 2).join("") ||
    (fallback && !isEmojiGrapheme(fallback) ? fallback : "") ||
    "PC"
  );
}

/**
 * Consecutive sessions that share a calendar day become one group. The service
 * already orders by `starts_at`, so a running comparison preserves programme
 * order without re-sorting, and every list that renders sessions can show the
 * date once as a heading instead of repeating it on every row.
 */
export function groupSessionsByDay<T extends { startsAt: number }>(
  sessions: readonly T[],
  timezone: string,
) {
  const groups: Array<{ key: string; label: string; sessions: T[] }> = [];
  for (const session of sessions) {
    const key = eventLocalCalendarDate(session.startsAt, timezone);
    const current = groups.at(-1);
    if (current && current.key === key) current.sessions.push(session);
    else
      groups.push({
        key,
        label: formatDay(session.startsAt, timezone),
        sessions: [session],
      });
  }
  return groups;
}

export function distinctSorted(values: Array<string | null>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ].sort((left, right) => left.localeCompare(right));
}

export function speakerAffiliation(
  speaker: Pick<PublishedSpeaker, "jobTitle" | "organisationName">,
) {
  return [speaker.jobTitle?.trim(), speaker.organisationName?.trim()]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function sessionSpeakerDetails(
  session: PublishedProgramme["sessions"][number],
  speakerById: ReadonlyMap<string, PublishedSpeaker>,
) {
  return session.speakerIds.map((speakerId, index) => {
    const speaker = speakerById.get(speakerId);
    if (!speaker) {
      throw new Error(
        `Published session ${session.id} has no speaker ${speakerId}.`,
      );
    }
    const displayName = session.speakerNames[index];
    if (displayName !== speaker.displayName) {
      throw new Error(
        `Published session ${session.id} has a missing or stale name for speaker ${speakerId}.`,
      );
    }
    return {
      ...speaker,
      id: speakerId,
      displayName,
    };
  });
}

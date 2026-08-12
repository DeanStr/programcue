type ProgrammeRecord = {
  startsAt: number | null;
  visibility: string;
};

export const PUBLIC_PROGRAMME_SURFACES = [
  "overview",
  "sessions",
  "speakers",
  "agenda",
  "schedule",
  "gallery",
] as const;

export type PublicProgrammeSurface = (typeof PUBLIC_PROGRAMME_SURFACES)[number];

export function publicProgrammeSurfacePath(
  eventSlug: string,
  surface: Exclude<PublicProgrammeSurface, "overview">,
) {
  return `/public/programme/${encodeURIComponent(eventSlug)}/${surface}`;
}

const SPEAKER_HONORIFICS = new Set([
  "dr",
  "dr.",
  "mr",
  "mr.",
  "mrs",
  "mrs.",
  "ms",
  "ms.",
  "mx",
  "mx.",
  "prof",
  "prof.",
]);

const SPEAKER_SUFFIXES = new Set([
  "ii",
  "iii",
  "iv",
  "jr",
  "jr.",
  "phd",
  "ph.d.",
  "sr",
  "sr.",
]);

function sortableSpeakerParts(displayName: string) {
  const parts = displayName
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/^[,]+|[,]+$/gu, ""))
    .filter(Boolean);
  while (
    parts.length > 1 &&
    SPEAKER_SUFFIXES.has(parts.at(-1)!.toLocaleLowerCase("en"))
  ) {
    parts.pop();
  }
  while (
    parts.length > 1 &&
    SPEAKER_HONORIFICS.has(parts[0]!.toLocaleLowerCase("en"))
  ) {
    parts.shift();
  }
  return parts;
}

export function speakerSurname(displayName: string) {
  const normalised = displayName.normalize("NFKC").trim();
  const comma = normalised.indexOf(",");
  const surnameSource = comma > 0 ? normalised.slice(0, comma) : normalised;
  return sortableSpeakerParts(surnameSource).at(-1) ?? "";
}

export function comparePublishedSpeakers(
  left: { displayName: string; id: string },
  right: { displayName: string; id: string },
) {
  return (
    speakerSurname(left.displayName).localeCompare(
      speakerSurname(right.displayName),
      "en",
      { sensitivity: "base" },
    ) ||
    left.displayName.localeCompare(right.displayName, "en", {
      sensitivity: "base",
    }) ||
    left.id.localeCompare(right.id)
  );
}

export function sortPublishedSpeakers<
  T extends { displayName: string; id: string },
>(speakers: readonly T[]) {
  return [...speakers].sort(comparePublishedSpeakers);
}

export function summarizeProgramme(records: ReadonlyArray<ProgrammeRecord>) {
  const scheduled = records.filter((record) => record.startsAt !== null).length;
  return {
    total: records.length,
    scheduled,
    unscheduled: records.length - scheduled,
    publishedPublic: records.filter(
      (record) => record.startsAt !== null && record.visibility === "public",
    ).length,
  };
}

export function formatProgrammeDateTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function formatProgrammeDateTimeRange(
  startsAt: number,
  endsAt: number,
  timezone: string,
) {
  const date = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const zone = new Intl.DateTimeFormat("en", {
    timeZoneName: "short",
    timeZone: timezone,
  });
  const start = new Date(startsAt * 1_000);
  const end = new Date(endsAt * 1_000);
  const startDate = date.format(start);
  const endDate = date.format(end);
  const startTime = time.format(start);
  const endTime = time.format(end);
  const zoneName = (instant: Date) =>
    zone.formatToParts(instant).find((part) => part.type === "timeZoneName")
      ?.value;
  const startZone = zoneName(start);
  const endZone = zoneName(end);
  if (startDate === endDate) {
    const timeZoneName =
      startZone === endZone
        ? startZone
        : [startZone, endZone].filter(Boolean).join("–");
    return `${startDate} · ${startTime}–${endTime}${timeZoneName ? ` ${timeZoneName}` : ""}`;
  }
  return `${startDate} · ${startTime}${startZone ? ` ${startZone}` : ""}–${endDate} · ${endTime}${endZone ? ` ${endZone}` : ""}`;
}

export function formatProgrammeEventDay(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Programme event date must use YYYY-MM-DD format.");
  const instant = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  )
    throw new Error("Programme event date is invalid.");
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(instant);
}

export function publicProgrammeSessionUrl(
  baseUrl: string,
  eventSlug: string,
  sessionSlug: string,
) {
  const url = new URL(
    `/public/programme/${encodeURIComponent(eventSlug)}`,
    baseUrl,
  );
  url.hash = `session-${sessionSlug}`;
  return url.toString();
}

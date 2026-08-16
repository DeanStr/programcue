import { requireValue } from "~/lib/required-value";

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

type RgbColour = readonly [red: number, green: number, blue: number];

const PROGRAMME_SURFACE_INK: RgbColour = [15, 23, 42];
const PROGRAMME_SURFACE_WHITE: RgbColour = [255, 255, 255];

function parseHexColour(value: string): RgbColour {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error("Programme accent must be a six-digit hexadecimal colour.");
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function formatHexColour(colour: RgbColour) {
  return `#${colour
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixColour(
  foreground: RgbColour,
  background: RgbColour,
  foregroundWeight: number,
): RgbColour {
  return [
    foreground[0] * foregroundWeight + background[0] * (1 - foregroundWeight),
    foreground[1] * foregroundWeight + background[1] * (1 - foregroundWeight),
    foreground[2] * foregroundWeight + background[2] * (1 - foregroundWeight),
  ];
}

function relativeLuminance(colour: RgbColour) {
  const [red, green, blue] = colour.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    requireValue(red, "Required red is unavailable.") * 0.2126 +
    requireValue(green, "Required green is unavailable.") * 0.7152 +
    requireValue(blue, "Required blue is unavailable.") * 0.0722
  );
}

function contrastRatio(left: RgbColour, right: RgbColour) {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Event branding accepts any six-digit colour, including colours that cannot
 * carry readable text. Keep the customer's exact accent for decoration, but
 * derive separate text colours for pale surfaces and solid accent controls.
 */
export function programmeAccentPalette(value: string) {
  const accent = parseHexColour(value);
  const softSurface = mixColour(accent, PROGRAMME_SURFACE_WHITE, 0.08);
  let ink = accent;
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mixColour(
      accent,
      PROGRAMME_SURFACE_INK,
      (100 - step) / 100,
    );
    if (
      contrastRatio(candidate, PROGRAMME_SURFACE_WHITE) >= 4.75 &&
      contrastRatio(candidate, softSurface) >= 4.75
    ) {
      ink = candidate;
      break;
    }
  }
  return {
    accent: formatHexColour(accent),
    ink: formatHexColour(ink),
    onAccent: formatHexColour(PROGRAMME_SURFACE_WHITE),
  };
}

export function publicProgrammeSurfacePath(
  eventSlug: string,
  surface: Exclude<PublicProgrammeSurface, "overview">,
) {
  return `/public/programme/${encodeURIComponent(eventSlug)}/${surface}`;
}

export function publicSpeakerProfilePath(eventSlug: string, speakerId: string) {
  return `/public/programme/${encodeURIComponent(eventSlug)}?${new URLSearchParams(
    {
      speaker: speakerId,
    },
  )}`;
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
    SPEAKER_SUFFIXES.has(
      requireValue(
        parts.at(-1),
        "Required parts.at(-1) is unavailable.",
      ).toLocaleLowerCase("en"),
    )
  ) {
    parts.pop();
  }
  while (
    parts.length > 1 &&
    SPEAKER_HONORIFICS.has(
      requireValue(
        parts[0],
        "Required parts[0] is unavailable.",
      ).toLocaleLowerCase("en"),
    )
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

/**
 * Attendee-facing time. The full `formatProgrammeDateTimeRange` string repeats
 * the calendar date on every row of a list that is already grouped by day, so
 * the public surfaces show only the clock range and let a day heading carry the
 * date. A shared meridiem is written once: "9:00–9:45 AM", not
 * "9:00 AM–9:45 AM". Sessions that cross local midnight include the end date,
 * because the surrounding day heading only supplies the start date.
 */
export function formatProgrammeTimeRange(
  startsAt: number,
  endsAt: number,
  timezone: string,
) {
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const date = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });
  const zone = new Intl.DateTimeFormat("en", {
    timeZoneName: "short",
    timeZone: timezone,
  });
  const startInstant = new Date(startsAt * 1_000);
  const endInstant = new Date(endsAt * 1_000);
  const start = time.format(startInstant);
  const end = time.format(endInstant);
  const startDate = date.format(startInstant);
  const endDate = date.format(endInstant);
  const zoneName = (instant: Date) =>
    zone.formatToParts(instant).find((part) => part.type === "timeZoneName")
      ?.value;
  const startZone = zoneName(startInstant);
  const endZone = zoneName(endInstant);
  if (startDate !== endDate) {
    return `${start}${startZone !== endZone && startZone ? ` ${startZone}` : ""}–${endDate} · ${end}${startZone !== endZone && endZone ? ` ${endZone}` : ""}`;
  }
  if (startZone !== endZone) {
    return `${start}${startZone ? ` ${startZone}` : ""}–${end}${endZone ? ` ${endZone}` : ""}`;
  }
  const meridiem = /\s*(AM|PM)$/u;
  const startMeridiem = start.match(meridiem)?.[1];
  const endMeridiem = end.match(meridiem)?.[1];
  if (startMeridiem && startMeridiem === endMeridiem) {
    return `${start.replace(meridiem, "")}–${end}`;
  }
  return `${start}–${end}`;
}

export function formatProgrammeDuration(startsAt: number, endsAt: number) {
  const minutes = Math.max(0, Math.round((endsAt - startsAt) / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
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

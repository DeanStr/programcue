type ProgrammeRecord = {
  startsAt: number | null;
  visibility: string;
};

export function summarizeProgramme(records: ReadonlyArray<ProgrammeRecord>) {
  const scheduled = records.filter((record) => record.startsAt !== null).length;
  return {
    total: records.length,
    scheduled,
    unscheduled: records.length - scheduled,
    publishedPublic: records.filter((record) => record.startsAt !== null && record.visibility === "public").length,
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

export function formatProgrammeEventDay(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Programme event date must use YYYY-MM-DD format.");
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date)
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
  const url = new URL(`/public/programme/${encodeURIComponent(eventSlug)}`, baseUrl);
  url.hash = `session-${sessionSlug}`;
  return url.toString();
}

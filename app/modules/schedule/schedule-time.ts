const MAX_CACHED_FORMATTERS = 32;
const MAX_CACHED_EXCLUSIVE_ENDS = 512;
const datePartFormatters = new Map<string, Intl.DateTimeFormat>();
const exclusiveEndCache = new Map<string, number>();

function recalled<K, V>(cache: Map<K, V>, key: K) {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function datePartsFormatter(timezone: string) {
  const existing = recalled(datePartFormatters, timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  remember(datePartFormatters, timezone, formatter, MAX_CACHED_FORMATTERS);
  return formatter;
}

function localParts(epochMilliseconds: number, timezone: string) {
  const values = Object.fromEntries(
    datePartsFormatter(timezone)
      .formatToParts(new Date(epochMilliseconds))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

export function eventBoundaryCalendarDate(boundaryEpoch: number) {
  if (!Number.isInteger(boundaryEpoch))
    throw new Error("Event date boundary must be an integer epoch.");
  const date = new Date(boundaryEpoch * 1_000);
  if (Number.isNaN(date.getTime()))
    throw new Error("Event date boundary is invalid.");
  return date.toISOString().slice(0, 10);
}

export function eventLocalCalendarDate(epoch: number, timezone: string) {
  if (!Number.isInteger(epoch))
    throw new Error("Schedule time must be an integer epoch.");
  const parts = localParts(epoch * 1_000, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function eventCalendarDayBoundaries(
  startBoundaryEpoch: number,
  endBoundaryEpoch: number,
) {
  const startDate = eventBoundaryCalendarDate(startBoundaryEpoch);
  const endDate = eventBoundaryCalendarDate(endBoundaryEpoch);
  if (endDate < startDate)
    throw new Error("The event end date must not precede its start date.");

  const days: number[] = [];
  let current = Date.parse(`${startDate}T00:00:00Z`) / 1_000;
  const end = Date.parse(`${endDate}T00:00:00Z`) / 1_000;
  while (current <= end) {
    days.push(current);
    current += 24 * 60 * 60;
  }
  return days;
}

export function eventCalendarDateEpoch(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("Event-local dates must use YYYY-MM-DD.");
  }
  const epoch = Date.parse(`${date}T00:00:00Z`) / 1_000;
  if (!Number.isInteger(epoch) || eventBoundaryCalendarDate(epoch) !== date) {
    throw new Error(`The event-local date ${date} is invalid.`);
  }
  return epoch;
}

export function eventLocalRange(
  eventStartsAt: number,
  eventEndsAt: number,
  timezone: string,
) {
  const eventStartDate = eventBoundaryCalendarDate(eventStartsAt);
  const previousStartMarker =
    Date.parse(`${eventStartDate}T00:00:00Z`) / 1_000 - 24 * 60 * 60;
  return {
    startsAt: eventLocalExclusiveEndEpoch(previousStartMarker, timezone),
    endsAtExclusive: eventLocalExclusiveEndEpoch(eventEndsAt, timezone),
  };
}

function assertEventLocalClock(hour: number, minute: number) {
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Event-local time must contain a valid hour and minute.");
  }
}

export function eventLocalTimeEpoch(
  boundaryEpoch: number,
  timezone: string,
  hour: number,
  minute = 0,
) {
  assertEventLocalClock(hour, minute);
  const [year, month, day] = eventBoundaryCalendarDate(boundaryEpoch)
    .split("-")
    .map(Number);
  const requestedWallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = requestedWallClock;

  // Intl exposes the offset that applies at the candidate instant. Re-applying the
  // wall-clock difference handles both positive/negative offsets and DST changes.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(candidate, timezone);
    const renderedWallClock = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const adjustment = requestedWallClock - renderedWallClock;
    if (adjustment === 0) return Math.floor(candidate / 1_000);
    candidate += adjustment;
  }

  throw new Error(
    `The event-local time ${eventBoundaryCalendarDate(boundaryEpoch)} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} does not exist in ${timezone}.`,
  );
}

export function eventLocalEndOfDayEpoch(
  boundaryEpoch: number,
  timezone: string,
) {
  return eventLocalExclusiveEndEpoch(boundaryEpoch, timezone) - 1;
}

export function eventLocalStartOfDayEpoch(
  boundaryEpoch: number,
  timezone: string,
) {
  const eventDate = eventBoundaryCalendarDate(boundaryEpoch);
  const previousDayMarker =
    Date.parse(`${eventDate}T00:00:00Z`) / 1_000 - 24 * 60 * 60;
  const start = eventLocalExclusiveEndEpoch(previousDayMarker, timezone);
  if (eventLocalCalendarDate(start, timezone) !== eventDate) {
    throw new Error(
      `The start of event date ${eventDate} cannot be resolved in ${timezone}.`,
    );
  }
  return start;
}

export function eventLocalExclusiveEndEpoch(
  boundaryEpoch: number,
  timezone: string,
) {
  const eventDate = eventBoundaryCalendarDate(boundaryEpoch);
  const cacheKey = `${timezone}\0${eventDate}`;
  const cached = recalled(exclusiveEndCache, cacheKey);
  if (cached !== undefined) return cached;
  const nominalNextDay =
    Date.parse(`${eventDate}T00:00:00Z`) / 1_000 + 24 * 60 * 60;
  let before = nominalNextDay - 36 * 60 * 60;
  let after = nominalNextDay + 36 * 60 * 60;

  if (
    eventLocalCalendarDate(before, timezone) > eventDate ||
    eventLocalCalendarDate(after, timezone) <= eventDate
  ) {
    throw new Error(
      `The end of event date ${eventDate} cannot be resolved in ${timezone}.`,
    );
  }

  // Find the first real instant after the event's final local calendar date.
  // Some IANA zones advance at 00:00, so requiring that wall-clock time to
  // exist would reject an otherwise valid event date.
  while (after - before > 1) {
    const candidate = Math.floor((before + after) / 2);
    if (eventLocalCalendarDate(candidate, timezone) > eventDate) {
      after = candidate;
    } else {
      before = candidate;
    }
  }
  remember(exclusiveEndCache, cacheKey, after, MAX_CACHED_EXCLUSIVE_ENDS);
  return after;
}

export function eventDayHourlySlots(
  boundaryEpoch: number,
  timezone: string,
  startHour = 9,
  count = 9,
) {
  if (!Number.isInteger(count) || count < 1 || startHour + count > 24) {
    throw new Error("Schedule slots must fit within one event calendar day.");
  }
  return Array.from({ length: count }, (_, index) =>
    eventLocalTimeEpoch(boundaryEpoch, timezone, startHour + index),
  );
}

export function eventDayScheduleSlots(
  boundaryEpoch: number,
  timezone: string,
  existingStarts: ReadonlyArray<number> = [],
) {
  const day = eventBoundaryCalendarDate(boundaryEpoch);
  const previousDayMarker =
    Date.parse(`${day}T00:00:00Z`) / 1_000 - 24 * 60 * 60;
  const start = eventLocalExclusiveEndEpoch(previousDayMarker, timezone);
  const end = eventLocalExclusiveEndEpoch(boundaryEpoch, timezone);
  const slots = new Set<number>();
  for (let epoch = start; epoch < end; epoch += 30 * 60) slots.add(epoch);
  for (const epoch of existingStarts) {
    if (!Number.isInteger(epoch))
      throw new Error("Existing schedule starts must be integer epochs.");
    if (eventLocalCalendarDate(epoch, timezone) === day) slots.add(epoch);
  }
  return [...slots].sort((left, right) => left - right);
}

export function participantEventLocalTimeEpoch(
  boundaryEpoch: number,
  timezone: string,
  hour: number,
  minute = 0,
) {
  assertEventLocalClock(hour, minute);
  const [year, month, day] = eventBoundaryCalendarDate(boundaryEpoch)
    .split("-")
    .map(Number);
  const requestedWallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  const matches = new Set<number>();
  for (
    let offsetMinutes = -14 * 60;
    offsetMinutes <= 14 * 60;
    offsetMinutes += 15
  ) {
    const candidate = requestedWallClock - offsetMinutes * 60_000;
    const parts = localParts(candidate, timezone);
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === 0
    ) {
      matches.add(Math.floor(candidate / 1_000));
    }
  }
  const localLabel = `${eventBoundaryCalendarDate(boundaryEpoch)} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (matches.size === 0) {
    throw new Error(
      `The event-local time ${localLabel} does not exist in ${timezone}.`,
    );
  }
  if (matches.size > 1) {
    throw new Error(
      `The event-local time ${localLabel} is ambiguous in ${timezone}.`,
    );
  }
  const [epoch] = matches;
  if (epoch === undefined) {
    throw new Error(
      `The event-local time ${localLabel} could not be resolved in ${timezone}.`,
    );
  }
  return epoch;
}

export function participantAllDayRange(
  startDate: string,
  endDate: string,
  timezone: string,
) {
  const startBoundary = eventCalendarDateEpoch(startDate);
  const endBoundary = eventCalendarDateEpoch(endDate);
  if (endDate < startDate) {
    throw new Error("The unavailable period must end after it starts.");
  }
  const previousStartMarker = startBoundary - 24 * 60 * 60;
  const startsAt = eventLocalExclusiveEndEpoch(previousStartMarker, timezone);
  const endsAt = eventLocalExclusiveEndEpoch(endBoundary, timezone);
  if (endsAt <= startsAt) {
    throw new Error("The unavailable period must end after it starts.");
  }
  return { startsAt, endsAt };
}

function formatEventLocalDate(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(epoch * 1_000));
}

export function isParticipantAllDayRange(
  startsAt: number,
  endsAt: number,
  timezone: string,
) {
  if (
    !Number.isInteger(startsAt) ||
    !Number.isInteger(endsAt) ||
    endsAt <= startsAt
  ) {
    return false;
  }
  try {
    const range = participantAllDayRange(
      eventLocalCalendarDate(startsAt, timezone),
      eventLocalCalendarDate(endsAt - 1, timezone),
      timezone,
    );
    return range.startsAt === startsAt && range.endsAt === endsAt;
  } catch {
    return false;
  }
}

export function formatEventLocalAvailabilityWindow(
  startsAt: number,
  endsAt: number,
  timezone: string,
) {
  if (isParticipantAllDayRange(startsAt, endsAt, timezone)) {
    const startLabel = formatEventLocalDate(startsAt, timezone);
    const endLabel = formatEventLocalDate(endsAt - 1, timezone);
    return startLabel === endLabel
      ? `All day · ${startLabel}`
      : `All day · ${startLabel}–${endLabel}`;
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${formatter.format(new Date(startsAt * 1_000))}–${formatter.format(new Date(endsAt * 1_000))}`;
}

export function formatEventLocalInterval(
  startsAt: number,
  endsAt: number,
  timezone: string,
) {
  return `${formatEventLocalAvailabilityWindow(startsAt, endsAt, timezone)} ${timezone}`;
}

export const SCHEDULE_DAY_START_HOUR = 7;
export const SCHEDULE_DAY_END_HOUR = 22;

export function eventDayUsableScheduleSlots(
  boundaryEpoch: number,
  timezone: string,
  existingStarts: ReadonlyArray<number> = [],
) {
  const start = eventLocalTimeEpoch(
    boundaryEpoch,
    timezone,
    SCHEDULE_DAY_START_HOUR,
  );
  const end = eventLocalTimeEpoch(
    boundaryEpoch,
    timezone,
    SCHEDULE_DAY_END_HOUR,
  );
  return eventDayScheduleSlots(boundaryEpoch, timezone, existingStarts).filter(
    (slot) => slot >= start && slot < end,
  );
}

const datePartsFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
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

export function eventLocalTimeEpoch(
  boundaryEpoch: number,
  timezone: string,
  hour: number,
  minute = 0,
) {
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
  return eventLocalTimeEpoch(boundaryEpoch + 24 * 60 * 60, timezone, 0) - 1;
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
  const nextBoundary = boundaryEpoch + 24 * 60 * 60;
  const start = eventLocalTimeEpoch(boundaryEpoch, timezone, 0);
  const end = eventLocalTimeEpoch(nextBoundary, timezone, 0);
  const slots = new Set<number>();
  for (let epoch = start; epoch < end; epoch += 30 * 60) slots.add(epoch);
  for (const epoch of existingStarts) {
    if (!Number.isInteger(epoch))
      throw new Error("Existing schedule starts must be integer epochs.");
    if (eventLocalCalendarDate(epoch, timezone) === day) slots.add(epoch);
  }
  return [...slots].sort((left, right) => left - right);
}

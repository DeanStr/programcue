import { useEffect, useId, useRef, useState } from "react";

function calendarDay(value: string, label: string) {
  const epoch = Date.parse(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be a valid ISO calendar date.`);
  }
  return epoch / 86_400_000;
}

function calendarDate(day: number) {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function initialDuration(startDate: string, endDate: string) {
  const duration =
    calendarDay(endDate, "Initial event end date") -
    calendarDay(startDate, "Initial event start date");
  if (duration < 0) {
    throw new Error(
      "Initial event end date cannot be before the initial start date.",
    );
  }
  return duration;
}

export function EventDateRangeFields({
  initialStartDate,
  initialEndDate,
  error,
  resetKey,
  idPrefix = "event",
}: {
  initialStartDate: string;
  initialEndDate: string;
  error?: string;
  resetKey?: string;
  idPrefix?: string;
}) {
  const generatedId = useId();
  const resolvedPrefix = idPrefix === "event" ? `event-${generatedId}` : idPrefix;
  const startId = `${resolvedPrefix}-startDate`;
  const endId = `${resolvedPrefix}-endDate`;
  const initialRangeDuration = initialDuration(initialStartDate, initialEndDate);
  const duration = useRef(initialRangeDuration);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const rangeError =
    startDate &&
    endDate &&
    calendarDay(endDate, "Event end date") <
      calendarDay(startDate, "Event start date")
      ? "End date cannot be before the start date."
      : undefined;
  const visibleError = error ?? rangeError;
  const errorId = visibleError ? `${endId}-error` : undefined;

  useEffect(() => {
    setStartDate(initialStartDate);
    setEndDate(initialEndDate);
    duration.current = initialDuration(initialStartDate, initialEndDate);
  }, [initialEndDate, initialStartDate, resetKey]);

  return (
    <div className="grid grid-2">
      <label className="label" htmlFor={startId}>
        Start date
        <input
          className="field"
          id={startId}
          type="date"
          name="startDate"
          value={startDate}
          required
          onChange={(event) => {
            const nextStart = event.currentTarget.value;
            setStartDate(nextStart);
            if (!nextStart) return;
            setEndDate(
              calendarDate(
                calendarDay(nextStart, "Event start date") + duration.current,
              ),
            );
          }}
        />
      </label>
      <label className="label" htmlFor={endId}>
        End date
        <input
          className="field"
          id={endId}
          type="date"
          name="endDate"
          value={endDate}
          min={startDate}
          required
          aria-invalid={visibleError ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => {
            const nextEnd = event.currentTarget.value;
            setEndDate(nextEnd);
            if (nextEnd && startDate) {
              duration.current = Math.max(
                0,
                calendarDay(nextEnd, "Event end date") -
                  calendarDay(startDate, "Event start date"),
              );
            }
          }}
        />
        {visibleError ? (
          <span className="pc-field-error" id={errorId} role="alert">
            {visibleError}
          </span>
        ) : null}
      </label>
    </div>
  );
}

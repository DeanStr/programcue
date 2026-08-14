import type { ReactNode } from "react";

const DEFAULT_EXACT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "long",
  timeStyle: "long",
};

function assertEpochSeconds(epochSeconds: number) {
  if (!Number.isFinite(epochSeconds)) {
    throw new Error("An event timestamp must be a finite number of seconds.");
  }
}

export function formatEventDateTime(
  epochSeconds: number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = DEFAULT_EXACT_OPTIONS,
) {
  assertEpochSeconds(epochSeconds);
  if (!timeZone.trim()) {
    throw new Error(
      "An IANA event timezone is required to format a timestamp.",
    );
  }
  return new Intl.DateTimeFormat("en", {
    ...options,
    timeZone,
  }).format(new Date(epochSeconds * 1_000));
}

export type EventDateTimeProps = {
  epochSeconds: number;
  timeZone: string;
  children?: ReactNode;
  className?: string;
  exactOptions?: Intl.DateTimeFormatOptions;
  showTimeZone?: boolean;
  focusable?: boolean;
};

/**
 * A compact timestamp whose hover/focus disclosure always exposes the exact
 * event-local instant and IANA timezone. The accessible name carries the same
 * information without relying on the visual tooltip.
 */
export function EventDateTime({
  epochSeconds,
  timeZone,
  children,
  className,
  exactOptions,
  showTimeZone = false,
  focusable = true,
}: EventDateTimeProps) {
  const exact = formatEventDateTime(
    epochSeconds,
    timeZone,
    exactOptions ?? DEFAULT_EXACT_OPTIONS,
  );
  const disclosure = `${exact} (${timeZone})`;

  return (
    <time
      className={["pc-event-time", className].filter(Boolean).join(" ")}
      dateTime={new Date(epochSeconds * 1_000).toISOString()}
      data-exact-time={disclosure}
      aria-label={disclosure}
      tabIndex={focusable ? 0 : undefined}
    >
      {children ?? exact}
      {showTimeZone ? (
        <small className="pc-event-time-zone"> {timeZone}</small>
      ) : null}
    </time>
  );
}

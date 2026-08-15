import {
  hasCrossCollidingSessionFormatReference,
  normalizeSessionFormatReference,
  sessionFormatInputSchema,
} from "./event-schema";

export const INITIAL_EVENT_SESSION_FORMATS = [
  {
    key: "keynote",
    label: "Keynote",
    defaultDurationMinutes: 60,
    position: 0,
  },
  {
    key: "presentation",
    label: "Presentation",
    defaultDurationMinutes: 45,
    position: 1,
  },
  {
    key: "panel",
    label: "Panel",
    defaultDurationMinutes: 60,
    position: 2,
  },
  {
    key: "workshop",
    label: "Workshop",
    defaultDurationMinutes: 90,
    position: 3,
  },
  {
    key: "breakout",
    label: "Breakout",
    defaultDurationMinutes: 45,
    position: 4,
  },
  {
    key: "break",
    label: "Break",
    defaultDurationMinutes: 30,
    position: 5,
  },
  {
    key: "other",
    label: "Other",
    defaultDurationMinutes: 30,
    position: 6,
  },
] as const;

export const INITIAL_EVENT_SESSION_FORMATS_JSON = JSON.stringify(
  INITIAL_EVENT_SESSION_FORMATS,
);

export class EventConfigurationDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConfigurationDataError";
  }
}

export function parseSessionFormatsConfiguration(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new EventConfigurationDataError(
      "The event has unreadable session-format configuration.",
    );
  }
  const parsed = sessionFormatInputSchema
    .array()
    .min(1)
    .max(50)
    .safeParse(decoded);
  if (
    !parsed.success ||
    new Set(parsed.data.map((format) => format.key)).size !==
      parsed.data.length ||
    new Set(parsed.data.map((format) => format.label.toLowerCase())).size !==
      parsed.data.length ||
    hasCrossCollidingSessionFormatReference(parsed.data)
  ) {
    throw new EventConfigurationDataError(
      "The event has invalid or duplicate session-format configuration.",
    );
  }
  return [...parsed.data].sort(
    (left, right) =>
      left.position - right.position || left.key.localeCompare(right.key),
  );
}

export type SessionFormatConfiguration = ReturnType<
  typeof parseSessionFormatsConfiguration
>[number];

export function findSessionFormatConfiguration(
  formats: ReadonlyArray<SessionFormatConfiguration>,
  reference: string,
) {
  const label = reference.trim().toLowerCase();
  const key = normalizeSessionFormatReference(reference);
  const matches = formats.filter(
    (format) =>
      format.key === key || format.label.trim().toLowerCase() === label,
  );
  if (matches.length > 1) {
    throw new EventConfigurationDataError(
      `Session format “${reference}” is ambiguous in the event configuration.`,
    );
  }
  return matches[0] ?? null;
}

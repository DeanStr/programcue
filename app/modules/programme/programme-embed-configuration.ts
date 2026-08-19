import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";

export const PROGRAMME_EMBED_CONTROLS = [
  "search",
  "day",
  "track",
  "format",
  "room",
] as const;

export const PROGRAMME_EMBED_SURFACES = [
  "sessions",
  "speakers",
  "timetable",
  "schedule",
  "gallery",
] as const;

export const PROGRAMME_EMBED_FIELDS = [
  "time",
  "location",
  "track",
  "format",
  "description",
  "speaker-details",
  "affiliations",
  "images",
  "biography",
  "sessions",
] as const;

export type ProgrammeEmbedControl = (typeof PROGRAMME_EMBED_CONTROLS)[number];
export type ProgrammeEmbedSurface = (typeof PROGRAMME_EMBED_SURFACES)[number];
export type ProgrammeEmbedField = (typeof PROGRAMME_EMBED_FIELDS)[number];
export type ProgrammeEmbedDensity = "comfortable" | "compact";
export type ProgrammeEmbedTheme = "light" | "dark" | "system";

const PROGRAMME_EMBED_QUERY_PARAMETERS = [
  "day",
  "track",
  "format",
  "room",
  "query",
  "accent",
  "controls",
  "density",
  "theme",
  "directory",
  "fields",
] as const;

type ProgrammeEmbedSearchConfiguration = {
  day: string | null;
  track: string | null;
  format: string | null;
  room: string | null;
  query: string;
  accent: string | null;
  controls: ProgrammeEmbedControl[];
  density: ProgrammeEmbedDensity;
  theme: ProgrammeEmbedTheme;
  showSpeakerDirectory: boolean;
  fields: ProgrammeEmbedField[];
};

export type ProgrammeEmbedConfiguration = {
  surface: ProgrammeEmbedSurface;
  day: string;
  track: string;
  format: string;
  room: string;
  query: string;
  accent: string;
  controls: ProgrammeEmbedControl[];
  density: ProgrammeEmbedDensity;
  theme: ProgrammeEmbedTheme;
  showSpeakerDirectory: boolean;
  fields: ProgrammeEmbedField[];
  height: number;
};

type ProgrammeEmbedSourceSession = {
  startsAt: number | null;
  status: string;
  visibility: string;
  track: string | null;
  format: string;
  room: string | null;
};

export class ProgrammeEmbedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgrammeEmbedConfigurationError";
  }
}

export function defaultProgrammeEmbedConfiguration(): ProgrammeEmbedConfiguration {
  return {
    surface: "sessions",
    day: "",
    track: "",
    format: "",
    room: "",
    query: "",
    accent: "",
    controls: [...PROGRAMME_EMBED_CONTROLS],
    density: "comfortable",
    theme: "system",
    showSpeakerDirectory: true,
    fields: [...PROGRAMME_EMBED_FIELDS],
    height: 720,
  };
}

function distinct(values: Array<string | null>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ].sort((left, right) => left.localeCompare(right));
}

export function programmeEmbedFilterOptions(
  sessions: ReadonlyArray<ProgrammeEmbedSourceSession>,
  timezone: string,
) {
  const published = sessions.filter(
    (session): session is ProgrammeEmbedSourceSession & { startsAt: number } =>
      session.startsAt !== null &&
      session.status === "published" &&
      session.visibility === "public",
  );
  return {
    days: distinct(
      published.map((session) =>
        eventLocalCalendarDate(session.startsAt, timezone),
      ),
    ),
    tracks: distinct(published.map((session) => session.track)),
    formats: distinct(published.map((session) => session.format)),
    rooms: distinct(published.map((session) => session.room)),
  };
}

function isEmbedControl(value: string): value is ProgrammeEmbedControl {
  return PROGRAMME_EMBED_CONTROLS.includes(value as ProgrammeEmbedControl);
}

export function parseProgrammeEmbedSurface(
  raw: string | undefined,
): ProgrammeEmbedSurface {
  if (raw === undefined) return "sessions";
  if (PROGRAMME_EMBED_SURFACES.includes(raw as ProgrammeEmbedSurface)) {
    return raw as ProgrammeEmbedSurface;
  }
  throw new ProgrammeEmbedConfigurationError(
    "Embed surface must be sessions, speakers, timetable, schedule or gallery.",
  );
}

function isEmbedField(value: string): value is ProgrammeEmbedField {
  return PROGRAMME_EMBED_FIELDS.includes(value as ProgrammeEmbedField);
}

export function parseProgrammeEmbedFields(
  raw: string | null,
): ProgrammeEmbedField[] {
  if (raw === null) return [...PROGRAMME_EMBED_FIELDS];
  if (raw === "none") return [];
  if (raw.length > 128) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed fields must be a unique comma-separated selection of supported public fields, or none.",
    );
  }
  const requested = raw.split(",");
  if (
    !requested.length ||
    requested.some((value) => !value || !isEmbedField(value)) ||
    new Set(requested).size !== requested.length
  ) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed fields must be a unique comma-separated selection of supported public fields, or none.",
    );
  }
  return requested as ProgrammeEmbedField[];
}

export function parseProgrammeEmbedControls(
  raw: string | null,
): ProgrammeEmbedControl[] {
  if (raw === null) return [...PROGRAMME_EMBED_CONTROLS];
  if (raw === "none") return [];
  if (raw.length > 64) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed controls must be a unique comma-separated selection of search, day, track, format and room, or none.",
    );
  }
  const requested = raw.split(",");
  if (
    !requested.length ||
    requested.some((value) => !value || !isEmbedControl(value)) ||
    new Set(requested).size !== requested.length
  ) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed controls must be a unique comma-separated selection of search, day, track, format and room, or none.",
    );
  }
  return requested as ProgrammeEmbedControl[];
}

export function parseProgrammeEmbedDensity(
  raw: string | null,
): ProgrammeEmbedDensity {
  if (raw === null || raw === "comfortable") return "comfortable";
  if (raw === "compact") return "compact";
  throw new ProgrammeEmbedConfigurationError(
    "Embed density must be comfortable or compact.",
  );
}

export function parseProgrammeEmbedTheme(
  raw: string | null,
): ProgrammeEmbedTheme {
  if (raw === null || raw === "system") return "system";
  if (raw === "light" || raw === "dark") return raw;
  throw new ProgrammeEmbedConfigurationError(
    "Embed theme must be light, dark or system.",
  );
}

export function parseProgrammeEmbedSpeakerDirectory(
  raw: string | null,
): boolean {
  if (raw === null || raw === "show") return true;
  if (raw === "hide") return false;
  throw new ProgrammeEmbedConfigurationError(
    "Embed speaker directory must be show or hide.",
  );
}

function optionalNonEmptyEmbedParameter(
  searchParams: URLSearchParams,
  name: "day" | "track" | "format" | "room" | "accent",
) {
  const raw = searchParams.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) {
    throw new ProgrammeEmbedConfigurationError(
      `Embed ${name} must not be empty when provided.`,
    );
  }
  return value;
}

export function parseProgrammeEmbedSearchParameters(
  searchParams: URLSearchParams,
): ProgrammeEmbedSearchConfiguration {
  const allowed = new Set<string>(PROGRAMME_EMBED_QUERY_PARAMETERS);
  const seen = new Set<string>();
  for (const [name] of searchParams) {
    if (!allowed.has(name)) {
      throw new ProgrammeEmbedConfigurationError(
        "Embed configuration contains an unsupported parameter.",
      );
    }
    if (seen.has(name)) {
      throw new ProgrammeEmbedConfigurationError(
        `Embed parameter ${name} must appear at most once.`,
      );
    }
    seen.add(name);
  }

  return {
    day: optionalNonEmptyEmbedParameter(searchParams, "day"),
    track: optionalNonEmptyEmbedParameter(searchParams, "track"),
    format: optionalNonEmptyEmbedParameter(searchParams, "format"),
    room: optionalNonEmptyEmbedParameter(searchParams, "room"),
    query: searchParams.get("query")?.trim() ?? "",
    accent: optionalNonEmptyEmbedParameter(searchParams, "accent"),
    controls: parseProgrammeEmbedControls(searchParams.get("controls")),
    density: parseProgrammeEmbedDensity(searchParams.get("density")),
    theme: parseProgrammeEmbedTheme(searchParams.get("theme")),
    showSpeakerDirectory: parseProgrammeEmbedSpeakerDirectory(
      searchParams.get("directory"),
    ),
    fields: parseProgrammeEmbedFields(searchParams.get("fields")),
  };
}

function hasDefaultControls(controls: readonly ProgrammeEmbedControl[]) {
  return (
    controls.length === PROGRAMME_EMBED_CONTROLS.length &&
    controls.every(
      (control, index) => control === PROGRAMME_EMBED_CONTROLS[index],
    )
  );
}

function hasDefaultFields(fields: readonly ProgrammeEmbedField[]) {
  return (
    fields.length === PROGRAMME_EMBED_FIELDS.length &&
    fields.every((field, index) => field === PROGRAMME_EMBED_FIELDS[index])
  );
}

function assertTextLength(label: string, value: string, maximum: number) {
  if (value.length > maximum) {
    throw new ProgrammeEmbedConfigurationError(
      `${label} must contain at most ${maximum} characters.`,
    );
  }
}

export function assertProgrammeEmbedConfiguration(
  configuration: ProgrammeEmbedConfiguration,
) {
  parseProgrammeEmbedSurface(configuration.surface);
  parseProgrammeEmbedControls(
    configuration.controls.length ? configuration.controls.join(",") : "none",
  );
  parseProgrammeEmbedDensity(configuration.density);
  parseProgrammeEmbedTheme(configuration.theme);
  parseProgrammeEmbedFields(
    configuration.fields.length ? configuration.fields.join(",") : "none",
  );
  if (typeof configuration.showSpeakerDirectory !== "boolean") {
    throw new ProgrammeEmbedConfigurationError(
      "Embed speaker directory visibility must be a boolean.",
    );
  }
  if (configuration.day) {
    const day = new Date(`${configuration.day}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(configuration.day) ||
      Number.isNaN(day.getTime()) ||
      day.toISOString().slice(0, 10) !== configuration.day
    ) {
      throw new ProgrammeEmbedConfigurationError(
        "Embed day must be a valid YYYY-MM-DD date.",
      );
    }
  }
  assertTextLength("Embed track", configuration.track, 120);
  assertTextLength("Embed format", configuration.format, 120);
  assertTextLength("Embed room", configuration.room, 120);
  assertTextLength("Embed query", configuration.query.trim(), 100);
  if (configuration.accent && !/^#[0-9a-f]{6}$/iu.test(configuration.accent)) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed accent must be a six-digit hexadecimal colour.",
    );
  }
  assertEmbedHeight(configuration.height);
}

export function parseProgrammeEmbedConfiguration(
  value: unknown,
): ProgrammeEmbedConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProgrammeEmbedConfigurationError(
      "Managed embed configuration must be an object.",
    );
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "surface",
    "day",
    "track",
    "format",
    "room",
    "query",
    "accent",
    "controls",
    "density",
    "theme",
    "showSpeakerDirectory",
    "fields",
    "height",
  ] as const;
  if (
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !(key in candidate)) ||
    ["day", "track", "format", "room", "query", "accent"].some(
      (key) => typeof candidate[key] !== "string",
    ) ||
    !Array.isArray(candidate.controls) ||
    candidate.controls.some((control) => typeof control !== "string") ||
    !Array.isArray(candidate.fields) ||
    candidate.fields.some((field) => typeof field !== "string") ||
    typeof candidate.showSpeakerDirectory !== "boolean" ||
    typeof candidate.theme !== "string" ||
    typeof candidate.height !== "number"
  ) {
    throw new ProgrammeEmbedConfigurationError(
      "Managed embed configuration has an invalid shape.",
    );
  }
  const configuration = candidate as ProgrammeEmbedConfiguration;
  assertProgrammeEmbedConfiguration(configuration);
  return {
    ...configuration,
    controls: [...configuration.controls],
    fields: [...configuration.fields],
  };
}

export function parsePersistedProgrammeEmbedConfiguration(
  value: unknown,
): ProgrammeEmbedConfiguration {
  // Agenda was a published chronological embed surface. Existing managed
  // embeds are durable external installations, so read that one retired value
  // as the surviving chronological Schedule surface. Strict authoring paths use
  // parseProgrammeEmbedConfiguration and reject the retired value.
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).surface === "agenda"
  ) {
    return parseProgrammeEmbedConfiguration({
      ...value,
      surface: "schedule",
    });
  }
  return parseProgrammeEmbedConfiguration(value);
}

export function programmeEmbedSearchConfiguration(
  configuration: ProgrammeEmbedConfiguration,
): ProgrammeEmbedSearchConfiguration {
  assertProgrammeEmbedConfiguration(configuration);
  return {
    day: configuration.day || null,
    track: configuration.track || null,
    format: configuration.format || null,
    room: configuration.room || null,
    query: configuration.query.trim(),
    accent: configuration.accent || null,
    controls: [...configuration.controls],
    density: configuration.density,
    theme: configuration.theme,
    showSpeakerDirectory: configuration.showSpeakerDirectory,
    fields: [...configuration.fields],
  };
}

export function programmeEmbedUrl(
  origin: string,
  eventSlug: string,
  configuration: ProgrammeEmbedConfiguration,
) {
  assertProgrammeEmbedConfiguration(configuration);
  const url = new URL(
    `/embed/${encodeURIComponent(eventSlug)}/${configuration.surface}`,
    origin,
  );
  const values = [
    ["day", configuration.day],
    ["track", configuration.track],
    ["format", configuration.format],
    ["room", configuration.room],
    ["query", configuration.query.trim()],
    ["accent", configuration.accent],
  ] as const;
  for (const [name, value] of values) {
    if (value) url.searchParams.set(name, value);
  }
  if (!hasDefaultControls(configuration.controls)) {
    url.searchParams.set(
      "controls",
      configuration.controls.length ? configuration.controls.join(",") : "none",
    );
  }
  if (configuration.density !== "comfortable") {
    url.searchParams.set("density", configuration.density);
  }
  if (configuration.theme !== "system") {
    url.searchParams.set("theme", configuration.theme);
  }
  if (
    configuration.surface === "sessions" &&
    !configuration.showSpeakerDirectory
  ) {
    url.searchParams.set("directory", "hide");
  }
  if (!hasDefaultFields(configuration.fields)) {
    url.searchParams.set(
      "fields",
      configuration.fields.length ? configuration.fields.join(",") : "none",
    );
  }
  return url.toString();
}

export function managedProgrammeEmbedUrl(
  origin: string,
  eventSlug: string,
  embedSlug: string,
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(embedSlug)) {
    throw new ProgrammeEmbedConfigurationError(
      "Managed embed slug must use lowercase letters, numbers and single hyphens.",
    );
  }
  return new URL(
    `/embed/${encodeURIComponent(eventSlug)}/saved/${encodeURIComponent(embedSlug)}`,
    origin,
  ).toString();
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertEmbedHeight(height: number) {
  if (!Number.isSafeInteger(height) || height < 160 || height > 20_000) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed height must be an integer from 160 to 20000 pixels.",
    );
  }
}

export function parseProgrammeEmbedHeight(raw: string) {
  if (!/^\d+$/u.test(raw)) {
    throw new ProgrammeEmbedConfigurationError(
      "Embed height must be an integer from 160 to 20000 pixels.",
    );
  }
  const height = Number(raw);
  assertEmbedHeight(height);
  return height;
}

export function programmeIframeSnippet(
  url: string,
  title: string,
  height: number,
) {
  assertEmbedHeight(height);
  return `<iframe src="${escapeHtmlAttribute(url)}" title="${escapeHtmlAttribute(title)}" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="strict-origin-when-cross-origin" style="display:block;width:100%;min-height:${height}px;border:0"></iframe>`;
}

export function programmeWidgetSnippet({
  origin,
  eventSlug,
  target,
  title,
  configuration,
}: {
  origin: string;
  eventSlug: string;
  target: string;
  title: string;
  configuration: ProgrammeEmbedConfiguration;
}) {
  assertProgrammeEmbedConfiguration(configuration);
  assertEmbedHeight(configuration.height);
  const attributes = [
    ["data-programcue-event", eventSlug],
    ["data-target", `#${target}`],
    ["data-title", title],
    ["data-surface", configuration.surface],
    ["data-day", configuration.day],
    ["data-track", configuration.track],
    ["data-format", configuration.format],
    ["data-room", configuration.room],
    ["data-query", configuration.query.trim()],
    ["data-accent", configuration.accent],
    [
      "data-controls",
      hasDefaultControls(configuration.controls)
        ? ""
        : configuration.controls.length
          ? configuration.controls.join(",")
          : "none",
    ],
    [
      "data-density",
      configuration.density === "comfortable" ? "" : configuration.density,
    ],
    ["data-theme", configuration.theme === "system" ? "" : configuration.theme],
    [
      "data-directory",
      configuration.surface === "sessions" &&
      !configuration.showSpeakerDirectory
        ? "hide"
        : "",
    ],
    [
      "data-fields",
      hasDefaultFields(configuration.fields)
        ? ""
        : configuration.fields.length
          ? configuration.fields.join(",")
          : "none",
    ],
    ["data-height", String(configuration.height)],
  ] as const;
  const serialized = attributes
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}="${escapeHtmlAttribute(value)}"`)
    .join(" ");
  const scriptUrl = new URL("/programcue-widget.js", origin).toString();
  return `<div id="${escapeHtmlAttribute(target)}"></div>\n<script src="${escapeHtmlAttribute(scriptUrl)}" ${serialized} async></script>`;
}

export function managedProgrammeWidgetSnippet({
  origin,
  eventSlug,
  embedSlug,
  target,
  title,
  height,
}: {
  origin: string;
  eventSlug: string;
  embedSlug: string;
  target: string;
  title: string;
  height: number;
}) {
  assertEmbedHeight(height);
  managedProgrammeEmbedUrl(origin, eventSlug, embedSlug);
  const scriptUrl = new URL("/programcue-widget.js", origin).toString();
  return `<div id="${escapeHtmlAttribute(target)}"></div>\n<script src="${escapeHtmlAttribute(scriptUrl)}" data-programcue-event="${escapeHtmlAttribute(eventSlug)}" data-programcue-embed="${escapeHtmlAttribute(embedSlug)}" data-target="#${escapeHtmlAttribute(target)}" data-title="${escapeHtmlAttribute(title)}" data-height="${height}" async></script>`;
}

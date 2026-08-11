type SourceRevisionEnvironment = {
  APP_ENV?: unknown;
  SOURCE_REVISION?: unknown;
};

const LOCAL_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const PRODUCTION_REVISION_PATTERN = /^[0-9a-f]{7,64}$/i;

export class SourceRevisionConfigurationError extends Error {
  constructor() {
    super(
      "SOURCE_REVISION must identify the running build with a non-placeholder revision.",
    );
    this.name = "SourceRevisionConfigurationError";
  }
}

export function requireSourceRevision(environment: SourceRevisionEnvironment) {
  const revision =
    typeof environment.SOURCE_REVISION === "string"
      ? environment.SOURCE_REVISION.trim()
      : "";
  const placeholder = /^(?:replace[_-]with|unknown|unset|none)/i.test(revision);
  const valid =
    LOCAL_REVISION_PATTERN.test(revision) &&
    !placeholder &&
    (environment.APP_ENV !== "production" ||
      PRODUCTION_REVISION_PATTERN.test(revision));
  if (!valid) throw new SourceRevisionConfigurationError();
  return revision;
}

/**
 * Error paths still need a safe release field when revision validation itself
 * failed. This is log metadata only; callers must separately fail runtime
 * readiness with requireSourceRevision.
 */
export function sourceRevisionForLog(environment: SourceRevisionEnvironment) {
  try {
    return requireSourceRevision(environment);
  } catch {
    return "invalid";
  }
}

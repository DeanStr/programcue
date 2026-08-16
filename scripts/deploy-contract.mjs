const ALWAYS_REQUIRED_PRODUCTION_SECRET_NAMES = Object.freeze([
  "BETTER_AUTH_SECRET",
  "ANONYMOUS_ITINERARY_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "CALENDAR_CREDENTIALS_KEY",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MICROSOFT_CALENDAR_CLIENT_ID",
  "MICROSOFT_CALENDAR_CLIENT_SECRET",
  "GOOGLE_AUTH_CLIENT_ID",
  "GOOGLE_AUTH_CLIENT_SECRET",
  "MICROSOFT_AUTH_CLIENT_ID",
  "MICROSOFT_AUTH_CLIENT_SECRET",
  "INTEGRATION_CREDENTIALS_KEY",
  "WEBHOOK_CREDENTIALS_KEY",
  "TURNSTILE_SECRET_KEY",
  "FILE_SCANNER_DISPATCH_SECRET",
  "FILE_SCANNER_WEBHOOK_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "D1_REST_API_TOKEN",
  "EVALUATION_ACCESS_CODE",
  "EVALUATION_SESSION_SECRET",
]);

export function requiredProductionSecretNames(resourceEmbedProviders) {
  if (
    typeof resourceEmbedProviders !== "string" ||
    !resourceEmbedProviders.trim()
  ) {
    throw new TypeError(
      "Production resource embed providers must be configured before validating secrets.",
    );
  }
  const configured = resourceEmbedProviders.trim();
  const providers =
    configured === "none"
      ? []
      : configured.split(",").map((provider) => provider.trim());
  const allowed = new Set(["youtube", "vimeo", "google_maps"]);
  if (
    providers.some((provider) => !allowed.has(provider)) ||
    new Set(providers).size !== providers.length
  ) {
    throw new TypeError(
      "Production resource embed providers are invalid; secret requirements cannot be determined.",
    );
  }
  return [
    ...ALWAYS_REQUIRED_PRODUCTION_SECRET_NAMES,
    ...(providers.includes("google_maps") ? ["GOOGLE_MAPS_EMBED_API_KEY"] : []),
  ];
}

// The checked-in production profile enables Google Maps. This exported
// inventory remains the documentation contract for that profile.
export const REQUIRED_PRODUCTION_SECRET_NAMES = Object.freeze(
  requiredProductionSecretNames("youtube,vimeo,google_maps"),
);

export const CHECKED_IN_SECRET_NAMES = Object.freeze([
  ...REQUIRED_PRODUCTION_SECRET_NAMES,
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MAILPIT_SEND_API_USERNAME",
  "MAILPIT_SEND_API_PASSWORD",
  "EVALUATION_FIXTURE_SECRET",
  "EVALUATION_RESEND_API_KEY",
  "EVALUATOR_ORGANIZER_EMAIL",
  "EVALUATOR_SPEAKER_EMAIL",
  "EVALUATOR_SECOND_SPEAKER_EMAIL",
  "EVALUATOR_REVIEWER_EMAIL",
]);

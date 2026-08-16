import {
  requireRuntimeMode,
  requiresProductionSecurity,
} from "~/platform/runtime-environment.server";
import {
  parseResourceEmbedProviders,
  resourceEmbedConfiguration,
} from "~/modules/resources/resource-embed-policy";

const requiredProductionBindings = [
  "DB",
  "FILES",
  "IMAGES",
  "BACKUPS",
  "OPERATIONS_QUEUE",
  "EVENT_CHANNEL",
  "PROGRAM_CUE_AGENT",
  "D1_BACKUP_WORKFLOW",
  "AI",
] as const;

const requiredProductionValues = [
  "BETTER_AUTH_URL",
  "AUTH_EMAIL_FROM",
  "EMAIL_PROVIDER",
  "TURNSTILE_SITE_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "FILE_SCANNER_API_URL",
  "CORS_ALLOWED_ORIGINS",
  "EMBED_FRAME_ANCESTORS",
  "RESOURCE_EMBED_PROVIDERS",
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
] as const;

const requiredGoogleMapsValues = ["GOOGLE_MAPS_EMBED_API_KEY"] as const;

const requiredProductionEvaluationValues = [
  "EVALUATION_ACCESS_CODE",
  "EVALUATION_SESSION_SECRET",
] as const;

const placeholderPattern =
  /(?:replace[_-]with|example\.invalid|\.example(?:\b|\/))/iu;

export class ProductionReadinessConfigurationError extends Error {
  constructor(readonly missingOrInvalidNames: readonly string[]) {
    super("Required production bindings or configuration are unavailable.");
    this.name = "ProductionReadinessConfigurationError";
  }
}

function configuredString(environment: Record<string, unknown>, name: string) {
  const value = environment[name];
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    !placeholderPattern.test(value)
  );
}

/**
 * Validate local Worker bindings and production-wide configuration only. Live
 * provider availability belongs in provider acceptance checks and must not turn
 * process readiness into a cascading external dependency.
 */
export function requireProductionRuntimeReadiness(
  environment: CloudflareEnvironment,
) {
  if (!requiresProductionSecurity(environment.APP_ENV)) return;
  const values = environment as unknown as Record<string, unknown>;
  const runtime = requireRuntimeMode(environment);
  const evaluationValues = runtime.evaluation
    ? requiredProductionEvaluationValues
    : [];
  const invalid: string[] = [
    ...requiredProductionBindings.filter((name) => !values[name]),
    ...requiredProductionValues.filter(
      (name) => !configuredString(values, name),
    ),
    ...evaluationValues.filter((name) => !configuredString(values, name)),
  ];
  if (
    typeof values.BETTER_AUTH_SECRET === "string" &&
    values.BETTER_AUTH_SECRET.trim().length < 32
  ) {
    invalid.push("BETTER_AUTH_SECRET");
  }
  if (
    typeof values.ANONYMOUS_ITINERARY_SECRET === "string" &&
    values.ANONYMOUS_ITINERARY_SECRET.trim().length < 32
  ) {
    invalid.push("ANONYMOUS_ITINERARY_SECRET");
  }
  if (
    typeof values.BETTER_AUTH_SECRET === "string" &&
    typeof values.ANONYMOUS_ITINERARY_SECRET === "string" &&
    values.BETTER_AUTH_SECRET.trim() ===
      values.ANONYMOUS_ITINERARY_SECRET.trim()
  ) {
    invalid.push("BETTER_AUTH_SECRET", "ANONYMOUS_ITINERARY_SECRET");
  }
  for (const name of [
    "FILE_SCANNER_DISPATCH_SECRET",
    "FILE_SCANNER_WEBHOOK_SECRET",
  ] as const) {
    if (typeof values[name] === "string" && values[name].trim().length < 32) {
      invalid.push(name);
    }
  }
  if (
    typeof values.FILE_SCANNER_DISPATCH_SECRET === "string" &&
    typeof values.FILE_SCANNER_WEBHOOK_SECRET === "string" &&
    values.FILE_SCANNER_DISPATCH_SECRET.trim() ===
      values.FILE_SCANNER_WEBHOOK_SECRET.trim()
  ) {
    invalid.push("FILE_SCANNER_DISPATCH_SECRET", "FILE_SCANNER_WEBHOOK_SECRET");
  }
  if (runtime.evaluation) {
    if (
      typeof values.EVALUATION_ACCESS_CODE === "string" &&
      values.EVALUATION_ACCESS_CODE.trim().length < 16
    ) {
      invalid.push("EVALUATION_ACCESS_CODE");
    }
    if (
      typeof values.EVALUATION_SESSION_SECRET === "string" &&
      values.EVALUATION_SESSION_SECRET.trim().length < 32
    ) {
      invalid.push("EVALUATION_SESSION_SECRET");
    }
    if (
      typeof values.EVALUATION_ACCESS_CODE === "string" &&
      typeof values.EVALUATION_SESSION_SECRET === "string" &&
      values.EVALUATION_ACCESS_CODE.trim() ===
        values.EVALUATION_SESSION_SECRET.trim()
    ) {
      invalid.push("EVALUATION_ACCESS_CODE", "EVALUATION_SESSION_SECRET");
    }
  }
  if (values.EMAIL_PROVIDER !== "resend") {
    invalid.push("EMAIL_PROVIDER");
  }
  let embedProviders = null;
  try {
    embedProviders = parseResourceEmbedProviders(
      values.RESOURCE_EMBED_PROVIDERS,
    );
  } catch {
    invalid.push("RESOURCE_EMBED_PROVIDERS");
  }
  if (embedProviders?.includes("google_maps")) {
    try {
      resourceEmbedConfiguration(values);
    } catch {
      invalid.push(...requiredGoogleMapsValues);
    }
  }
  if (invalid.length) {
    throw new ProductionReadinessConfigurationError(
      [...new Set(invalid)].sort(),
    );
  }
}

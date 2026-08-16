import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
} from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  requireSourceRevision,
  SourceRevisionConfigurationError,
  sourceRevisionForLog,
} from "~/platform/observability/source-revision.server";
import {
  RuntimeEnvironmentConfigurationError,
  requireRuntimeMode,
} from "~/platform/runtime-environment.server";
import {
  ProductionReadinessConfigurationError,
  requireProductionRuntimeReadiness,
} from "~/platform/runtime-readiness.server";
import type { Route } from "./+types/api-health";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    const runtime = requireRuntimeMode(env);
    const sourceRevision = requireSourceRevision(env);
    requireProductionRuntimeReadiness(env);
    if (!env.DB)
      throw new Error("Required Cloudflare binding DB is unavailable.");
    await env.DB.prepare("SELECT 1 AS ready FROM events LIMIT 1").first();
    return apiSuccess({
      ok: true,
      service: "program-cue",
      environment: runtime.appEnvironment,
      sourceRevision,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        correlationId: requestCorrelationId,
        sourceRevision: sourceRevisionForLog(env),
        subsystem: "readiness",
        event: "check-failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: "Service readiness validation failed.",
      }),
    );
    const readinessError =
      error instanceof RuntimeEnvironmentConfigurationError ||
      error instanceof SourceRevisionConfigurationError ||
      error instanceof ProductionReadinessConfigurationError
        ? new ApiError(
            503,
            "RUNTIME_CONFIGURATION_INVALID",
            "The service runtime configuration is invalid.",
          )
        : new ApiError(
            503,
            "DATABASE_UNAVAILABLE",
            "The D1 database or baseline schema is unavailable.",
          );
    return apiFailure(
      readinessError,
      request,
      env.APP_ENV,
      requestCorrelationId,
    );
  }
}

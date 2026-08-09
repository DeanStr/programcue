import type { Route } from "./+types/api-health";
import { ApiError, apiFailure, apiSuccess, correlationId } from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  requireRuntimeMode,
  RuntimeEnvironmentConfigurationError,
} from "~/platform/runtime-environment.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    const runtime = requireRuntimeMode(env);
    if (!env.DB) throw new Error("Required Cloudflare binding DB is unavailable.");
    await env.DB.prepare("SELECT 1 AS ready FROM events LIMIT 1").first();
    return apiSuccess({
      ok: true,
      service: "program-cue",
      environment: runtime.appEnvironment,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      correlationId: requestCorrelationId,
      subsystem: "readiness",
      message: error instanceof Error ? error.message : String(error),
    }));
    const readinessError = error instanceof RuntimeEnvironmentConfigurationError
      ? new ApiError(503, "RUNTIME_CONFIGURATION_INVALID", "The service runtime configuration is invalid.")
      : new ApiError(503, "DATABASE_UNAVAILABLE", "The D1 database or baseline schema is unavailable.");
    return apiFailure(readinessError, request, env.APP_ENV, requestCorrelationId);
  }
}

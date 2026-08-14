import { isVersionedApiPath } from "~/platform/http/api-cors";

export class MaintenanceModeConfigurationError extends Error {
  constructor(value: unknown) {
    super(`Unsupported MAINTENANCE_MODE value: ${String(value)}`);
    this.name = "MaintenanceModeConfigurationError";
  }
}

export function requireMaintenanceMode(environment: {
  MAINTENANCE_MODE?: unknown;
}) {
  if (environment.MAINTENANCE_MODE === "true") return true;
  if (environment.MAINTENANCE_MODE === "false") return false;
  throw new MaintenanceModeConfigurationError(environment.MAINTENANCE_MODE);
}

export function maintenanceResponse(request: Request, correlationId: string) {
  const init = {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "retry-after": "60",
    },
  } as const;
  if (isVersionedApiPath(new URL(request.url).pathname)) {
    return Response.json(
      {
        error: {
          code: "MAINTENANCE",
          message: "The service is temporarily unavailable.",
        },
        correlationId,
      },
      init,
    );
  }
  return new Response(
    "Program Cue is temporarily unavailable while production data is being migrated. Please try again shortly.",
    init,
  );
}

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
  throw new MaintenanceModeConfigurationError(
    environment.MAINTENANCE_MODE,
  );
}

export function maintenanceResponse() {
  return new Response(
    "Program Cue is temporarily unavailable while production data is being migrated. Please try again shortly.",
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}

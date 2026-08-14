import { describe, expect, it } from "vitest";

import {
  MaintenanceModeConfigurationError,
  maintenanceResponse,
  requireMaintenanceMode,
} from "./maintenance-mode.server";

describe("production maintenance mode", () => {
  it("accepts only explicit boolean strings", () => {
    expect(requireMaintenanceMode({ MAINTENANCE_MODE: "true" })).toBe(true);
    expect(requireMaintenanceMode({ MAINTENANCE_MODE: "false" })).toBe(false);
    for (const value of [undefined, "", "TRUE", true, false]) {
      expect(() => requireMaintenanceMode({ MAINTENANCE_MODE: value })).toThrow(
        MaintenanceModeConfigurationError,
      );
    }
  });

  it("returns a bounded non-cacheable maintenance response", async () => {
    const response = maintenanceResponse(
      new Request("https://programcue.test/admin"),
      "browser-correlation",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.text()).resolves.toContain("temporarily unavailable");
  });

  it("preserves the structured error contract for versioned API requests", async () => {
    const correlationId = "4fca1e72-df34-44cc-9454-40f06c330fa4";
    const response = maintenanceResponse(
      new Request("https://programcue.test/api/v1/public/events/example"),
      correlationId,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "MAINTENANCE",
        message: "The service is temporarily unavailable.",
      },
      correlationId,
    });
  });
});

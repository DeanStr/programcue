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
      expect(() =>
        requireMaintenanceMode({ MAINTENANCE_MODE: value }),
      ).toThrow(MaintenanceModeConfigurationError);
    }
  });

  it("returns a bounded non-cacheable maintenance response", async () => {
    const response = maintenanceResponse();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.text()).resolves.toContain("temporarily unavailable");
  });
});

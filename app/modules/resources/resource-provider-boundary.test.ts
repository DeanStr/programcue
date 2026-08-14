import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ResourceAuthoringService } from "./resource-authoring-service.server";
import { ResourceParticipantService } from "./resource-participant-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("resource Airtable authority", () => {
  it("routes publication and acknowledgement task changes through the provider boundary", async () => {
    const unavailable = new Error(
      "Airtable projection command is unavailable.",
    );
    const executeIdempotent = vi.fn(async (..._arguments: unknown[]) => {
      throw unavailable;
    });
    const airtable = {
      executeIdempotent,
      assertReadable: vi.fn(async () => null),
    } as unknown as AirtableProviderBoundary;

    await expect(
      new ResourceAuthoringService(env as unknown as CloudflareEnvironment, {
        airtable,
      }).publish(admin, "resource-id", 1),
    ).rejects.toBe(unavailable);
    await expect(
      new ResourceParticipantService(env as unknown as CloudflareEnvironment, {
        airtable,
      }).acknowledge(speaker, "resource-id", "version-id", null),
    ).rejects.toBe(unavailable);
    expect(executeIdempotent).toHaveBeenCalledTimes(2);
    expect(executeIdempotent.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ operation: "resource.publish" }),
      expect.objectContaining({ operation: "resource.acknowledge" }),
    ]);
  });
});

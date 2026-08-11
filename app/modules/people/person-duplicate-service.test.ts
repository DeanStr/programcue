import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { PersonDuplicateService } from "./person-duplicate-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "UPDATE events SET duplicate_person_warnings = 1 WHERE id = ?",
  )
    .bind(viewer.eventId)
    .run();
});

describe("likely duplicate person checks", () => {
  it("reports existing identities by email and normalised name", async () => {
    const result = await new PersonDuplicateService(
      env as unknown as CloudflareEnvironment,
    ).findLikelyDuplicates(viewer, [
      { name: "Olivia Bennett", email: "olivia@example.com" },
      { name: "Priya   Shah", email: "different-priya@example.com" },
    ]);

    expect(result.enabled).toBe(true);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personId: "person-demo-admin",
          reasons: expect.arrayContaining(["same_email", "same_name"]),
          currentEvent: true,
        }),
        expect.objectContaining({
          personId: "person-demo-speaker",
          reasons: ["same_name"],
          currentEvent: true,
        }),
      ]),
    );
  });

  it("does not disclose a matching identity from another organisation", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO organisations (id, name, slug) VALUES ('org-duplicate-isolation', 'Other organisation', 'other-duplicate-isolation')",
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO people (id, email, display_name, email_verified, profile_status) VALUES ('person-duplicate-isolation', 'isolated@example.com', 'Isolated Person', 1, 'draft')",
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (
           'membership-duplicate-isolation', 'org-duplicate-isolation', NULL,
           'person-duplicate-isolation', 'administrator', unixepoch()
         )`,
      ),
    ]);

    const result = await new PersonDuplicateService(
      env as unknown as CloudflareEnvironment,
    ).findLikelyDuplicates(viewer, [
      { name: "Isolated Person", email: "isolated@example.com" },
    ]);
    expect(result.matches).toEqual([]);
  });

  it("honours an event setting that explicitly disables warnings", async () => {
    await env.DB.prepare(
      "UPDATE events SET duplicate_person_warnings = 0 WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const result = await new PersonDuplicateService(
      env as unknown as CloudflareEnvironment,
    ).findLikelyDuplicates(viewer, [
      { name: "Olivia Bennett", email: "olivia@example.com" },
    ]);
    expect(result).toEqual({ enabled: false, matches: [], truncated: false });
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { SubmissionService } from "./submission-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("submission administration list", () => {
  it("keeps pagination filtered on the server while returning every event category", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const titlePrefix = `Grid ${token}`;
    const categoryPrefix = `Grid ${token} category`;
    const otherEventId = `other-grid-event-${token}`;

    const inserts = Array.from({ length: 55 }, (_, index) =>
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, status,
           answers_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'draft', '{}', 1, ?, ?)`,
      ).bind(
        `grid-submission-${token}-${index}`,
        viewer.eventId,
        `GRID-${token}-${index}`,
        `${titlePrefix} application ${String(index).padStart(2, "0")}`,
        `${categoryPrefix} ${String(index).padStart(2, "0")}`,
        1_700_000_000 + index,
        1_700_000_000 + index,
      ),
    );

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Other grid event', ?, 'UTC', 1800000000, 1800086400,
                   '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(otherEventId, viewer.organisationId, `other-grid-event-${token}`),
      ...inserts,
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, status,
           answers_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'Other event application', ?, 'draft', '{}', 1,
                   1700000000, 1700000000)`,
      ).bind(
        `other-grid-submission-${token}`,
        otherEventId,
        `OTHER-GRID-${token}`,
        `${categoryPrefix} other event only`,
      ),
    ]);

    const service = new SubmissionService(testEnv);
    const firstPage = await service.listAdminSubmissionPage(
      viewer,
      { query: titlePrefix },
      1,
    );
    expect(firstPage.submissions).toHaveLength(50);
    expect(firstPage.hasNext).toBe(true);

    const secondPage = await service.listAdminSubmissionPage(
      viewer,
      { query: titlePrefix },
      2,
    );
    expect(secondPage.submissions).toHaveLength(5);
    expect(secondPage.hasNext).toBe(false);

    const ownCategories = firstPage.categories.filter((category) =>
      category.startsWith(categoryPrefix),
    );
    expect(ownCategories).toHaveLength(55);
    expect(ownCategories).toEqual(
      [...ownCategories].sort((left, right) => left.localeCompare(right)),
    );
    expect(firstPage.categories).not.toContain(
      `${categoryPrefix} other event only`,
    );

    const lastCategory = `${categoryPrefix} 00`;
    expect(
      firstPage.submissions.map((submission) => submission.category),
    ).not.toContain(lastCategory);
    const filtered = await service.listAdminSubmissionPage(
      viewer,
      { category: lastCategory },
      1,
    );
    expect(filtered.submissions).toHaveLength(1);
    expect(filtered.submissions[0]?.category).toBe(lastCategory);
    expect(
      filtered.categories.filter((category) =>
        category.startsWith(categoryPrefix),
      ),
    ).toHaveLength(55);
  });

  it("does not read the D1 projection when Airtable freshness fails", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const boundary = {
      assertReadable: async () => {
        throw new Error("Airtable projection freshness is unavailable.");
      },
    } as unknown as AirtableProviderBoundary;
    const service = new SubmissionService(testEnv, { airtable: boundary });

    await expect(
      service.listAdminSubmissionPage(viewer, {}, 1),
    ).rejects.toThrow("Airtable projection freshness is unavailable");
    await expect(service.listAdminSubmissions(viewer, {})).rejects.toThrow(
      "Airtable projection freshness is unavailable",
    );
    await expect(
      service.getAdminSubmission(viewer, "submission-demo-ai"),
    ).rejects.toThrow("Airtable projection freshness is unavailable");
  });
});

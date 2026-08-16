import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { SubmissionAdminRepository } from "./submission-admin-repository.server";
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
  it("fails when the required routed-team aggregate is absent", async () => {
    const statement = {
      bind() {
        return statement;
      },
    };
    const repository = new SubmissionAdminRepository({
      DB: {
        prepare: () => statement,
        batch: async () => [{ results: [] }, { results: [] }],
      },
    } as unknown as CloudflareEnvironment);

    await expect(
      repository.getAdminSubmissionSummary(
        viewer.organisationId,
        viewer.eventId,
      ),
    ).rejects.toThrow(/routed-team aggregate count was not returned/i);
  });

  it("keeps pagination filtered on the server while returning every event category", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const titlePrefix = `Grid % ${token}`;
    const categoryPrefix = `Grid ${token} category`;
    const otherEventId = `other-grid-event-${token}`;
    const formId = `grid-form-${token}`;
    const formVersionId = `grid-form-version-${token}`;

    const inserts = Array.from({ length: 55 }, (_, index) =>
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, form_version_id, public_reference, title, category, status,
           answers_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', '{}', 1, ?, ?)`,
      ).bind(
        `grid-submission-${token}-${index}`,
        viewer.eventId,
        formVersionId,
        `GRID-${token}-${index}`,
        `${titlePrefix} application ${String(index).padStart(2, "0")}`,
        `${categoryPrefix} ${String(index).padStart(2, "0")}`,
        1_700_000_000 + index,
        1_700_000_000 + index,
      ),
    );

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO form_definitions (
           id, event_id, name, kind, status, public_slug, min_speakers,
           max_speakers, access_mode, created_by_person_id
         ) VALUES (?, ?, 'Grid fixture', 'submission', 'draft', ?, 1, 4,
                   'email_verified', ?)`,
      ).bind(formId, viewer.eventId, formId, viewer.personId),
      testEnv.DB.prepare(
        `INSERT INTO form_versions (
           id, event_id, form_id, version_number, schema_json, routing_json,
           settings_snapshot_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 1, '[]',
                   '{"categories":{},"trackIds":{},"trackNames":{},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":null}',
                   '{}', 'draft', ?)`,
      ).bind(formVersionId, viewer.eventId, formId, viewer.personId),
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
           id, event_id, form_version_id, public_reference, title, category,
           status, answers_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', '{}', 1, 1699999999,
                   1699999999)`,
      ).bind(
        `grid-wildcard-decoy-${token}`,
        viewer.eventId,
        formVersionId,
        `GRID-WILDCARD-DECOY-${token}`,
        `Grid X ${token} wildcard decoy`,
        `Wildcard decoy ${token}`,
      ),
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
    expect(firstPage.results.submissions).toHaveLength(50);
    expect(firstPage.results).toMatchObject({
      matchingTotal: 55,
      page: 1,
      pageSize: 50,
      firstItem: 1,
      lastItem: 50,
      totalPages: 2,
    });
    expect(firstPage.summary.eventTotal).toBeGreaterThanOrEqual(55);
    expect(firstPage.summary.byStatus.draft).toBeGreaterThanOrEqual(55);
    expect(
      firstPage.results.submissions.every(
        (row) => row.routingState === "draft",
      ),
    ).toBe(true);

    const secondPage = await service.listAdminSubmissionPage(
      viewer,
      { query: titlePrefix },
      2,
    );
    expect(secondPage.results.submissions).toHaveLength(5);
    expect(secondPage.results).toMatchObject({
      matchingTotal: 55,
      page: 2,
      firstItem: 51,
      lastItem: 55,
      totalPages: 2,
    });
    await expect(
      service.listAdminSubmissionPage(viewer, { query: titlePrefix }, 3),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.listAdminSubmissionPage(
        viewer,
        { query: `no-match-${crypto.randomUUID()}` },
        1,
      ),
    ).resolves.toMatchObject({
      results: {
        submissions: [],
        matchingTotal: 0,
        page: 1,
        firstItem: null,
        lastItem: null,
        totalPages: 1,
      },
    });

    const titleSorted = await service.listAdminSubmissionPage(
      viewer,
      { query: titlePrefix, sort: "title-asc" },
      1,
    );
    expect(titleSorted.results.submissions[0]?.title).toBe(
      `${titlePrefix} application 00`,
    );

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
      firstPage.results.submissions.map((submission) => submission.category),
    ).not.toContain(lastCategory);
    const filtered = await service.listAdminSubmissionPage(
      viewer,
      { category: lastCategory },
      1,
    );
    expect(filtered.results.submissions).toHaveLength(1);
    expect(filtered.results.submissions[0]?.category).toBe(lastCategory);
    expect(
      filtered.categories.filter((category) =>
        category.startsWith(categoryPrefix),
      ),
    ).toHaveLength(55);

    const pageBoundary = await service.getAdminSubmissionQueueContext(
      viewer,
      `grid-submission-${token}-5`,
      { query: titlePrefix },
      1,
    );
    expect(pageBoundary).toEqual({
      previous: {
        id: `grid-submission-${token}-6`,
        title: `${titlePrefix} application 06`,
        page: 1,
      },
      next: {
        id: `grid-submission-${token}-4`,
        title: `${titlePrefix} application 04`,
        page: 2,
      },
    });
    await expect(
      service.getAdminSubmissionQueueContext(
        viewer,
        `grid-submission-${token}-5`,
        { query: titlePrefix },
        2,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await testEnv.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, form_version_id, public_reference, title, category,
         status, answers_json, submitted_snapshot_json, submitted_at
       ) VALUES (?, ?, ?, ?, 'Missing track projection', ?, 'submitted',
                 '{}', '{}', unixepoch())`,
    )
      .bind(
        `grid-missing-track-${token}`,
        viewer.eventId,
        formVersionId,
        `GRID-MISSING-${token}`,
        `${categoryPrefix} hidden fallback`,
      )
      .run();
    await expect(
      service.listAdminSubmissionPage(
        viewer,
        { query: "Missing track projection" },
        1,
      ),
    ).rejects.toThrow(/missing persisted track selections/i);
  });

  it("does not read the Program Cue copy when Airtable freshness fails", async () => {
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
    await expect(
      service.getAdminSubmissionQueueContext(
        viewer,
        "submission-demo-ai",
        {},
        1,
      ),
    ).rejects.toThrow("Airtable projection freshness is unavailable");
  });
});

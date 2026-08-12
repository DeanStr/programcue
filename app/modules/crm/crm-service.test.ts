import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CrmService } from "./crm-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
  }
}

const administrator: OrganisationAdministrator = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  currentEventId: "evt-foe-2025",
  demo: true,
};

const emptyFilters = {
  query: "",
  company: "",
  jobTitle: "",
  tag: "",
};

async function service() {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoSpeakerData(testEnv);
  return { testEnv, crm: new CrmService(testEnv) };
}

describe("organisation speaker CRM", () => {
  it("imports the evaluator CSV shape and supports filters, notes, tags and segments", async () => {
    const { crm } = await service();
    const csv = [
      "name,email,title,company,bio",
      'Priya Raman,priya.crm@example.com,Principal Engineer,Latticework Systems,"Build tooling leader"',
      'Marcus Okafor,marcus.crm@example.com,Staff Developer Advocate,Cloudreach Labs,"AI agents in production"',
    ].join("\n");
    const preview = await crm.previewImport(csv);
    expect(preview.mapping).toEqual({
      name: "name",
      email: "email",
      jobTitle: "title",
      organisationName: "company",
      biography: "bio",
    });
    expect(preview.invalid).toEqual([]);
    await expect(crm.confirmImport(administrator, csv)).resolves.toEqual({
      imported: 2,
    });

    const directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, company: "Latticework Systems" },
      1,
    );
    expect(directory.contacts).toHaveLength(1);
    expect(directory.contacts[0]).toMatchObject({
      name: "Priya Raman",
      email: "priya.crm@example.com",
      jobTitle: "Principal Engineer",
    });
    const personId = directory.contacts[0]!.personId;
    await crm.addTag(administrator, personId, "AI");
    await crm.addTag(administrator, personId, "ai");
    await crm.addNote(
      administrator,
      personId,
      "Met at DevFlow 2026 - strong on CI topics; shortlist for keynote.",
    );
    await crm.saveSegment(administrator, "AI Experts", {
      ...emptyFilters,
      tag: "AI",
    });

    const tagged = await crm.listDirectory(
      administrator,
      { ...emptyFilters, tag: "AI" },
      1,
    );
    expect(tagged.contacts.map((contact) => contact.personId)).toEqual([
      personId,
    ]);
    const detail = await crm.getContact(administrator, personId);
    expect(detail.tags).toEqual(["AI"]);
    expect(detail.notes[0]?.body).toContain("shortlist for keynote");
    expect(await crm.listSegments(administrator)).toEqual([
      expect.objectContaining({
        name: "AI Experts",
        filters: expect.objectContaining({ tag: "AI" }),
      }),
    ]);
  });

  it("surfaces and safely merges an unlinked same-name CRM contact", async () => {
    const { testEnv, crm } = await service();
    const primary = await crm.createContact(administrator, {
      name: "Duplicate Speaker",
      email: `primary-${crypto.randomUUID()}@example.com`,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    const secondaryEmail = `secondary-${crypto.randomUUID()}@example.com`;
    const secondary = await crm.createContact(administrator, {
      name: "Duplicate Speaker",
      email: secondaryEmail,
      jobTitle: "Engineer",
      organisationName: "Secondary Co",
      biography: "Secondary biography",
    });
    const before = await crm.getContact(administrator, primary.personId);
    expect(before.duplicates.map((candidate) => candidate.personId)).toContain(
      secondary.personId,
    );

    await crm.enrollPipeline(administrator, {
      personId: primary.personId,
      stage: "identified",
      score: null,
      rationale: "Primary pipeline record",
    });
    await crm.enrollPipeline(administrator, {
      personId: secondary.personId,
      stage: "contacted",
      score: null,
      rationale: "Secondary pipeline record",
    });
    const secondaryPipeline = await crm.getPipelineEntry(
      administrator,
      secondary.personId,
    );
    await crm.addPipelineNote(administrator, {
      entryId: secondaryPipeline!.id,
      body: "Preserve this secondary history.",
    });

    await crm.mergeContacts(
      administrator,
      primary.personId,
      secondary.personId,
    );
    const directory = await crm.listDirectory(administrator, emptyFilters, 1);
    expect(
      directory.contacts.filter(
        (contact) => contact.name === "Duplicate Speaker",
      ),
    ).toHaveLength(1);
    await expect(
      crm.getContact(administrator, secondary.personId),
    ).rejects.toMatchObject({ status: 404 });
    const merged = await crm.getContact(administrator, primary.personId);
    expect(merged).toMatchObject({
      biography: "Secondary biography",
      organisationName: "Secondary Co",
      jobTitle: "Engineer",
    });
    expect(merged.pipeline?.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "note",
          body: "Preserve this secondary history.",
        }),
      ]),
    );
    const pipelineRows = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM crm_pipeline_entries
        WHERE organisation_id = ? AND person_id IN (?, ?)`,
    )
      .bind(administrator.organisationId, primary.personId, secondary.personId)
      .first<{ count: number }>();
    expect(Number(pipelineRows?.count)).toBe(1);

    const recreated = await crm.createContact(administrator, {
      name: "Duplicate Speaker",
      email: secondaryEmail,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    expect(recreated.personId).toBe(primary.personId);
    await expect(
      crm.confirmImport(
        administrator,
        `name,email\nDuplicate Speaker,${secondaryEmail}`,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("belongs to a merged contact"),
      status: 422,
    });
  });

  it("does not rewrite a linked primary identity while merging its CRM-only duplicate", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const primary = await crm.createContact(administrator, {
      name: "Linked Primary Speaker",
      email: `linked-primary-${suffix}@example.com`,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    const secondary = await crm.createContact(administrator, {
      name: "Linked Primary Speaker",
      email: `linked-secondary-${suffix}@example.com`,
      jobTitle: "Secondary title",
      organisationName: "Secondary company",
      biography: "Secondary biography",
    });
    await testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, created_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        `linked-primary-membership-${suffix}`,
        administrator.organisationId,
        administrator.currentEventId,
        primary.personId,
      )
      .run();

    await crm.mergeContacts(
      administrator,
      primary.personId,
      secondary.personId,
    );

    await expect(
      crm.getContact(administrator, primary.personId),
    ).resolves.toMatchObject({
      biography: null,
      organisationName: null,
      jobTitle: null,
    });
  });

  it("refuses to merge a secondary identity active in another organisation", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const primary = await crm.createContact(administrator, {
      name: "Shared CRM Contact",
      email: `shared-primary-${suffix}@example.com`,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    const secondary = await crm.createContact(administrator, {
      name: "Shared CRM Contact",
      email: `shared-secondary-${suffix}@example.com`,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    const otherOrganisationId = `shared-contact-org-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Shared Contact Org', ?)",
      ).bind(otherOrganisationId, otherOrganisationId),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
      ).bind(otherOrganisationId, secondary.personId),
    ]);

    await expect(
      crm.mergeContacts(administrator, primary.personId, secondary.personId),
    ).rejects.toMatchObject({
      message: expect.stringContaining("another organisation"),
    });
  });

  it("persists pipeline moves, notes and timestamped transition history", async () => {
    const { crm } = await service();
    const contact = await crm.createContact(administrator, {
      name: "Pipeline Speaker",
      email: `pipeline-${crypto.randomUUID()}@example.com`,
      jobTitle: "Advocate",
      organisationName: "Cloud Co",
      biography: "",
    });
    await crm.enrollPipeline(administrator, {
      personId: contact.personId,
      stage: "identified",
      score: 85,
      rationale: "Strong platform-engineering track record.",
    });
    const initial = await crm.getPipelineEntry(administrator, contact.personId);
    expect(initial).toMatchObject({ stage: "identified", revision: 1 });
    await crm.movePipelineEntry(administrator, {
      entryId: initial!.id,
      stage: "contacted",
      revision: initial!.revision,
    });
    await crm.addPipelineNote(administrator, {
      entryId: initial!.id,
      body: "Left voicemail 2027-01-15; follow up next week.",
    });
    const moved = await crm.getPipelineEntry(administrator, contact.personId);
    expect(moved?.stage).toBe("contacted");
    expect(moved?.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "note",
          body: expect.stringContaining("voicemail"),
        }),
        expect.objectContaining({
          kind: "stage_changed",
          fromStage: "identified",
          toStage: "contacted",
        }),
      ]),
    );
  });

  it("hands a canonical contact to an event and creates outreach in the existing communications domain", async () => {
    const { testEnv, crm } = await service();
    const first = await crm.createContact(administrator, {
      name: "Outreach One",
      email: `outreach-one-${crypto.randomUUID()}@example.com`,
      jobTitle: "Engineer",
      organisationName: "One Co",
      biography: "One bio",
    });
    const second = await crm.createContact(administrator, {
      name: "Outreach Two",
      email: `outreach-two-${crypto.randomUUID()}@example.com`,
      jobTitle: "Engineer",
      organisationName: "Two Co",
      biography: "Two bio",
    });
    await expect(
      crm.addContactToEvent(
        administrator,
        first.personId,
        administrator.currentEventId,
        `crm-event-${crypto.randomUUID()}`,
      ),
    ).resolves.toEqual({ eventId: administrator.currentEventId });
    const membership = await testEnv.DB.prepare(
      `SELECT role FROM memberships
        WHERE event_id = ? AND person_id = ? AND revoked_at IS NULL`,
    )
      .bind(administrator.currentEventId, first.personId)
      .first<{ role: string }>();
    expect(membership?.role).toBe("speaker");

    const outreachInput = {
      personIds: [first.personId, second.personId],
      eventId: administrator.currentEventId,
      idempotencyKey: `crm-outreach-${crypto.randomUUID()}`,
      subject: "Speak at DevFlow Conf 2027?",
      body: "Hello {{recipient.firstName}}, join {{event.name}}.",
      physicalAddress: "100 Programme Way, Toronto",
    };
    const draft = await crm.createOutreachDraft(administrator, outreachInput);
    await expect(
      crm.createOutreachDraft(administrator, outreachInput),
    ).resolves.toEqual(draft);
    const stored = await testEnv.DB.prepare(
      `SELECT status, audience_json AS audienceJson FROM communications
        WHERE id = ? AND event_id = ?`,
    )
      .bind(draft.draftId, administrator.currentEventId)
      .first<{ status: string; audienceJson: string }>();
    expect(stored?.status).toBe("draft");
    expect(stored?.audienceJson).toContain("Outreach One");
    expect(stored?.audienceJson).toContain("Outreach Two");
    const duplicateCount = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM communications
        WHERE event_id = ? AND id = ?`,
    )
      .bind(administrator.currentEventId, draft.draftId)
      .first<{ count: number }>();
    expect(Number(duplicateCount?.count)).toBe(1);
  });

  it("does not expose contacts belonging only to another organisation", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organisations (id, name, slug) VALUES (?, 'Other Org', ?)`,
      ).bind(`other-org-${suffix}`, `other-org-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         VALUES (?, ?, 'Other Organisation Speaker')`,
      ).bind(`other-person-${suffix}`, `other-${suffix}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
      ).bind(`other-org-${suffix}`, `other-person-${suffix}`),
    ]);
    const directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, query: "Other Organisation Speaker" },
      1,
    );
    expect(directory.contacts).toEqual([]);
  });

  it("does not expose an unaccepted speaker invitation as a CRM contact", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         VALUES (?, ?, 'Pending CRM Speaker')`,
      ).bind(`pending-person-${suffix}`, `pending-${suffix}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch() + 3600,
                   NULL, NULL, unixepoch())`,
      ).bind(
        `pending-membership-${suffix}`,
        administrator.organisationId,
        administrator.currentEventId,
        `pending-person-${suffix}`,
      ),
    ]);

    const directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, query: "Pending CRM Speaker" },
      1,
    );
    expect(directory.contacts).toEqual([]);
  });

  it("counts only accepted active speaker memberships in contact history", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const contact = await crm.createContact(administrator, {
      name: "Membership History Speaker",
      email: `membership-history-${suffix}@example.com`,
      jobTitle: "Engineer",
      organisationName: "History Co",
      biography: "",
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch() + 3600,
                   NULL, NULL, unixepoch())`,
      ).bind(
        `pending-history-${suffix}`,
        administrator.organisationId,
        administrator.currentEventId,
        contact.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, created_at
         ) VALUES (?, ?, NULL, ?, 'administrator', unixepoch(), NULL,
                   unixepoch(), NULL, unixepoch())`,
      ).bind(
        `organisation-history-${suffix}`,
        administrator.organisationId,
        contact.personId,
      ),
    ]);

    let directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, query: "Membership History Speaker" },
      1,
    );
    expect(directory.contacts[0]?.eventCount).toBe(0);

    await testEnv.DB.prepare(
      `UPDATE memberships SET accepted_at = unixepoch(),
              invitation_expires_at = NULL
        WHERE id = ?`,
    )
      .bind(`pending-history-${suffix}`)
      .run();
    directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, query: "Membership History Speaker" },
      1,
    );
    expect(directory.contacts[0]?.eventCount).toBe(1);
  });

  it("links an existing identity without overwriting profile data from another organisation", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const personId = `shared-import-${suffix}`;
    const email = `shared-import-${suffix}@example.com`;
    await testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, biography, organisation_name, job_title
       ) VALUES (?, ?, 'Existing Identity', 'Existing biography',
                 'Existing Company', 'Existing Role')`,
    )
      .bind(personId, email)
      .run();

    await crm.confirmImport(
      administrator,
      [
        "name,email,title,company,bio",
        `Imported Name,${email},Imported Role,Imported Company,Imported biography`,
      ].join("\n"),
    );

    const person = await testEnv.DB.prepare(
      `SELECT display_name AS name, biography,
              organisation_name AS organisationName, job_title AS jobTitle
         FROM people WHERE id = ?`,
    )
      .bind(personId)
      .first<{
        name: string;
        biography: string;
        organisationName: string;
        jobTitle: string;
      }>();
    expect(person).toEqual({
      name: "Existing Identity",
      biography: "Existing biography",
      organisationName: "Existing Company",
      jobTitle: "Existing Role",
    });
    const contact = await testEnv.DB.prepare(
      `SELECT source FROM organisation_contacts
        WHERE organisation_id = ? AND person_id = ?`,
    )
      .bind(administrator.organisationId, personId)
      .first<{ source: string }>();
    expect(contact?.source).toBe("import");
  });

  it("rejects malformed, oversized and duplicate-row CSV imports", async () => {
    const { crm } = await service();
    await expect(
      crm.previewImport('name,email\n"Unclosed,broken@example.com'),
    ).rejects.toMatchObject({
      message: "The CSV file ends inside a quoted field.",
      status: 422,
    });
    await expect(
      crm.previewImport(
        `name,email,bio\nLarge,large@example.com,${"x".repeat(512_000)}`,
      ),
    ).rejects.toMatchObject({
      message: "CRM CSV files cannot exceed 512 KB.",
      status: 422,
    });

    const preview = await crm.previewImport(
      [
        "name,email",
        "First,duplicate@example.com",
        "Second,DUPLICATE@example.com",
      ].join("\n"),
    );
    expect(preview.valid).toHaveLength(1);
    expect(preview.invalid).toEqual([
      {
        rowNumber: 3,
        errors: ["Email duplicates another row in this import."],
      },
    ]);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CrmService, CrmStateError } from "./crm-service.server";
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

function withNextBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let pending = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

function withNextPostBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let pending = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          if (pending) {
            pending = false;
            await race();
          }
          return results;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

describe("organisation speaker CRM", () => {
  it("imports the evaluator CSV shape and supports filters, notes, tags and segments", async () => {
    const { testEnv, crm } = await service();
    const csv = [
      "name,email,title,company,bio",
      'Priya Raman,priya.crm@example.com,Principal Engineer,Latticework Systems,"Build tooling leader"',
      'Marcus Okafor,marcus.crm@example.com,Staff Developer Advocate,Cloudreach Labs,"AI agents in production"',
    ].join("\n");
    const preview = await crm.previewImport(administrator, csv);
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
    const canonicalPerson = await testEnv.DB.prepare(
      `SELECT display_name AS name, biography,
              organisation_name AS organisationName, job_title AS jobTitle
         FROM people WHERE id = ?`,
    )
      .bind(personId)
      .first();
    expect(canonicalPerson).toEqual({
      name: "priya.crm@example.com",
      biography: null,
      organisationName: null,
      jobTitle: null,
    });
    const scopedProfile = await testEnv.DB.prepare(
      `SELECT display_name AS name, biography,
              organisation_name AS organisationName, job_title AS jobTitle,
              source
         FROM organisation_contact_profiles
        WHERE organisation_id = ? AND person_id = ?`,
    )
      .bind(administrator.organisationId, personId)
      .first();
    expect(scopedProfile).toEqual({
      name: "Priya Raman",
      biography: "Build tooling leader",
      organisationName: "Latticework Systems",
      jobTitle: "Principal Engineer",
      source: "import",
    });
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

  it("keeps manually entered Network enrichment organisation-scoped", async () => {
    const { testEnv, crm } = await service();
    const email = `scoped-manual-${crypto.randomUUID()}@example.com`;
    const created = await crm.createContact(administrator, {
      name: "Organiser Suggested Name",
      email,
      jobTitle: "Suggested Role",
      organisationName: "Suggested Company",
      biography: "Organiser-authored biography",
    });

    await expect(
      testEnv.DB.prepare(
        `SELECT display_name AS name, biography,
                organisation_name AS organisationName, job_title AS jobTitle
           FROM people WHERE id = ?`,
      )
        .bind(created.personId)
        .first(),
    ).resolves.toEqual({
      name: email,
      biography: null,
      organisationName: null,
      jobTitle: null,
    });
    await expect(
      crm.getContact(administrator, created.personId),
    ).resolves.toMatchObject({
      name: "Organiser Suggested Name",
      biography: "Organiser-authored biography",
      organisationName: "Suggested Company",
      jobTitle: "Suggested Role",
    });
  });

  it("surfaces and safely merges an unlinked same-name CRM contact", async () => {
    const { testEnv, crm } = await service();
    const primaryEmail = `primary-${crypto.randomUUID()}@example.com`;
    const primary = await crm.createContact(administrator, {
      name: "Duplicate Speaker",
      email: primaryEmail,
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

    await expect(
      crm.createContact(administrator, {
        name: "Duplicate Speaker",
        email: secondaryEmail,
        jobTitle: "",
        organisationName: "",
        biography: "",
      }),
    ).rejects.toMatchObject({
      message: `This email belongs to a merged contact. Use Duplicate Speaker (${primaryEmail}) instead.`,
      status: 409,
    });
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
    const primaryEmail = `linked-primary-${suffix}@example.com`;
    const primary = await crm.createContact(administrator, {
      name: "Linked Primary Speaker",
      email: primaryEmail,
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
      name: "Linked Primary Speaker",
      biography: "Secondary biography",
      organisationName: "Secondary company",
      jobTitle: "Secondary title",
    });
    const canonicalPrimary = await testEnv.DB.prepare(
      `SELECT display_name AS name, biography,
              organisation_name AS organisationName, job_title AS jobTitle
         FROM people WHERE id = ?`,
    )
      .bind(primary.personId)
      .first();
    expect(canonicalPrimary).toEqual({
      name: primaryEmail,
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
    ).resolves.toEqual({
      eventId: administrator.currentEventId,
      personId: first.personId,
      accepted: false,
    });
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

  it("excludes inactive events from CRM selection and event mutations", async () => {
    const { testEnv, crm } = await service();
    const token = crypto.randomUUID();
    const eventId = `crm-inactive-${token}`;
    await testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         brand_accent, session_formats_json, repository_provider,
         activation_status, retention_months, submission_access_mode,
         allow_anonymous_drafts, duplicate_person_warnings, file_policy_json,
         revision, last_updated_by_person_id, created_at, updated_at
       )
       SELECT ?, organisation_id, 'Inactive CRM event', ?, timezone,
              starts_at, ends_at, brand_accent, session_formats_json,
              'airtable', 'provisioning_failed', retention_months,
              submission_access_mode, allow_anonymous_drafts,
              duplicate_person_warnings, file_policy_json, 1,
              last_updated_by_person_id, unixepoch(), unixepoch()
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(
        eventId,
        `inactive-crm-${token}`,
        administrator.currentEventId,
        administrator.organisationId,
      )
      .run();
    const contact = await crm.createContact(administrator, {
      name: "Inactive Event Contact",
      email: `inactive-event-${token}@example.com`,
      jobTitle: "",
      organisationName: "",
      biography: "",
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `crm-inactive-membership-${token}`,
        administrator.organisationId,
        eventId,
        contact.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility, created_at, updated_at
         ) VALUES (?, ?, 'Inactive event session', ?, 'presentation', 30,
                   'unscheduled', 'private', unixepoch(), unixepoch())`,
      ).bind(
        `crm-inactive-session-${token}`,
        eventId,
        `crm-inactive-session-${token}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'private')`,
      ).bind(`crm-inactive-session-${token}`, eventId, contact.personId),
    ]);

    const directory = await crm.listDirectory(
      administrator,
      { ...emptyFilters, query: "Inactive Event Contact" },
      1,
    );
    expect(directory.contacts[0]).toMatchObject({
      eventCount: 0,
      sessionCount: 0,
    });

    await expect(crm.listEvents(administrator)).resolves.not.toContainEqual(
      expect.objectContaining({ id: eventId }),
    );
    await expect(
      crm.addContactToEvent(
        administrator,
        contact.personId,
        eventId,
        `crm-inactive-${token}`,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      crm.createOutreachDraft(administrator, {
        personIds: [contact.personId, "person-demo-speaker"],
        eventId,
        idempotencyKey: `crm-inactive-outreach-${token}`,
        subject: "Unavailable event",
        body: "This should not be created.",
        physicalAddress: "100 Programme Way, Toronto",
      }),
    ).rejects.toMatchObject({ status: 404 });
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

  it("exposes an unaccepted event-roster invitation without granting participant access", async () => {
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
    expect(directory.contacts).toEqual([
      expect.objectContaining({
        personId: `pending-person-${suffix}`,
        eventCount: 1,
      }),
    ]);
    await expect(
      crm.createContact(administrator, {
        name: "Pending CRM Speaker",
        email: `pending-${suffix}@example.com`,
        jobTitle: "",
        organisationName: "",
        biography: "",
      }),
    ).resolves.toMatchObject({ personId: `pending-person-${suffix}` });
  });

  it("counts an invited event-roster workflow before account acceptance", async () => {
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
    expect(directory.contacts[0]?.eventCount).toBe(1);

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

  it("refuses manual and CSV links to an identity known only to another organisation", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const otherOrganisationId = `shared-import-org-${suffix}`;
    const personId = `shared-import-${suffix}`;
    const email = `shared-import-${suffix}@example.com`;
    const newEmail = `new-import-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Profile Owner', ?)",
      ).bind(otherOrganisationId, otherOrganisationId),
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, biography, organisation_name, job_title
         ) VALUES (?, ?, 'Existing Identity', 'Private biography',
                   'Private Company', 'Private Role')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
      ).bind(otherOrganisationId, personId),
    ]);

    await expect(
      crm.createContact(administrator, {
        name: "Existing Identity",
        email,
        jobTitle: "Imported Role",
        organisationName: "Imported Company",
        biography: "Imported biography",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("connect them through an event"),
      status: 409,
    });

    const csv = [
      "name,email,title,company,bio",
      `Existing Identity,${email},Imported Role,Imported Company,Imported biography`,
      `New Identity,${newEmail},New Role,New Company,New biography`,
    ].join("\n");
    const preview = await crm.previewImport(administrator, csv);
    expect(preview.valid.map((row) => row.email)).toEqual([newEmail]);
    expect(preview.invalid).toEqual([
      {
        rowNumber: 2,
        errors: [
          "This email cannot be added directly. Invite the speaker or connect them through an event first.",
        ],
      },
    ]);
    await expect(crm.confirmImport(administrator, csv)).rejects.toMatchObject({
      message:
        "Resolve every invalid contact row before confirming the import.",
      status: 422,
    });

    const currentContact = await testEnv.DB.prepare(
      `SELECT 1 FROM organisation_contacts
        WHERE organisation_id = ? AND person_id = ?`,
    )
      .bind(administrator.organisationId, personId)
      .first();
    expect(currentContact).toBeNull();
    await expect(crm.getContact(administrator, personId)).rejects.toMatchObject(
      { status: 404 },
    );
    const partiallyImported = await testEnv.DB.prepare(
      "SELECT 1 FROM people WHERE email = ? COLLATE NOCASE",
    )
      .bind(newEmail)
      .first();
    expect(partiallyImported).toBeNull();
  });

  it("links an existing identity with a current organisation relationship without overwriting its profile", async () => {
    const { testEnv, crm } = await service();
    const suffix = crypto.randomUUID();
    const personId = `related-import-${suffix}`;
    const email = `related-import-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, biography, organisation_name, job_title
         ) VALUES (?, ?, 'Existing Identity', 'Existing biography',
                   'Existing Company', 'Existing Role')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `related-import-membership-${suffix}`,
        administrator.organisationId,
        administrator.currentEventId,
        personId,
      ),
    ]);

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
    await expect(
      crm.getContact(administrator, personId),
    ).resolves.toMatchObject({
      name: "Imported Name",
      biography: "Imported biography",
      organisationName: "Imported Company",
      jobTitle: "Imported Role",
    });
  });

  it("rolls back a CSV import when an unrelated global identity appears after preview", async () => {
    const { testEnv } = await service();
    const suffix = crypto.randomUUID();
    const otherOrganisationId = `racing-import-org-${suffix}`;
    const racingPersonId = `racing-import-person-${suffix}`;
    const racingEmail = `racing-import-${suffix}@example.com`;
    const safeEmail = `safe-import-${suffix}@example.com`;
    await testEnv.DB.prepare(
      "INSERT INTO organisations (id, name, slug) VALUES (?, 'Race owner', ?)",
    )
      .bind(otherOrganisationId, otherOrganisationId)
      .run();
    const racingEnv = withNextBatchRace(testEnv, async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (id, email, display_name)
           VALUES (?, ?, 'Unrelated global identity')`,
        ).bind(racingPersonId, racingEmail),
        testEnv.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_at, updated_at
           ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
        ).bind(otherOrganisationId, racingPersonId),
      ]);
    });
    const racingCrm = new CrmService(racingEnv);
    const csv = [
      "name,email",
      `Safe contact,${safeEmail}`,
      `Racing contact,${racingEmail}`,
    ].join("\n");

    await expect(
      racingCrm.confirmImport(administrator, csv),
    ).rejects.toMatchObject({
      message: expect.stringContaining("connect them through an event"),
      status: 409,
    });
    const currentOrganisationContacts = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM organisation_contacts
        WHERE organisation_id = ? AND person_id IN (
          SELECT id FROM people WHERE email IN (?, ?)
        )`,
    )
      .bind(administrator.organisationId, safeEmail, racingEmail)
      .first<{ count: number }>();
    expect(Number(currentOrganisationContacts?.count)).toBe(0);
    await expect(
      testEnv.DB.prepare("SELECT 1 FROM people WHERE email = ?")
        .bind(safeEmail)
        .first(),
    ).resolves.toBeNull();
  });

  it("refuses a manual link when an unrelated global identity appears after validation", async () => {
    const { testEnv } = await service();
    const suffix = crypto.randomUUID();
    const otherOrganisationId = `racing-manual-org-${suffix}`;
    const racingPersonId = `racing-manual-person-${suffix}`;
    const email = `racing-manual-${suffix}@example.com`;
    await testEnv.DB.prepare(
      "INSERT INTO organisations (id, name, slug) VALUES (?, 'Race owner', ?)",
    )
      .bind(otherOrganisationId, otherOrganisationId)
      .run();
    const racingEnv = withNextBatchRace(testEnv, async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (id, email, display_name, biography)
           VALUES (?, ?, 'Unrelated identity', 'Private existing biography')`,
        ).bind(racingPersonId, email),
        testEnv.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_at, updated_at
           ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
        ).bind(otherOrganisationId, racingPersonId),
      ]);
    });
    const racingCrm = new CrmService(racingEnv);

    await expect(
      racingCrm.createContact(administrator, {
        name: "Attempted replacement",
        email,
        jobTitle: "",
        organisationName: "",
        biography: "Attempted replacement biography",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("connect them through an event"),
      status: 409,
    });
    await expect(
      testEnv.DB.prepare(`SELECT biography FROM people WHERE id = ?`)
        .bind(racingPersonId)
        .first(),
    ).resolves.toEqual({ biography: "Private existing biography" });
    await expect(
      testEnv.DB.prepare(
        `SELECT 1 FROM organisation_contacts
          WHERE organisation_id = ? AND person_id = ?`,
      )
        .bind(administrator.organisationId, racingPersonId)
        .first(),
    ).resolves.toBeNull();
  });

  it("surfaces a missing post-creation contact as an invariant failure", async () => {
    const { testEnv } = await service();
    const email = `missing-created-contact-${crypto.randomUUID()}@example.com`;
    const racingEnv = withNextPostBatchRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `DELETE FROM organisation_contacts
          WHERE organisation_id = ? AND person_id = (
            SELECT id FROM people WHERE email = ? COLLATE NOCASE
          )`,
      )
        .bind(administrator.organisationId, email)
        .run();
    });
    const racingCrm = new CrmService(racingEnv);

    let failure: unknown;
    try {
      await racingCrm.createContact(administrator, {
        name: "Missing created contact",
        email,
        jobTitle: "",
        organisationName: "",
        biography: "",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CrmStateError);
    expect((failure as Error).message).toBe(
      "The Speaker Network contact identity was missing after creation.",
    );
  });

  it("rolls back a CSV import when an existing contact is merged after validation", async () => {
    const { testEnv } = await service();
    const suffix = crypto.randomUUID();
    const primaryPersonId = `merge-race-primary-${suffix}`;
    const secondaryPersonId = `merge-race-secondary-${suffix}`;
    const secondaryEmail = `merge-race-secondary-${suffix}@example.com`;
    const safeEmail = `merge-race-safe-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Primary contact')",
      ).bind(primaryPersonId, `merge-race-primary-${suffix}@example.com`),
      testEnv.DB.prepare(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Secondary contact')",
      ).bind(secondaryPersonId, secondaryEmail),
      ...[primaryPersonId, secondaryPersonId].map((personId) =>
        testEnv.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_at, updated_at
           ) VALUES (?, ?, 'manual', 'active', unixepoch(), unixepoch())`,
        ).bind(administrator.organisationId, personId),
      ),
    ]);
    const racingEnv = withNextBatchRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `UPDATE organisation_contacts
            SET status = 'merged', merged_into_person_id = ?,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND person_id = ? AND status = 'active'`,
      )
        .bind(primaryPersonId, administrator.organisationId, secondaryPersonId)
        .run();
    });
    const racingCrm = new CrmService(racingEnv);

    await expect(
      racingCrm.confirmImport(
        administrator,
        [
          "name,email",
          `Safe contact,${safeEmail}`,
          `Secondary contact,${secondaryEmail}`,
        ].join("\n"),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("connect them through an event"),
      status: 409,
    });
    await expect(
      testEnv.DB.prepare("SELECT 1 FROM people WHERE email = ?")
        .bind(safeEmail)
        .first(),
    ).resolves.toBeNull();
  });

  it("rejects malformed, oversized and duplicate-row CSV imports", async () => {
    const { crm } = await service();
    await expect(
      crm.previewImport(
        administrator,
        'name,email\n"Unclosed,broken@example.com',
      ),
    ).rejects.toMatchObject({
      message: "The CSV file ends inside a quoted field.",
      status: 422,
    });
    await expect(
      crm.previewImport(
        administrator,
        `name,email,bio\nLarge,large@example.com,${"x".repeat(512_000)}`,
      ),
    ).rejects.toMatchObject({
      message: "Speaker Network CSV files cannot exceed 512 KB.",
      status: 422,
    });

    const preview = await crm.previewImport(
      administrator,
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

  it("previews more contacts than one D1 parameter window", async () => {
    const { crm } = await service();
    const suffix = crypto.randomUUID();
    const rows = Array.from(
      { length: 120 },
      (_, index) =>
        `Contact ${index},parameter-window-${index}-${suffix}@example.com`,
    );

    const preview = await crm.previewImport(
      administrator,
      ["name,email", ...rows].join("\n"),
    );

    expect(preview.valid).toHaveLength(120);
    expect(preview.invalid).toEqual([]);
  });
});

import { z } from "zod";

import {
  createCrmContactSchema,
  crmFiltersSchema,
  crmPersonIdSchema,
  type CrmFilters,
} from "./crm-schema";
import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";
import {
  CONTACT_IDENTITY_INVARIANT_MESSAGE,
  CONTACT_RELATIONSHIP_REQUIRED_MESSAGE,
  contactScopeBindings,
  contactScopeCte,
  existingPersonOrganisationRelationshipSql,
  isContactRelationshipConstraint,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "./crm-contact-scope.server";
import { CrmStateError } from "./crm-errors";
import { CrmImportService } from "./crm-import-service.server";
import { CrmMergeService } from "./crm-merge-service.server";
import { CrmOutreachService } from "./crm-outreach-service.server";
import { CrmPipelineService } from "./crm-pipeline-service.server";

const PAGE_SIZE = 100;

export type CrmContactListItem = {
  personId: string;
  name: string;
  email: string;
  jobTitle: string | null;
  organisationName: string | null;
  biography: string | null;
  tags: string[];
  eventCount: number;
  sessionCount: number;
  duplicateCount: number;
};

type ContactListRow = Omit<CrmContactListItem, "tags"> & {
  tagsJson: string;
};

export { CrmStateError } from "./crm-errors";

export class CrmService {
  private readonly imports: CrmImportService;
  private readonly merges: CrmMergeService;
  private readonly pipeline: CrmPipelineService;
  private readonly outreach: CrmOutreachService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.imports = new CrmImportService(env);
    this.merges = new CrmMergeService(env, (viewer, personId) =>
      this.ensureExplicitContact(viewer, personId),
    );
    this.pipeline = new CrmPipelineService(env, (viewer, personId) =>
      this.ensureExplicitContact(viewer, personId),
    );
    this.outreach = new CrmOutreachService(env, (viewer, personId) =>
      this.getContact(viewer, personId),
    );
  }

  private async requireLinkableExistingEmails(
    viewer: OrganisationAdministrator,
    emails: string[],
  ) {
    if ((await unavailableExistingEmails(this.env, viewer, emails)).size) {
      throw new CrmStateError(CONTACT_RELATIONSHIP_REQUIRED_MESSAGE, 409);
    }
  }

  async listDirectory(
    viewer: OrganisationAdministrator,
    rawFilters: unknown,
    rawPage = 1,
  ) {
    const filters = crmFiltersSchema.parse(rawFilters);
    const page = z.number().int().positive().parse(rawPage);
    const search = `%${filters.query}%`;
    const rows = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id AS personId, person.display_name AS name, person.email,
              person.job_title AS jobTitle,
              person.organisation_name AS organisationName,
              person.biography,
              COALESCE((
                SELECT json_group_array(tagged.tag)
                  FROM (
                    SELECT tag FROM organisation_contact_tags
                     WHERE organisation_id = ? AND person_id = person.id
                     ORDER BY tag COLLATE NOCASE
                  ) tagged
              ), '[]') AS tagsJson,
              (SELECT COUNT(DISTINCT linked.event_id)
                 FROM (
                   SELECT membership.event_id
                     FROM memberships membership
                     JOIN events event ON event.id = membership.event_id
                    WHERE membership.person_id = person.id
                      AND membership.organisation_id = ?
                      AND membership.event_id IS NOT NULL
                      AND event.organisation_id = membership.organisation_id
                      AND event.activation_status = 'active'
                      AND membership.role = 'speaker'
                      AND membership.accepted_at IS NOT NULL
                      AND membership.revoked_at IS NULL
                   UNION
                   SELECT speaker.event_id
                     FROM session_speakers speaker
                     JOIN events event ON event.id = speaker.event_id
                    WHERE speaker.person_id = person.id
                      AND event.organisation_id = ?
                      AND event.activation_status = 'active'
                 ) linked) AS eventCount,
              (SELECT COUNT(*) FROM session_speakers speaker
                JOIN events event ON event.id = speaker.event_id
               WHERE speaker.person_id = person.id
                 AND event.organisation_id = ?
                 AND event.activation_status = 'active') AS sessionCount,
              (SELECT COUNT(*) FROM organisation_contact_ids candidate
                JOIN people duplicate ON duplicate.id = candidate.person_id
               WHERE candidate.person_id <> person.id
                 AND lower(trim(duplicate.display_name)) = lower(trim(person.display_name))) AS duplicateCount
         FROM organisation_contact_ids scoped
         JOIN people person ON person.id = scoped.person_id
        WHERE (? = '%%' OR person.display_name LIKE ? OR person.email LIKE ?
               OR COALESCE(person.organisation_name, '') LIKE ?
               OR COALESCE(person.job_title, '') LIKE ?)
          AND (? = '' OR person.organisation_name = ? COLLATE NOCASE)
          AND (? = '' OR person.job_title = ? COLLATE NOCASE)
          AND (? = '' OR EXISTS (
            SELECT 1 FROM organisation_contact_tags tag
             WHERE tag.organisation_id = ? AND tag.person_id = person.id
               AND tag.tag = ? COLLATE NOCASE
          ))
          AND NOT EXISTS (
            SELECT 1 FROM organisation_contacts hidden
             WHERE hidden.organisation_id = ? AND hidden.person_id = person.id
               AND hidden.status = 'merged'
          )
        ORDER BY person.display_name COLLATE NOCASE, person.id
        LIMIT ? OFFSET ?`,
    )
      .bind(
        ...contactScopeBindings(viewer),
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        search,
        search,
        search,
        search,
        search,
        filters.company,
        filters.company,
        filters.jobTitle,
        filters.jobTitle,
        filters.tag,
        viewer.organisationId,
        filters.tag,
        viewer.organisationId,
        PAGE_SIZE + 1,
        (page - 1) * PAGE_SIZE,
      )
      .all<ContactListRow>();
    const contacts = rows.results.slice(0, PAGE_SIZE).map((row) => ({
      ...row,
      tags: z.array(z.string()).parse(JSON.parse(row.tagsJson)),
      tagsJson: undefined,
      eventCount: Number(row.eventCount),
      sessionCount: Number(row.sessionCount),
      duplicateCount: Number(row.duplicateCount),
    }));
    const facets = await this.directoryFacets(viewer);
    const segments = await this.listSegments(viewer);
    return {
      contacts,
      filters,
      facets,
      segments,
      page,
      hasNext: rows.results.length > PAGE_SIZE,
    };
  }

  async dashboard(viewer: OrganisationAdministrator) {
    const summary = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT (SELECT COUNT(*) FROM organisation_contact_ids) AS totalContacts,
              (SELECT COUNT(*) FROM events
                WHERE organisation_id = ? AND activation_status = 'active') AS eventCount,
              (SELECT COUNT(*) FROM (
                SELECT contact.person_id
                  FROM organisation_contact_ids contact
                  JOIN (
                    SELECT speaker.person_id, COUNT(DISTINCT speaker.event_id) AS eventCount
                      FROM session_speakers speaker
                      JOIN events event ON event.id = speaker.event_id
                     WHERE event.organisation_id = ?
                       AND event.activation_status = 'active'
                     GROUP BY speaker.person_id
                  ) history ON history.person_id = contact.person_id
                 WHERE history.eventCount > 1
              )) AS returningSpeakers`,
    )
      .bind(
        ...contactScopeBindings(viewer),
        viewer.organisationId,
        viewer.organisationId,
      )
      .first<{
        totalContacts: number;
        eventCount: number;
        returningSpeakers: number;
      }>();
    if (!summary)
      throw new Error("The Speaker Network dashboard could not be read.");
    const companies = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.organisation_name AS name, COUNT(*) AS contacts
         FROM organisation_contact_ids contact
         JOIN people person ON person.id = contact.person_id
        WHERE person.organisation_name IS NOT NULL
          AND trim(person.organisation_name) <> ''
        GROUP BY person.organisation_name
        ORDER BY contacts DESC, name COLLATE NOCASE
        LIMIT 6`,
    )
      .bind(...contactScopeBindings(viewer))
      .all<{ name: string; contacts: number }>();
    return {
      totalContacts: Number(summary.totalContacts),
      eventCount: Number(summary.eventCount),
      returningSpeakers: Number(summary.returningSpeakers),
      companies: companies.results.map((company) => ({
        ...company,
        contacts: Number(company.contacts),
      })),
    };
  }

  async listContactsById(
    viewer: OrganisationAdministrator,
    rawPersonIds: unknown,
  ) {
    const personIds = [
      ...new Set(z.array(crmPersonIdSchema).max(500).parse(rawPersonIds)),
    ];
    if (!personIds.length) return [];
    const placeholders = personIds.map(() => "?").join(",");
    const rows = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id AS personId, person.display_name AS name, person.email,
              person.organisation_name AS organisationName
         FROM organisation_contact_ids scoped
         JOIN people person ON person.id = scoped.person_id
        WHERE person.id IN (${placeholders})
        ORDER BY person.display_name COLLATE NOCASE, person.id`,
    )
      .bind(...contactScopeBindings(viewer), ...personIds)
      .all<{
        personId: string;
        name: string;
        email: string;
        organisationName: string | null;
      }>();
    return rows.results;
  }

  private async directoryFacets(viewer: OrganisationAdministrator) {
    const [companies, titles, tags] = await Promise.all([
      this.env.DB.prepare(
        `${contactScopeCte} SELECT DISTINCT person.organisation_name AS value
           FROM organisation_contact_ids contact JOIN people person ON person.id = contact.person_id
          WHERE person.organisation_name IS NOT NULL AND trim(person.organisation_name) <> ''
          ORDER BY value COLLATE NOCASE`,
      )
        .bind(...contactScopeBindings(viewer))
        .all<{ value: string }>(),
      this.env.DB.prepare(
        `${contactScopeCte} SELECT DISTINCT person.job_title AS value
           FROM organisation_contact_ids contact JOIN people person ON person.id = contact.person_id
          WHERE person.job_title IS NOT NULL AND trim(person.job_title) <> ''
          ORDER BY value COLLATE NOCASE`,
      )
        .bind(...contactScopeBindings(viewer))
        .all<{ value: string }>(),
      this.env.DB.prepare(
        `SELECT DISTINCT tag AS value FROM organisation_contact_tags
          WHERE organisation_id = ? ORDER BY tag COLLATE NOCASE`,
      )
        .bind(viewer.organisationId)
        .all<{ value: string }>(),
    ]);
    return {
      companies: companies.results.map((row) => row.value),
      jobTitles: titles.results.map((row) => row.value),
      tags: tags.results.map((row) => row.value),
    };
  }

  async getContact(viewer: OrganisationAdministrator, rawPersonId: unknown) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const contact = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id AS personId, person.display_name AS name, person.email,
              person.job_title AS jobTitle, person.organisation_name AS organisationName,
              person.biography, person.image_url AS imageUrl,
              person.profile_status AS profileStatus,
              (SELECT COUNT(*) FROM organisation_contact_ids duplicate
                JOIN people other ON other.id = duplicate.person_id
               WHERE duplicate.person_id <> person.id
                 AND lower(trim(other.display_name)) = lower(trim(person.display_name))) AS duplicateCount
         FROM organisation_contact_ids scoped
         JOIN people person ON person.id = scoped.person_id
        WHERE person.id = ?
          AND NOT EXISTS (SELECT 1 FROM organisation_contacts hidden
            WHERE hidden.organisation_id = ? AND hidden.person_id = person.id
              AND hidden.status = 'merged')`,
    )
      .bind(...contactScopeBindings(viewer), personId, viewer.organisationId)
      .first<{
        personId: string;
        name: string;
        email: string;
        jobTitle: string | null;
        organisationName: string | null;
        biography: string | null;
        imageUrl: string | null;
        profileStatus: string;
        duplicateCount: number;
      }>();
    if (!contact)
      throw new Response("Speaker Network contact not found.", { status: 404 });
    const [tags, notes, connections, duplicateRows, pipeline] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT tag FROM organisation_contact_tags
          WHERE organisation_id = ? AND person_id = ? ORDER BY tag COLLATE NOCASE`,
        )
          .bind(viewer.organisationId, personId)
          .all<{ tag: string }>(),
        this.env.DB.prepare(
          `SELECT note.id, note.body, note.created_at AS createdAt,
                author.display_name AS authorName
           FROM organisation_contact_notes note
           JOIN people author ON author.id = note.author_person_id
          WHERE note.organisation_id = ? AND note.person_id = ?
          ORDER BY note.created_at DESC, note.id DESC`,
        )
          .bind(viewer.organisationId, personId)
          .all<{
            id: string;
            body: string;
            createdAt: number;
            authorName: string;
          }>(),
        this.env.DB.prepare(
          `SELECT event.id AS eventId, event.name AS eventName,
                MIN(session.title) AS firstSessionTitle,
                COUNT(DISTINCT speaker.session_id) AS sessionCount
           FROM events event
           LEFT JOIN session_speakers speaker
             ON speaker.event_id = event.id AND speaker.person_id = ?
           LEFT JOIN sessions session
             ON session.id = speaker.session_id AND session.event_id = speaker.event_id
          WHERE event.organisation_id = ?
            AND event.activation_status = 'active'
            AND (speaker.person_id IS NOT NULL OR EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.organisation_id = event.organisation_id
                 AND membership.event_id = event.id AND membership.person_id = ?
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NOT NULL
                 AND membership.revoked_at IS NULL
            ))
          GROUP BY event.id, event.name
          ORDER BY event.starts_at DESC, event.name`,
        )
          .bind(personId, viewer.organisationId, personId)
          .all<{
            eventId: string;
            eventName: string;
            firstSessionTitle: string | null;
            sessionCount: number;
          }>(),
        this.env.DB.prepare(
          `${contactScopeCte}
         SELECT person.id AS personId, person.display_name AS name, person.email,
                person.organisation_name AS organisationName,
                person.job_title AS jobTitle
           FROM organisation_contact_ids scoped
           JOIN people person ON person.id = scoped.person_id
          WHERE person.id <> ?
            AND lower(trim(person.display_name)) = lower(trim(?))
            AND NOT EXISTS (SELECT 1 FROM organisation_contacts hidden
              WHERE hidden.organisation_id = ? AND hidden.person_id = person.id
                AND hidden.status = 'merged')
          ORDER BY person.email`,
        )
          .bind(
            ...contactScopeBindings(viewer),
            personId,
            contact.name,
            viewer.organisationId,
          )
          .all<{
            personId: string;
            name: string;
            email: string;
            organisationName: string | null;
            jobTitle: string | null;
          }>(),
        this.getPipelineEntry(viewer, personId),
      ]);
    return {
      ...contact,
      duplicateCount: Number(contact.duplicateCount),
      tags: tags.results.map((row) => row.tag),
      notes: notes.results,
      connections: connections.results.map((connection) => ({
        ...connection,
        sessionCount: Number(connection.sessionCount),
      })),
      duplicates: duplicateRows.results,
      pipeline,
    };
  }

  private async ensureExplicitContact(
    viewer: OrganisationAdministrator,
    personId: string,
    source: "event" | "import" | "manual" = "event",
  ) {
    const result = await this.env.DB.prepare(
      `${contactScopeCte}
       INSERT INTO organisation_contacts (
         organisation_id, person_id, source, status, created_by_person_id,
         created_at, updated_at
       )
       SELECT ?, person.id, ?, 'active', ?, unixepoch(), unixepoch()
         FROM people person
        WHERE person.id = ?
          AND EXISTS (SELECT 1 FROM organisation_contact_ids WHERE person_id = person.id)
       ON CONFLICT(organisation_id, person_id) DO UPDATE SET
         status = 'active', merged_into_person_id = NULL, updated_at = unixepoch()
       WHERE organisation_contacts.status = 'active'`,
    )
      .bind(
        ...contactScopeBindings(viewer),
        viewer.organisationId,
        source,
        viewer.personId,
        personId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      const exists = await this.env.DB.prepare(
        `SELECT 1 FROM organisation_contacts
          WHERE organisation_id = ? AND person_id = ? AND status = 'active'`,
      )
        .bind(viewer.organisationId, personId)
        .first();
      if (!exists)
        throw new Response("Speaker Network contact not found.", {
          status: 404,
        });
    }
  }

  async createContact(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = createCrmContactSchema.parse(rawInput);
    await this.requireLinkableExistingEmails(viewer, [input.email]);
    const personId = crypto.randomUUID();
    let created: D1Result;
    let linked: D1Result;
    let audit: D1Result;
    try {
      [created, linked, audit] = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, biography,
             organisation_name, job_title, profile_status, created_at, updated_at
           ) VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', unixepoch(), unixepoch())
           ON CONFLICT(email) DO NOTHING`,
        ).bind(
          personId,
          input.email,
          input.name,
          input.biography || null,
          input.organisationName || null,
          input.jobTitle || null,
        ),
        this.env.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_by_person_id,
             created_at, updated_at
           ) VALUES (
             ?,
             (SELECT person.id FROM people person
               WHERE person.email = ? COLLATE NOCASE
                 AND (person.id = ? OR ${existingPersonOrganisationRelationshipSql})),
             'manual', 'active', ?, unixepoch(), unixepoch()
           )
           ON CONFLICT(organisation_id, person_id) DO UPDATE SET
             updated_at = unixepoch()
           WHERE organisation_contacts.status = 'active'`,
        ).bind(
          viewer.organisationId,
          input.email,
          personId,
          ...organisationRelationshipBindings(viewer),
          viewer.personId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           ) SELECT ?, ?, NULL, ?, 'crm.contact.created', 'person', person.id,
                    json_object('email', person.email), unixepoch()
               FROM people person WHERE person.email = ? COLLATE NOCASE
                 AND EXISTS (
                   SELECT 1 FROM organisation_contacts contact
                    WHERE contact.organisation_id = ?
                      AND contact.person_id = person.id
                      AND contact.status = 'active'
                 )`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.personId,
          input.email,
          viewer.organisationId,
        ),
      ]);
    } catch (error) {
      if (isContactRelationshipConstraint(error)) {
        throw new CrmStateError(CONTACT_RELATIONSHIP_REQUIRED_MESSAGE, 409);
      }
      throw error;
    }
    const resolved = await this.env.DB.prepare(
      `SELECT contact.person_id AS personId, contact.status,
              contact.merged_into_person_id AS mergedIntoPersonId,
              primary_contact.display_name AS mergedIntoName,
              primary_contact.email AS mergedIntoEmail
         FROM people person
         JOIN organisation_contacts contact ON contact.person_id = person.id
         LEFT JOIN people primary_contact
           ON primary_contact.id = contact.merged_into_person_id
        WHERE person.email = ? COLLATE NOCASE AND contact.organisation_id = ?`,
    )
      .bind(input.email, viewer.organisationId)
      .first<{
        personId: string;
        status: "active" | "merged";
        mergedIntoPersonId: string | null;
        mergedIntoName: string | null;
        mergedIntoEmail: string | null;
      }>();
    if (!resolved) {
      throw new Error(CONTACT_IDENTITY_INVARIANT_MESSAGE);
    }
    if (resolved.status === "merged") {
      if (
        !resolved.mergedIntoPersonId ||
        !resolved.mergedIntoName ||
        !resolved.mergedIntoEmail
      ) {
        throw new Error(CONTACT_IDENTITY_INVARIANT_MESSAGE);
      }
      throw new CrmStateError(
        `This email belongs to a merged contact. Use ${resolved.mergedIntoName} (${resolved.mergedIntoEmail}) instead.`,
        409,
      );
    }
    if ((linked.meta.changes ?? 0) !== 1 || (audit.meta.changes ?? 0) !== 1) {
      throw new Error("The Speaker Network contact could not be created.");
    }
    return {
      personId: resolved.personId,
      identityCreated: (created.meta.changes ?? 0) === 1,
    };
  }

  async addNote(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawBody: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const body = z.string().trim().min(1).max(5_000).parse(rawBody);
    await this.ensureExplicitContact(viewer, personId);
    const result = await this.env.DB.prepare(
      `INSERT INTO organisation_contact_notes (
         id, organisation_id, person_id, author_person_id, body, created_at
       ) VALUES (?, ?, ?, ?, ?, unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        personId,
        viewer.personId,
        body,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new Error("The contact note could not be saved.");
  }

  async addTag(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawTag: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const tag = z.string().trim().min(1).max(40).parse(rawTag);
    await this.ensureExplicitContact(viewer, personId);
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO organisation_contact_tags (
         organisation_id, person_id, tag, created_by_person_id, created_at
       ) VALUES (?, ?, ?, ?, unixepoch())`,
    )
      .bind(viewer.organisationId, personId, tag, viewer.personId)
      .run();
  }

  async removeTag(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawTag: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const tag = z.string().trim().min(1).max(40).parse(rawTag);
    await this.env.DB.prepare(
      `DELETE FROM organisation_contact_tags
        WHERE organisation_id = ? AND person_id = ? AND tag = ? COLLATE NOCASE`,
    )
      .bind(viewer.organisationId, personId, tag)
      .run();
  }

  async saveSegment(
    viewer: OrganisationAdministrator,
    rawName: unknown,
    rawFilters: unknown,
  ) {
    const name = z.string().trim().min(2).max(80).parse(rawName);
    const filters = crmFiltersSchema.parse(rawFilters);
    try {
      await this.env.DB.prepare(
        `INSERT INTO crm_segments (
           id, organisation_id, owner_person_id, name, filters_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
      )
        .bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.personId,
          name,
          JSON.stringify(filters),
        )
        .run();
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: crm_segments/i.test(error.message)
      ) {
        throw new CrmStateError(
          "A Speaker Network segment with that name already exists.",
        );
      }
      throw error;
    }
  }

  async listSegments(viewer: OrganisationAdministrator) {
    const rows = await this.env.DB.prepare(
      `SELECT id, name, filters_json AS filtersJson, updated_at AS updatedAt
         FROM crm_segments
        WHERE organisation_id = ? AND owner_person_id = ?
        ORDER BY updated_at DESC, name COLLATE NOCASE`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .all<{
        id: string;
        name: string;
        filtersJson: string;
        updatedAt: number;
      }>();
    return rows.results.map(({ filtersJson, ...row }) => ({
      ...row,
      filters: crmFiltersSchema.parse(JSON.parse(filtersJson)),
    }));
  }

  async getSegment(viewer: OrganisationAdministrator, rawId: unknown) {
    const id = z.string().trim().min(1).max(200).parse(rawId);
    const row = await this.env.DB.prepare(
      `SELECT name, filters_json AS filtersJson FROM crm_segments
        WHERE id = ? AND organisation_id = ? AND owner_person_id = ?`,
    )
      .bind(id, viewer.organisationId, viewer.personId)
      .first<{ name: string; filtersJson: string }>();
    if (!row)
      throw new Response("Speaker Network segment not found.", { status: 404 });
    return {
      id,
      name: row.name,
      filters: crmFiltersSchema.parse(JSON.parse(row.filtersJson)),
    };
  }

  async previewImport(viewer: OrganisationAdministrator, rawCsv: string) {
    return this.imports.preview(viewer, rawCsv);
  }

  async confirmImport(viewer: OrganisationAdministrator, rawCsv: string) {
    return this.imports.confirm(viewer, rawCsv);
  }

  async mergeContacts(
    viewer: OrganisationAdministrator,
    rawPrimaryId: unknown,
    rawSecondaryId: unknown,
  ) {
    return this.merges.merge(viewer, rawPrimaryId, rawSecondaryId);
  }
  async listPipeline(viewer: OrganisationAdministrator) {
    return this.pipeline.list(viewer);
  }

  async getPipelineEntry(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
  ) {
    return this.pipeline.get(viewer, rawPersonId);
  }

  async enrollPipeline(viewer: OrganisationAdministrator, rawInput: unknown) {
    return this.pipeline.enroll(viewer, rawInput);
  }

  async movePipelineEntry(
    viewer: OrganisationAdministrator,
    rawInput: unknown,
  ) {
    return this.pipeline.move(viewer, rawInput);
  }

  async addPipelineNote(viewer: OrganisationAdministrator, rawInput: unknown) {
    return this.pipeline.addNote(viewer, rawInput);
  }

  async listEvents(viewer: OrganisationAdministrator) {
    return this.outreach.listEvents(viewer);
  }

  async addContactToEvent(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawEventId: unknown,
    rawIdempotencyKey: unknown,
  ) {
    return this.outreach.addContactToEvent(
      viewer,
      rawPersonId,
      rawEventId,
      rawIdempotencyKey,
    );
  }

  async createOutreachDraft(
    viewer: OrganisationAdministrator,
    rawInput: unknown,
  ) {
    return this.outreach.createDraft(viewer, rawInput);
  }
}

export type { CrmFilters };

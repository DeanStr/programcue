import { z } from "zod";

import {
  createCrmContactSchema,
  crmFiltersSchema,
  crmPersonIdSchema,
  crmStageSchema,
  crmStages,
  type CrmFilters,
  type CrmStage,
} from "./crm-schema";
import { CommunicationDraftService } from "~/modules/communications/communication-draft-service.server";
import { CommunicationTemplateService } from "~/modules/communications/communication-template-service.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import { CsvParseError, parseCsv } from "~/platform/operations/csv";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";

const PAGE_SIZE = 100;
const IMPORT_BYTES_LIMIT = 512_000;

const contactScopeCte = `WITH candidate_contact_ids(person_id) AS (
  SELECT contact.person_id
    FROM organisation_contacts contact
   WHERE contact.organisation_id = ? AND contact.status = 'active'
  UNION
  SELECT membership.person_id
    FROM memberships membership
   WHERE membership.organisation_id = ? AND membership.role = 'speaker'
     AND membership.accepted_at IS NOT NULL AND membership.revoked_at IS NULL
  UNION
  SELECT speaker.person_id
    FROM session_speakers speaker
    JOIN events event ON event.id = speaker.event_id
   WHERE event.organisation_id = ?
  UNION
  SELECT speaker.person_id
    FROM submission_speakers speaker
    JOIN events event ON event.id = speaker.event_id
   WHERE event.organisation_id = ? AND speaker.person_id IS NOT NULL
), organisation_contact_ids(person_id) AS (
  SELECT candidate.person_id
    FROM candidate_contact_ids candidate
   WHERE NOT EXISTS (
     SELECT 1 FROM organisation_contacts merged
      WHERE merged.organisation_id = ? AND merged.person_id = candidate.person_id
        AND merged.status = 'merged'
   )
)`;

function scopeBindings(viewer: OrganisationAdministrator) {
  return Array(5).fill(viewer.organisationId);
}

function displayStage(stage: CrmStage) {
  return stage.replace(/^./, (letter) => letter.toUpperCase());
}

async function outreachOperationIds(
  organisationId: string,
  eventId: string,
  idempotencyKey: string,
) {
  const root = `crm.outreach:${organisationId}:${eventId}:${idempotencyKey}`;
  const deterministicUuid = async (label: string) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${root}:${label}`),
    );
    const bytes = new Uint8Array(digest).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const [operationId, templateId, versionId, auditId, draftId] =
    await Promise.all(
      ["operation", "template", "version", "audit", "draft"].map(
        deterministicUuid,
      ),
    );
  return {
    operationId: operationId!,
    templateId: templateId!,
    versionId: versionId!,
    auditId: auditId!,
    draftId: draftId!,
  };
}

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

export class CrmStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "CrmStateError";
  }
}

export class CrmService {
  constructor(private readonly env: CloudflareEnvironment) {}

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
                    WHERE membership.person_id = person.id
                      AND membership.organisation_id = ?
                      AND membership.event_id IS NOT NULL
                      AND membership.role = 'speaker'
                      AND membership.accepted_at IS NOT NULL
                      AND membership.revoked_at IS NULL
                   UNION
                   SELECT speaker.event_id
                     FROM session_speakers speaker
                     JOIN events event ON event.id = speaker.event_id
                    WHERE speaker.person_id = person.id
                      AND event.organisation_id = ?
                 ) linked) AS eventCount,
              (SELECT COUNT(*) FROM session_speakers speaker
                JOIN events event ON event.id = speaker.event_id
               WHERE speaker.person_id = person.id
                 AND event.organisation_id = ?) AS sessionCount,
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
        ...scopeBindings(viewer),
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
              (SELECT COUNT(*) FROM events WHERE organisation_id = ?) AS eventCount,
              (SELECT COUNT(*) FROM (
                SELECT contact.person_id
                  FROM organisation_contact_ids contact
                  JOIN (
                    SELECT speaker.person_id, COUNT(DISTINCT speaker.event_id) AS eventCount
                      FROM session_speakers speaker
                      JOIN events event ON event.id = speaker.event_id
                     WHERE event.organisation_id = ?
                     GROUP BY speaker.person_id
                  ) history ON history.person_id = contact.person_id
                 WHERE history.eventCount > 1
              )) AS returningSpeakers`,
    )
      .bind(
        ...scopeBindings(viewer),
        viewer.organisationId,
        viewer.organisationId,
      )
      .first<{
        totalContacts: number;
        eventCount: number;
        returningSpeakers: number;
      }>();
    if (!summary) throw new Error("The CRM dashboard could not be read.");
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
      .bind(...scopeBindings(viewer))
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
      .bind(...scopeBindings(viewer), ...personIds)
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
        .bind(...scopeBindings(viewer))
        .all<{ value: string }>(),
      this.env.DB.prepare(
        `${contactScopeCte} SELECT DISTINCT person.job_title AS value
           FROM organisation_contact_ids contact JOIN people person ON person.id = contact.person_id
          WHERE person.job_title IS NOT NULL AND trim(person.job_title) <> ''
          ORDER BY value COLLATE NOCASE`,
      )
        .bind(...scopeBindings(viewer))
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
      .bind(...scopeBindings(viewer), personId, viewer.organisationId)
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
    if (!contact) throw new Response("CRM contact not found.", { status: 404 });
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
            ...scopeBindings(viewer),
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
        ...scopeBindings(viewer),
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
        throw new Response("CRM contact not found.", { status: 404 });
    }
  }

  async createContact(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = createCrmContactSchema.parse(rawInput);
    const personId = crypto.randomUUID();
    const [created, linked, audit] = await this.env.DB.batch([
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
         )
         SELECT ?, person.id, 'manual', 'active', ?, unixepoch(), unixepoch()
           FROM people person WHERE person.email = ? COLLATE NOCASE
         ON CONFLICT(organisation_id, person_id) DO UPDATE SET
           updated_at = unixepoch()
         WHERE organisation_contacts.status = 'active'`,
      ).bind(viewer.organisationId, viewer.personId, input.email),
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
    const resolved = await this.env.DB.prepare(
      `SELECT contact.person_id AS personId, contact.status,
              contact.merged_into_person_id AS mergedIntoPersonId
         FROM people person
         JOIN organisation_contacts contact ON contact.person_id = person.id
        WHERE person.email = ? COLLATE NOCASE AND contact.organisation_id = ?`,
    )
      .bind(input.email, viewer.organisationId)
      .first<{
        personId: string;
        status: "active" | "merged";
        mergedIntoPersonId: string | null;
      }>();
    if (!resolved) throw new Error("The CRM contact identity was not found.");
    if (resolved.status === "merged" && resolved.mergedIntoPersonId) {
      return { personId: resolved.mergedIntoPersonId, identityCreated: false };
    }
    if ((linked.meta.changes ?? 0) !== 1 || (audit.meta.changes ?? 0) !== 1) {
      throw new Error("The CRM contact could not be created.");
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
        throw new CrmStateError("A CRM segment with that name already exists.");
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
    if (!row) throw new Response("CRM segment not found.", { status: 404 });
    return {
      id,
      name: row.name,
      filters: crmFiltersSchema.parse(JSON.parse(row.filtersJson)),
    };
  }

  async previewImport(rawCsv: string) {
    if (new TextEncoder().encode(rawCsv).byteLength > IMPORT_BYTES_LIMIT) {
      throw new CrmStateError("CRM CSV files cannot exceed 512 KB.", 422);
    }
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(rawCsv);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw new CrmStateError(error.message, 422);
      }
      throw error;
    }
    const aliases = {
      name: ["name"],
      email: ["email"],
      jobTitle: ["title", "jobTitle", "job_title"],
      organisationName: ["company", "organisation", "organization"],
      biography: ["bio", "biography"],
    } as const;
    const mapping = Object.fromEntries(
      Object.entries(aliases).map(([field, candidates]) => [
        field,
        candidates.find((candidate) => parsed.headers.includes(candidate)) ??
          null,
      ]),
    ) as Record<keyof typeof aliases, string | null>;
    if (!mapping.name || !mapping.email) {
      throw new CrmStateError(
        "CSV contacts require name and email columns.",
        422,
      );
    }
    const valid: Array<
      z.infer<typeof createCrmContactSchema> & { rowNumber: number }
    > = [];
    const invalid: Array<{ rowNumber: number; errors: string[] }> = [];
    const emails = new Set<string>();
    parsed.rows.forEach((row, index) => {
      const candidate = createCrmContactSchema.safeParse({
        name: row[mapping.name!],
        email: row[mapping.email!],
        jobTitle: mapping.jobTitle ? row[mapping.jobTitle] : "",
        organisationName: mapping.organisationName
          ? row[mapping.organisationName]
          : "",
        biography: mapping.biography ? row[mapping.biography] : "",
      });
      if (candidate.success && emails.has(candidate.data.email)) {
        invalid.push({
          rowNumber: index + 2,
          errors: ["Email duplicates another row in this import."],
        });
      } else if (candidate.success) {
        emails.add(candidate.data.email);
        valid.push({ ...candidate.data, rowNumber: index + 2 });
      } else
        invalid.push({
          rowNumber: index + 2,
          errors: candidate.error.issues.map((issue) => issue.message),
        });
    });
    return { headers: parsed.headers, mapping, valid, invalid, csv: rawCsv };
  }

  async confirmImport(viewer: OrganisationAdministrator, rawCsv: string) {
    const preview = await this.previewImport(rawCsv);
    if (!preview.valid.length || preview.invalid.length) {
      throw new CrmStateError(
        "Resolve every invalid contact row before confirming the import.",
        422,
      );
    }
    const placeholders = preview.valid.map(() => "?").join(",");
    const merged = await this.env.DB.prepare(
      `SELECT person.email
         FROM organisation_contacts contact
         JOIN people person ON person.id = contact.person_id
        WHERE contact.organisation_id = ? AND contact.status = 'merged'
          AND lower(person.email) IN (${placeholders})
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        ...preview.valid.map((row) => row.email.toLowerCase()),
      )
      .first<{ email: string }>();
    if (merged) {
      throw new CrmStateError(
        `The import includes ${merged.email}, which belongs to a merged contact. Use the primary contact instead.`,
        422,
      );
    }
    const statements: D1PreparedStatement[] = [];
    for (const row of preview.valid) {
      const personId = crypto.randomUUID();
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, biography,
             organisation_name, job_title, profile_status, created_at, updated_at
           ) VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', unixepoch(), unixepoch())
           ON CONFLICT(email) DO NOTHING`,
        ).bind(
          personId,
          row.email,
          row.name,
          row.biography || null,
          row.organisationName || null,
          row.jobTitle || null,
        ),
        this.env.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_by_person_id,
             created_at, updated_at
           ) SELECT ?, person.id, 'import', 'active', ?, unixepoch(), unixepoch()
               FROM people person WHERE person.email = ? COLLATE NOCASE
           ON CONFLICT(organisation_id, person_id) DO UPDATE SET
             updated_at = unixepoch()
           WHERE organisation_contacts.status = 'active'`,
        ).bind(viewer.organisationId, viewer.personId, row.email),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, metadata_json, created_at
         ) VALUES (?, ?, NULL, ?, 'crm.contacts.imported', 'crm_import', ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        JSON.stringify({ count: preview.valid.length }),
      ),
    );
    await this.env.DB.batch(statements);
    return { imported: preview.valid.length };
  }

  async mergeContacts(
    viewer: OrganisationAdministrator,
    rawPrimaryId: unknown,
    rawSecondaryId: unknown,
  ) {
    const primaryId = crmPersonIdSchema.parse(rawPrimaryId);
    const secondaryId = crmPersonIdSchema.parse(rawSecondaryId);
    if (primaryId === secondaryId)
      throw new CrmStateError("Choose two different contacts to merge.", 422);
    const candidates = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id, person.display_name AS name
         FROM organisation_contact_ids scoped JOIN people person ON person.id = scoped.person_id
        WHERE person.id IN (?, ?)`,
    )
      .bind(...scopeBindings(viewer), primaryId, secondaryId)
      .all<{ id: string; name: string }>();
    if (
      candidates.results.length !== 2 ||
      candidates.results[0]!.name.trim().toLocaleLowerCase() !==
        candidates.results[1]!.name.trim().toLocaleLowerCase()
    ) {
      throw new CrmStateError(
        "Only two same-name contacts in this organisation can be merged.",
        422,
      );
    }
    const linked = await this.env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM memberships WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM submissions WHERE submitter_person_id = ?) OR
         EXISTS(SELECT 1 FROM submission_speakers WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM session_speakers WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM auth_accounts WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM auth_sessions WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM organisation_contacts
                  WHERE person_id = ? AND organisation_id <> ?
                    AND status = 'active') AS linked`,
    )
      .bind(
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        viewer.organisationId,
      )
      .first<{ linked: number }>();
    if (linked?.linked) {
      throw new CrmStateError(
        "The secondary identity is already linked to access, submissions, sessions, or another organisation and cannot be safely merged.",
      );
    }
    await this.ensureExplicitContact(viewer, primaryId);
    await this.ensureExplicitContact(viewer, secondaryId);
    const [marked] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE organisation_contacts
            SET status = 'merged', merged_into_person_id = ?, updated_at = unixepoch()
          WHERE organisation_id = ? AND person_id = ? AND status = 'active'
            AND NOT EXISTS (SELECT 1 FROM memberships WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submissions WHERE submitter_person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submission_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM session_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE person_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM organisation_contacts shared
               WHERE shared.person_id = ? AND shared.organisation_id <> ?
                 AND shared.status = 'active'
            )`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE people
            SET biography = CASE
                  WHEN biography IS NULL OR trim(biography) = ''
                  THEN (SELECT secondary.biography FROM people secondary WHERE secondary.id = ?)
                  ELSE biography
                END,
                organisation_name = CASE
                  WHEN organisation_name IS NULL OR trim(organisation_name) = ''
                  THEN (SELECT secondary.organisation_name FROM people secondary WHERE secondary.id = ?)
                  ELSE organisation_name
                END,
                job_title = CASE
                  WHEN job_title IS NULL OR trim(job_title) = ''
                  THEN (SELECT secondary.job_title FROM people secondary WHERE secondary.id = ?)
                  ELSE job_title
                END,
                updated_at = unixepoch()
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )
            AND NOT EXISTS (SELECT 1 FROM memberships WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submissions WHERE submitter_person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submission_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM session_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE person_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM organisation_contacts shared
               WHERE shared.person_id = ? AND shared.organisation_id <> ?
                 AND shared.status = 'active'
            )`,
      ).bind(
        secondaryId,
        secondaryId,
        secondaryId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
        primaryId,
        primaryId,
        primaryId,
        primaryId,
        primaryId,
        primaryId,
        primaryId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO organisation_contact_tags (
           organisation_id, person_id, tag, created_by_person_id, created_at
         ) SELECT organisation_id, ?, tag, created_by_person_id, created_at
             FROM organisation_contact_tags
            WHERE organisation_id = ? AND person_id = ?
              AND EXISTS (SELECT 1 FROM organisation_contacts merged
                WHERE merged.organisation_id = ? AND merged.person_id = ?
                  AND merged.status = 'merged'
                  AND merged.merged_into_person_id = ?)`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE organisation_contact_notes SET person_id = ?
          WHERE organisation_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM organisation_contacts merged
              WHERE merged.organisation_id = ? AND merged.person_id = ?
                AND merged.status = 'merged'
                AND merged.merged_into_person_id = ?)`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE crm_pipeline_activity
            SET pipeline_entry_id = (
              SELECT primary_entry.id FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
          WHERE organisation_id = ?
            AND pipeline_entry_id = (
              SELECT secondary_entry.id FROM crm_pipeline_entries secondary_entry
               WHERE secondary_entry.organisation_id = ?
                 AND secondary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `DELETE FROM crm_pipeline_entries
          WHERE organisation_id = ? AND person_id = ?
            AND EXISTS (
              SELECT 1 FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE crm_pipeline_entries SET person_id = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND person_id = ?
            AND NOT EXISTS (SELECT 1 FROM crm_pipeline_entries primary_entry
              WHERE primary_entry.organisation_id = ? AND primary_entry.person_id = ?)
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, NULL, ?, 'crm.contacts.merged', 'person', ?,
                  json_object('secondaryPersonId', ?), unixepoch()
            WHERE EXISTS (SELECT 1 FROM organisation_contacts
              WHERE organisation_id = ? AND person_id = ? AND status = 'merged'
                AND merged_into_person_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        primaryId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
    ]);
    if ((marked.meta.changes ?? 0) !== 1)
      throw new CrmStateError(
        "The contacts changed before they could be merged.",
      );
  }

  async listPipeline(viewer: OrganisationAdministrator) {
    const rows = await this.env.DB.prepare(
      `SELECT entry.id, entry.person_id AS personId, entry.stage, entry.score,
              entry.rationale, entry.revision, entry.updated_at AS updatedAt,
              person.display_name AS name, person.email,
              person.job_title AS jobTitle,
              person.organisation_name AS organisationName
         FROM crm_pipeline_entries entry
         JOIN organisation_contacts contact
           ON contact.organisation_id = entry.organisation_id
          AND contact.person_id = entry.person_id AND contact.status = 'active'
         JOIN people person ON person.id = entry.person_id
        WHERE entry.organisation_id = ?
        ORDER BY entry.updated_at DESC, person.display_name COLLATE NOCASE`,
    )
      .bind(viewer.organisationId)
      .all<{
        id: string;
        personId: string;
        stage: CrmStage;
        score: number | null;
        rationale: string | null;
        revision: number;
        updatedAt: number;
        name: string;
        email: string;
        jobTitle: string | null;
        organisationName: string | null;
      }>();
    return crmStages.map((stage) => ({
      stage,
      label: displayStage(stage),
      entries: rows.results.filter((entry) => entry.stage === stage),
    }));
  }

  async getPipelineEntry(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const entry = await this.env.DB.prepare(
      `SELECT id, stage, score, rationale, revision, created_at AS createdAt,
              updated_at AS updatedAt
         FROM crm_pipeline_entries
        WHERE organisation_id = ? AND person_id = ?`,
    )
      .bind(viewer.organisationId, personId)
      .first<{
        id: string;
        stage: CrmStage;
        score: number | null;
        rationale: string | null;
        revision: number;
        createdAt: number;
        updatedAt: number;
      }>();
    if (!entry) return null;
    const activity = await this.env.DB.prepare(
      `SELECT activity.id, activity.kind, activity.body,
              activity.from_stage AS fromStage, activity.to_stage AS toStage,
              activity.created_at AS createdAt,
              actor.display_name AS actorName
         FROM crm_pipeline_activity activity
         JOIN people actor ON actor.id = activity.actor_person_id
        WHERE activity.organisation_id = ? AND activity.pipeline_entry_id = ?
        ORDER BY activity.created_at DESC, activity.id DESC`,
    )
      .bind(viewer.organisationId, entry.id)
      .all<{
        id: string;
        kind: "note" | "stage_changed";
        body: string | null;
        fromStage: CrmStage | null;
        toStage: CrmStage | null;
        createdAt: number;
        actorName: string;
      }>();
    return { ...entry, activity: activity.results };
  }

  async enrollPipeline(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        personId: crmPersonIdSchema,
        stage: crmStageSchema.default("identified"),
        score: z.coerce.number().int().min(0).max(100).nullable().optional(),
        rationale: z.string().trim().max(2_000).default(""),
      })
      .parse(rawInput);
    await this.ensureExplicitContact(viewer, input.personId);
    const entryId = crypto.randomUUID();
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_entries (
           id, organisation_id, person_id, stage, score, rationale, revision,
           created_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())`,
      ).bind(
        entryId,
        viewer.organisationId,
        input.personId,
        input.stage,
        input.score ?? null,
        input.rationale || null,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_activity (
           id, organisation_id, pipeline_entry_id, actor_person_id,
           kind, from_stage, to_stage, created_at
         ) VALUES (?, ?, ?, ?, 'stage_changed', NULL, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        entryId,
        viewer.personId,
        input.stage,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1)
      throw new CrmStateError(
        "This contact is already enrolled in the pipeline.",
      );
  }

  async movePipelineEntry(
    viewer: OrganisationAdministrator,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        entryId: z.string().trim().min(1).max(200),
        stage: crmStageSchema,
        revision: z.coerce.number().int().positive(),
      })
      .parse(rawInput);
    const current = await this.env.DB.prepare(
      `SELECT stage FROM crm_pipeline_entries
        WHERE id = ? AND organisation_id = ? AND revision = ?`,
    )
      .bind(input.entryId, viewer.organisationId, input.revision)
      .first<{ stage: CrmStage }>();
    if (!current)
      throw new CrmStateError(
        "This pipeline card changed. Reload before moving it.",
      );
    if (current.stage === input.stage) return;
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE crm_pipeline_entries
            SET stage = ?, revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?`,
      ).bind(input.stage, input.entryId, viewer.organisationId, input.revision),
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_activity (
           id, organisation_id, pipeline_entry_id, actor_person_id,
           kind, from_stage, to_stage, created_at
         ) SELECT ?, ?, ?, ?, 'stage_changed', ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM crm_pipeline_entries
              WHERE id = ? AND organisation_id = ? AND revision = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        input.entryId,
        viewer.personId,
        current.stage,
        input.stage,
        input.entryId,
        viewer.organisationId,
        input.revision + 1,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new CrmStateError(
        "This pipeline card changed. Reload before moving it.",
      );
  }

  async addPipelineNote(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        entryId: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5_000),
      })
      .parse(rawInput);
    const result = await this.env.DB.prepare(
      `INSERT INTO crm_pipeline_activity (
         id, organisation_id, pipeline_entry_id, actor_person_id,
         kind, body, created_at
       ) SELECT ?, ?, entry.id, ?, 'note', ?, unixepoch()
           FROM crm_pipeline_entries entry
          WHERE entry.id = ? AND entry.organisation_id = ?`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        input.body,
        input.entryId,
        viewer.organisationId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new Response("Pipeline card not found.", { status: 404 });
  }

  async listEvents(viewer: OrganisationAdministrator) {
    const rows = await this.env.DB.prepare(
      `SELECT id, name, starts_at AS startsAt, ends_at AS endsAt
         FROM events WHERE organisation_id = ?
        ORDER BY starts_at DESC, name COLLATE NOCASE`,
    )
      .bind(viewer.organisationId)
      .all<{ id: string; name: string; startsAt: number; endsAt: number }>();
    return rows.results;
  }

  private eventViewer(
    viewer: OrganisationAdministrator,
    eventId: string,
  ): Viewer {
    return {
      personId: viewer.personId,
      name: viewer.name,
      email: viewer.email,
      role: viewer.role,
      organisationId: viewer.organisationId,
      eventId,
      demo: viewer.demo,
    };
  }

  async addContactToEvent(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawEventId: unknown,
    rawIdempotencyKey: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const eventId = z.string().trim().min(1).max(128).parse(rawEventId);
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Target event not found.", { status: 404 });
    const contact = await this.getContact(viewer, personId);
    await new SpeakerService(this.env).createManualSpeaker(
      this.eventViewer(viewer, eventId),
      {
        idempotencyKey: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/)
          .parse(rawIdempotencyKey),
        name: contact.name,
        email: contact.email,
        biography: contact.biography ?? "",
        organisationName: contact.organisationName ?? "",
        jobTitle: contact.jobTitle ?? "",
      },
    );
    return { eventId };
  }

  async createOutreachDraft(
    viewer: OrganisationAdministrator,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        personIds: z.array(crmPersonIdSchema).min(2).max(500),
        eventId: z.string().trim().min(1).max(128),
        idempotencyKey: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/),
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(100_000),
        physicalAddress: z.string().trim().min(1).max(500),
      })
      .parse(rawInput);
    const uniquePersonIds = [...new Set(input.personIds)];
    if (uniquePersonIds.length < 2) {
      throw new CrmStateError(
        "Choose at least two different contacts for bulk outreach.",
        422,
      );
    }
    const event = await this.env.DB.prepare(
      `SELECT name, venue_name AS venueName, city FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(input.eventId, viewer.organisationId)
      .first<{ name: string; venueName: string | null; city: string | null }>();
    if (!event) throw new Response("Target event not found.", { status: 404 });
    const placeholders = uniquePersonIds.map(() => "?").join(",");
    const contacts = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id, person.display_name AS name, person.email
         FROM organisation_contact_ids scoped JOIN people person ON person.id = scoped.person_id
        WHERE person.id IN (${placeholders})
        ORDER BY person.display_name COLLATE NOCASE`,
    )
      .bind(...scopeBindings(viewer), ...uniquePersonIds)
      .all<{ id: string; name: string; email: string }>();
    if (contacts.results.length !== uniquePersonIds.length) {
      throw new CrmStateError(
        "One or more selected contacts are no longer in this organisation.",
        422,
      );
    }
    const eventViewer = this.eventViewer(viewer, input.eventId);
    const operation = await outreachOperationIds(
      viewer.organisationId,
      input.eventId,
      input.idempotencyKey,
    );
    const existingDraft = await this.env.DB.prepare(
      `SELECT communication.id
         FROM communications communication
         JOIN events event
           ON event.id = communication.event_id AND event.organisation_id = ?
        WHERE communication.id = ? AND communication.event_id = ?
          AND communication.idempotency_key = ?
          AND communication.status = 'draft'`,
    )
      .bind(
        viewer.organisationId,
        operation.draftId,
        input.eventId,
        `communication:draft:${operation.draftId}`,
      )
      .first<{ id: string }>();
    if (existingDraft) {
      return { eventId: input.eventId, draftId: existingDraft.id };
    }
    const templates = new CommunicationTemplateService(this.env);
    const existingVersion = await this.env.DB.prepare(
      `SELECT version.template_id AS templateId, version.id AS versionId
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND template.id = ?`,
    )
      .bind(
        viewer.organisationId,
        operation.versionId,
        input.eventId,
        operation.templateId,
      )
      .first<{ templateId: string; versionId: string }>();
    const saved =
      existingVersion ??
      (await templates.saveTemplate(
        eventViewer,
        {
          name: `CRM outreach · ${input.subject}`.slice(0, 160),
          category: "ad_hoc",
          subject: input.subject,
          content: {
            body: input.body,
            physicalAddress: input.physicalAddress,
          },
        },
        {
          operationId: operation.operationId,
          templateId: operation.templateId,
          versionId: operation.versionId,
          auditId: operation.auditId,
        },
      ));
    await templates.publishTemplate(eventViewer, saved.versionId);
    const draft = await new CommunicationDraftService(this.env).create(
      eventViewer,
      {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: contacts.results
          .map((contact) => `${contact.name} <${contact.email}>`)
          .join("\n"),
        kind: "optional",
        scheduledAt: null,
      },
      {
        draftId: operation.draftId,
        idempotencyKey: `communication:draft:${operation.draftId}`,
      },
    );
    return { eventId: input.eventId, draftId: draft.id };
  }
}

export type { CrmFilters };

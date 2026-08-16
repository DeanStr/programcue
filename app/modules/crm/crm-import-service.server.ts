import type { z } from "zod";
import { requireValue } from "~/lib/required-value";
import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";
import { CsvParseError, parseCsv } from "~/platform/operations/csv";
import {
  CONTACT_RELATIONSHIP_REQUIRED_MESSAGE,
  existingPersonOrganisationRelationshipSql,
  isContactRelationshipConstraint,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "./crm-contact-scope.server";
import { CrmStateError } from "./crm-errors";
import { createCrmContactSchema } from "./crm-schema";

const IMPORT_BYTES_LIMIT = 512_000;

export class CrmImportService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async preview(viewer: OrganisationAdministrator, rawCsv: string) {
    if (new TextEncoder().encode(rawCsv).byteLength > IMPORT_BYTES_LIMIT) {
      throw new CrmStateError(
        "Speaker Network CSV files cannot exceed 512 KB.",
        422,
      );
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
        name: row[
          requireValue(mapping.name, "Required mapping.name is unavailable.")
        ],
        email:
          row[
            requireValue(
              mapping.email,
              "Required mapping.email is unavailable.",
            )
          ],
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
      } else {
        invalid.push({
          rowNumber: index + 2,
          errors: candidate.error.issues.map((issue) => issue.message),
        });
      }
    });
    const unavailableEmails = await unavailableExistingEmails(
      this.env,
      viewer,
      valid.map((row) => row.email),
    );
    const linkable = valid.filter((row) => {
      if (!unavailableEmails.has(row.email)) return true;
      invalid.push({
        rowNumber: row.rowNumber,
        errors: [CONTACT_RELATIONSHIP_REQUIRED_MESSAGE],
      });
      return false;
    });
    invalid.sort((left, right) => left.rowNumber - right.rowNumber);
    return {
      headers: parsed.headers,
      mapping,
      valid: linkable,
      invalid,
      csv: rawCsv,
    };
  }

  async confirm(viewer: OrganisationAdministrator, rawCsv: string) {
    const preview = await this.preview(viewer, rawCsv);
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
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
           ON CONFLICT(email) DO NOTHING`,
        ).bind(personId, row.email, row.email),
        this.env.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_by_person_id,
             created_at, updated_at
           ) VALUES (
             ?,
             (SELECT person.id FROM people person
               WHERE person.email = ? COLLATE NOCASE
                 AND (person.id = ? OR ${existingPersonOrganisationRelationshipSql})
                 AND NOT EXISTS (
                   SELECT 1 FROM organisation_contacts merged_contact
                    WHERE merged_contact.organisation_id = ?
                      AND merged_contact.person_id = person.id
                      AND merged_contact.status = 'merged'
                 )),
             'import', 'active', ?, unixepoch(), unixepoch()
           )
           ON CONFLICT(organisation_id, person_id) DO UPDATE SET
             updated_at = unixepoch()`,
        ).bind(
          viewer.organisationId,
          row.email,
          personId,
          ...organisationRelationshipBindings(viewer),
          viewer.organisationId,
          viewer.personId,
        ),
        this.env.DB.prepare(
          `INSERT INTO organisation_contact_profiles (
             organisation_id, person_id, display_name, biography,
             organisation_name, job_title, source, created_by_person_id,
             updated_by_person_id, created_at, updated_at
           )
           SELECT ?, person.id, ?, ?, ?, ?, 'import', ?, ?,
                  unixepoch(), unixepoch()
             FROM people person
             JOIN organisation_contacts contact
               ON contact.organisation_id = ? AND contact.person_id = person.id
              AND contact.status = 'active'
            WHERE person.email = ? COLLATE NOCASE
           ON CONFLICT(organisation_id, person_id) DO NOTHING`,
        ).bind(
          viewer.organisationId,
          row.name,
          row.biography || null,
          row.organisationName || null,
          row.jobTitle || null,
          viewer.personId,
          viewer.personId,
          viewer.organisationId,
          row.email,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, metadata_json, created_at
         ) VALUES (?, 'person', 'admin_ui', 1, ?, NULL, ?, 'crm.contacts.imported', 'crm_import', ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        JSON.stringify({ count: preview.valid.length }),
      ),
    );
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (isContactRelationshipConstraint(error)) {
        throw new CrmStateError(CONTACT_RELATIONSHIP_REQUIRED_MESSAGE, 409);
      }
      throw error;
    }
    return { imported: preview.valid.length };
  }
}

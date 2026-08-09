import { formSchemaSchema, routingSchema } from "./submission-schema";
import {
  parseJson,
  type AdminSubmission,
} from "./submission-repository-shared";

export class SubmissionAdminRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async listAdminSubmissions(
    organisationId: string,
    eventId: string,
    filters: { status?: string; category?: string; query?: string },
  ): Promise<AdminSubmission[]> {
    const query = `%${filters.query ?? ""}%`;
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.public_reference AS publicReference, s.title, COALESCE(s.category, '') AS category,
             COALESCE(s.format, '') AS format, s.status,
             COALESCE(p.display_name, s.submitter_email, 'Unknown') AS submitterName,
             COALESCE(p.email, s.submitter_email, '') AS submitterEmail,
             (SELECT COUNT(*) FROM submission_speakers ss WHERE ss.submission_id = s.id) AS speakerCount,
             fv.version_number AS versionNumber, s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             COALESCE(fv.routing_json, '{}') AS routingJson
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv ON fv.id = s.form_version_id
       WHERE s.event_id = ?
         AND (? = '' OR s.status = ?)
         AND (? = '' OR s.category = ?)
         AND (? = '%%' OR s.title LIKE ? OR p.display_name LIKE ? OR COALESCE(p.email, s.submitter_email) LIKE ?)
       ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC
       LIMIT 200
    `,
    )
      .bind(
        organisationId,
        eventId,
        filters.status ?? "",
        filters.status ?? "",
        filters.category ?? "",
        filters.category ?? "",
        query,
        query,
        query,
        query,
      )
      .all<Omit<AdminSubmission, "routedTo"> & { routingJson: string }>();
    return rows.results.map(({ routingJson, ...row }) => ({
      ...row,
      speakerCount: Number(row.speakerCount),
      routedTo:
        routingSchema.parse(JSON.parse(routingJson)).categories[row.category] ||
        "Unassigned",
    }));
  }

  async getAdminSubmission(
    organisationId: string,
    eventId: string,
    submissionId: string,
  ) {
    const row = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.category, s.format, s.status, s.answers_json AS answersJson,
             s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             COALESCE(p.display_name, s.submitter_email) AS submitterName,
             COALESCE(p.email, s.submitter_email) AS submitterEmail,
             fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             COALESCE(fv.routing_json, '{}') AS routingJson
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv ON fv.id = s.form_version_id
       WHERE s.event_id = ? AND s.id = ?
    `,
    )
      .bind(organisationId, eventId, submissionId)
      .first<{
        id: string;
        title: string;
        category: string | null;
        format: string | null;
        status: string;
        answersJson: string;
        submittedAt: number | null;
        updatedAt: number;
        submitterName: string | null;
        submitterEmail: string | null;
        versionNumber: number | null;
        schemaJson: string | null;
        routingJson: string;
      }>();
    if (!row) return null;
    const speakers = await this.env.DB.prepare(
      `
      SELECT ss.id, ss.display_name AS name, ss.email, ss.position,
             ss.invitation_status AS invitationStatus, ss.is_primary AS isPrimary
        FROM submission_speakers ss
       WHERE ss.submission_id = ? ORDER BY ss.position
    `,
    )
      .bind(submissionId)
      .all<{
        id: string;
        name: string;
        email: string;
        position: number;
        invitationStatus: string;
        isPrimary: number;
      }>();
    return {
      ...row,
      answers: JSON.parse(row.answersJson) as Record<string, string | string[]>,
      schema: row.schemaJson
        ? parseJson(row.schemaJson, formSchemaSchema)
        : null,
      routedTo:
        routingSchema.parse(JSON.parse(row.routingJson)).categories[
          row.category ?? ""
        ] || "Unassigned",
      speakers: speakers.results.map((speaker) => ({
        ...speaker,
        isPrimary: Boolean(speaker.isPrimary),
      })),
    };
  }
}

import { z } from "zod";

import {
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "~/modules/crm/crm-contact-scope.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { ApiError } from "~/platform/api/api.server";
import { CsvParseError, parseCsv } from "~/platform/operations/csv";

const IMPORT_BYTES_LIMIT = 512_000;

const workflowStatusSchema = z.enum([
  "prospect",
  "invited",
  "confirmed",
  "declined",
  "withdrawn",
]);

const importRowSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  jobTitle: z.string().trim().max(160),
  organisationName: z.string().trim().max(160),
  biography: z.string().trim().max(2_000),
  workflowStatus: workflowStatusSchema.optional(),
});

export type SpeakerWorkflowStatus = z.infer<typeof workflowStatusSchema>;
type SpeakerRosterImportRow = Omit<
  z.infer<typeof importRowSchema>,
  "workflowStatus"
> & {
  workflowStatus: SpeakerWorkflowStatus;
  workflowStatusSupplied: boolean;
  rowNumber: number;
};

export class SpeakerRosterImportError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "SpeakerRosterImportError";
  }
}

function organisationViewer(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response("Event administrator access is required.", {
      status: 403,
    });
  }
  return {
    ...viewer,
    role: viewer.role,
    currentEventId: viewer.eventId,
  } as const;
}

export class SpeakerRosterImportService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async preview(viewer: Viewer, rawCsv: string) {
    if (new TextEncoder().encode(rawCsv).byteLength > IMPORT_BYTES_LIMIT) {
      throw new SpeakerRosterImportError(
        "Event speaker CSV files cannot exceed 512 KB.",
      );
    }
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(rawCsv);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw new SpeakerRosterImportError(error.message);
      }
      throw error;
    }
    const aliases = {
      name: ["name", "speaker", "speaker_name"],
      email: ["email", "email_address"],
      jobTitle: ["title", "jobTitle", "job_title"],
      organisationName: ["company", "organisation", "organization"],
      biography: ["bio", "biography"],
      workflowStatus: ["status", "workflow_status", "workflowStatus"],
    } as const;
    const mapping = Object.fromEntries(
      Object.entries(aliases).map(([field, candidates]) => [
        field,
        candidates.find((candidate) => parsed.headers.includes(candidate)) ??
          null,
      ]),
    ) as Record<keyof typeof aliases, string | null>;
    if (!mapping.name || !mapping.email) {
      throw new SpeakerRosterImportError(
        "Event speaker CSV files require name and email columns.",
      );
    }
    const valid: SpeakerRosterImportRow[] = [];
    const invalid: Array<{ rowNumber: number; errors: string[] }> = [];
    const emails = new Set<string>();
    parsed.rows.forEach((row, index) => {
      const candidate = importRowSchema.safeParse({
        name: row[mapping.name!],
        email: row[mapping.email!],
        jobTitle: mapping.jobTitle ? row[mapping.jobTitle] : "",
        organisationName: mapping.organisationName
          ? row[mapping.organisationName]
          : "",
        biography: mapping.biography ? row[mapping.biography] : "",
        workflowStatus: mapping.workflowStatus
          ? row[mapping.workflowStatus] || undefined
          : undefined,
      });
      if (candidate.success && emails.has(candidate.data.email)) {
        invalid.push({
          rowNumber: index + 2,
          errors: ["Email duplicates another row in this import."],
        });
      } else if (candidate.success) {
        emails.add(candidate.data.email);
        valid.push({
          ...candidate.data,
          workflowStatus: candidate.data.workflowStatus ?? "prospect",
          workflowStatusSupplied: candidate.data.workflowStatus !== undefined,
          rowNumber: index + 2,
        });
      } else {
        invalid.push({
          rowNumber: index + 2,
          errors: candidate.error.issues.map((issue) => issue.message),
        });
      }
    });
    const scopedViewer = organisationViewer(viewer);
    const unavailable = await unavailableExistingEmails(
      this.env,
      scopedViewer,
      valid.map((row) => row.email),
    );
    const linkable = valid.filter((row) => {
      if (!unavailable.has(row.email)) return true;
      invalid.push({
        rowNumber: row.rowNumber,
        errors: [
          "This email belongs to a person outside the current organisation and cannot be linked by CSV.",
        ],
      });
      return false;
    });
    invalid.sort((left, right) => left.rowNumber - right.rowNumber);
    return { mapping, valid: linkable, invalid, csv: rawCsv };
  }

  async confirm(viewer: Viewer, rawCsv: string, rawIdempotencyKey: unknown) {
    const idempotencyKey = z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/u)
      .parse(rawIdempotencyKey);
    const preview = await this.preview(viewer, rawCsv);
    if (!preview.valid.length || preview.invalid.length) {
      throw new SpeakerRosterImportError(
        "Resolve every invalid speaker row before confirming the import.",
      );
    }
    try {
      const { result } = await new ApiPersonIdempotencyService(this.env).run({
        viewer,
        scope: "speaker.roster.import",
        idempotencyKey,
        input: { rows: preview.valid },
        execute: (commandId) =>
          this.confirmD1(viewer, preview.valid, commandId),
        recover: (commandId) => this.recover(viewer, commandId),
      });
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        throw new SpeakerRosterImportError(error.message, error.status);
      }
      throw error;
    }
  }

  private async confirmD1(
    viewer: Viewer,
    rows: SpeakerRosterImportRow[],
    commandId: string,
  ) {
    const scopedViewer = organisationViewer(viewer);
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const personId = crypto.randomUUID();
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, biography, organisation_name, job_title,
             email_verified, profile_status, last_operation_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, 'draft', ?, unixepoch(), unixepoch())
           ON CONFLICT(email) DO NOTHING`,
        ).bind(
          personId,
          row.email,
          row.name,
          row.biography || null,
          row.organisationName || null,
          row.jobTitle || null,
          commandId,
        ),
        this.env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role,
             invited_at, invitation_expires_at, accepted_at, revoked_at,
             last_operation_id, created_at
           )
           SELECT ?, ?, ?, person.id, 'speaker', NULL, NULL, NULL, NULL, ?, unixepoch()
             FROM people person
            WHERE person.email = ? COLLATE NOCASE
              AND (person.id = ? OR ${existingPersonOrganisationRelationshipSql})
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = ? AND event.organisation_id = ?
                   AND event.activation_status = 'active'
              )
           ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
           DO NOTHING`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          commandId,
          row.email,
          personId,
          ...organisationRelationshipBindings(scopedViewer),
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_speaker_workflows (
             event_id, person_id, status, source, last_operation_id,
             updated_by_person_id, created_at, updated_at
           )
           SELECT ?, membership.person_id, ?, 'import', ?, ?, unixepoch(), unixepoch()
             FROM memberships membership
             JOIN people person ON person.id = membership.person_id
            WHERE membership.event_id = ?
              AND membership.organisation_id = ?
              AND membership.role = 'speaker'
              AND person.email = ? COLLATE NOCASE
           ON CONFLICT(event_id, person_id) DO UPDATE SET
             status = CASE WHEN ? = 1
                       THEN excluded.status
                       ELSE event_speaker_workflows.status END,
             source = CASE WHEN ? = 1
                       THEN excluded.source
                       ELSE event_speaker_workflows.source END,
             revision = event_speaker_workflows.revision + 1,
             last_operation_id = excluded.last_operation_id,
             updated_by_person_id = CASE WHEN ? = 1
                                    THEN excluded.updated_by_person_id
                                    ELSE event_speaker_workflows.updated_by_person_id END,
             updated_at = unixepoch()`,
        ).bind(
          viewer.eventId,
          row.workflowStatus,
          `${commandId}:${row.rowNumber}`,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          row.email,
          row.workflowStatusSupplied ? 1 : 0,
          row.workflowStatusSupplied ? 1 : 0,
          row.workflowStatusSupplied ? 1 : 0,
        ),
      );
    }
    const rowOperationIds = rows.map((row) => `${commandId}:${row.rowNumber}`);
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?,
                   CASE WHEN (
                     SELECT COUNT(*) FROM event_speaker_workflows workflow
                      WHERE workflow.event_id = ?
                        AND workflow.last_operation_id IN (
                          SELECT CAST(value AS TEXT) FROM json_each(?)
                        )
                   ) = ? THEN 'speaker.roster.imported' END,
                   'speaker_roster', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        JSON.stringify(rowOperationIds),
        rows.length,
        viewer.eventId,
        commandId,
        JSON.stringify({ count: rows.length }),
      ),
    );
    await this.env.DB.batch(statements);
    return { imported: rows.length };
  }

  private async recover(viewer: Viewer, commandId: string) {
    const row = await this.env.DB.prepare(
      `SELECT json_extract(metadata_json, '$.count') AS imported
         FROM audit_events
        WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ?
          AND action = 'speaker.roster.imported'
          AND entity_type = 'speaker_roster' AND correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{ imported: number }>();
    return row ? { imported: Number(row.imported) } : null;
  }
}

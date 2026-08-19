import { z } from "zod";
import { requireValue } from "~/lib/required-value";

import {
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "~/modules/crm/crm-contact-scope.server";
import { ApiError, apiRequestHash } from "~/platform/api/api.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluatorEmailAliasContextError,
  type EvaluatorEmailRouting,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import {
  CsvParseError,
  matchingCsvHeader,
  parseCsv,
} from "~/platform/operations/csv";

const IMPORT_BYTES_LIMIT = 512_000;
const PROFILE_LOOKUP_SIZE = 80;
const IMPORT_GUARD_CONSTRAINT =
  /NOT NULL constraint failed: audit_events\.action/u;

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
  biography: z.string().trim().max(5_000),
  workflowStatus: workflowStatusSchema.optional(),
});

export type SpeakerWorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type SpeakerRosterProfileAction =
  | "create_identity_and_profile"
  | "create_organisation_profile"
  | "update_organisation_profile"
  | "retain_organisation_profile";

type SpeakerRosterImportRow = Omit<
  z.infer<typeof importRowSchema>,
  "workflowStatus"
> & {
  enteredEmail: string;
  evaluatorEmailRouting: EvaluatorEmailRouting | null;
  biographySupplied: boolean;
  jobTitleSupplied: boolean;
  organisationNameSupplied: boolean;
  profileAction: SpeakerRosterProfileAction;
  workflowStatus: SpeakerWorkflowStatus;
  workflowAction: "set" | "retain";
  workflowStatusSupplied: boolean;
  rowNumber: number;
};

type ExistingRosterProfile = {
  email: string;
  contactStatus: "active" | "merged" | null;
  displayName: string | null;
  biography: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  workflowStatus: SpeakerWorkflowStatus | null;
};

type SpeakerRosterImportResult = {
  imported: number;
  evaluatorEmailRoutings?: EvaluatorEmailRouting[];
};

const importAuditMetadataSchema = z.object({
  count: z.number().int().nonnegative(),
  evaluatorEmailRoutings: z
    .array(
      z.object({
        enteredEmail: z.email(),
        routedEmail: z.email(),
        personId: z.string().min(1),
      }),
    )
    .optional(),
});

function importResult(
  imported: number,
  evaluatorEmailRoutings: EvaluatorEmailRouting[],
): SpeakerRosterImportResult {
  return evaluatorEmailRoutings.length
    ? { imported, evaluatorEmailRoutings }
    : { imported };
}

function nullableImportValue(value: string) {
  return value || null;
}

function normalizeCsv(value: string) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function profileAction(
  row: Pick<
    SpeakerRosterImportRow,
    | "name"
    | "biography"
    | "biographySupplied"
    | "organisationName"
    | "organisationNameSupplied"
    | "jobTitle"
    | "jobTitleSupplied"
  >,
  existing: ExistingRosterProfile | undefined,
): SpeakerRosterProfileAction {
  if (!existing) return "create_identity_and_profile";
  if (existing.displayName === null) return "create_organisation_profile";
  const changed =
    existing.displayName !== row.name ||
    (row.biographySupplied &&
      existing.biography !== nullableImportValue(row.biography)) ||
    (row.organisationNameSupplied &&
      existing.organisationName !==
        nullableImportValue(row.organisationName)) ||
    (row.jobTitleSupplied &&
      existing.jobTitle !== nullableImportValue(row.jobTitle));
  return changed
    ? "update_organisation_profile"
    : "retain_organisation_profile";
}

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
    const csv = normalizeCsv(rawCsv);
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(csv);
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
        matchingCsvHeader(parsed.headers, candidates),
      ]),
    ) as Record<keyof typeof aliases, string | null>;
    if (!mapping.name || !mapping.email) {
      throw new SpeakerRosterImportError(
        "Event speaker CSV files require name and email columns.",
      );
    }
    const parsedRows: Array<
      Omit<SpeakerRosterImportRow, "profileAction" | "workflowAction">
    > = [];
    const invalid: Array<{ rowNumber: number; errors: string[] }> = [];
    const emails = new Set<string>();
    for (const [index, row] of parsed.rows.entries()) {
      const candidate = importRowSchema.safeParse({
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
        workflowStatus: mapping.workflowStatus
          ? row[mapping.workflowStatus] || undefined
          : undefined,
      });
      if (!candidate.success) {
        invalid.push({
          rowNumber: index + 2,
          errors: candidate.error.issues.map((issue) => issue.message),
        });
        continue;
      }
      const enteredEmail = candidate.data.email;
      let resolution: Awaited<ReturnType<typeof resolveEvaluatorEmailAlias>>;
      try {
        resolution = await resolveEvaluatorEmailAlias(
          this.env,
          viewer,
          enteredEmail,
        );
      } catch (error) {
        if (error instanceof EvaluatorEmailAliasContextError) {
          invalid.push({ rowNumber: index + 2, errors: [error.message] });
          continue;
        }
        throw error;
      }
      if (emails.has(resolution.email)) {
        invalid.push({
          rowNumber: index + 2,
          errors: ["Email duplicates another row in this import."],
        });
      } else {
        emails.add(resolution.email);
        parsedRows.push({
          ...candidate.data,
          email: resolution.email,
          enteredEmail,
          evaluatorEmailRouting: resolution.routing,
          biographySupplied: mapping.biography !== null,
          jobTitleSupplied: mapping.jobTitle !== null,
          organisationNameSupplied: mapping.organisationName !== null,
          workflowStatus: candidate.data.workflowStatus ?? "prospect",
          workflowStatusSupplied: candidate.data.workflowStatus !== undefined,
          rowNumber: index + 2,
        });
      }
    }
    const scopedViewer = organisationViewer(viewer);
    const unavailable = await unavailableExistingEmails(
      this.env,
      scopedViewer,
      parsedRows.map((row) => row.email),
    );
    const linkable = parsedRows.filter((row) => {
      if (row.evaluatorEmailRouting) return true;
      if (!unavailable.has(row.email)) return true;
      invalid.push({
        rowNumber: row.rowNumber,
        errors: [
          "This email belongs to a person outside the current organisation and cannot be linked by CSV.",
        ],
      });
      return false;
    });
    const existingProfiles = new Map<string, ExistingRosterProfile>();
    for (
      let offset = 0;
      offset < linkable.length;
      offset += PROFILE_LOOKUP_SIZE
    ) {
      const batch = linkable.slice(offset, offset + PROFILE_LOOKUP_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = await this.env.DB.prepare(
        `SELECT lower(person.email) AS email, contact.status AS contactStatus,
                profile.display_name AS displayName, profile.biography,
                profile.organisation_name AS organisationName,
                profile.job_title AS jobTitle,
                workflow.status AS workflowStatus
           FROM people person
           LEFT JOIN organisation_contacts contact
             ON contact.organisation_id = ? AND contact.person_id = person.id
           LEFT JOIN organisation_contact_profiles profile
             ON profile.organisation_id = contact.organisation_id
            AND profile.person_id = contact.person_id
           LEFT JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
          WHERE lower(person.email) IN (${placeholders})`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          ...batch.map((row) => row.email),
        )
        .all<ExistingRosterProfile>();
      rows.results.forEach((row) => {
        existingProfiles.set(row.email, row);
      });
    }
    const valid = linkable.flatMap((row) => {
      const existing = existingProfiles.get(row.email);
      if (existing?.contactStatus === "merged") {
        invalid.push({
          rowNumber: row.rowNumber,
          errors: [
            "This email belongs to a merged Speaker Network contact. Use the primary contact instead.",
          ],
        });
        return [];
      }
      const workflowAction: SpeakerRosterImportRow["workflowAction"] =
        row.workflowStatusSupplied || !existing?.workflowStatus
          ? "set"
          : "retain";
      return [
        {
          ...row,
          profileAction: profileAction(row, existing),
          workflowAction,
          workflowStatus:
            workflowAction === "retain"
              ? requireValue(
                  requireValue(existing, "Required existing is unavailable.")
                    .workflowStatus,
                  "Required existing.workflowStatus is unavailable.",
                )
              : row.workflowStatus,
        },
      ];
    });
    invalid.sort((left, right) => left.rowNumber - right.rowNumber);
    const previewFingerprint = await apiRequestHash({
      version: 1,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      valid,
      invalid,
    });
    return { mapping, valid, invalid, csv, previewFingerprint };
  }

  async confirm(
    viewer: Viewer,
    rawCsv: string,
    rawIdempotencyKey: unknown,
    rawPreviewFingerprint: unknown,
  ) {
    organisationViewer(viewer);
    const idempotencyKey = z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/u)
      .parse(rawIdempotencyKey);
    const previewFingerprint = z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(rawPreviewFingerprint);
    const csv = normalizeCsv(rawCsv);
    try {
      const { result } = await new ApiPersonIdempotencyService(this.env).run({
        viewer,
        scope: "speaker.roster.import",
        idempotencyKey,
        input: { csv, previewFingerprint },
        execute: async (commandId) => {
          const preview = await this.preview(viewer, csv);
          if (preview.previewFingerprint !== previewFingerprint) {
            throw new SpeakerRosterImportError(
              "The event roster changed after this import was previewed. Preview the CSV again before confirming.",
              409,
            );
          }
          if (!preview.valid.length || preview.invalid.length) {
            throw new SpeakerRosterImportError(
              "Resolve every invalid speaker row before confirming the import.",
            );
          }
          return this.confirmD1(viewer, preview.valid, commandId);
        },
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
      const personId =
        row.evaluatorEmailRouting?.personId ?? crypto.randomUUID();
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status, last_operation_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, 0, 'draft', ?, unixepoch(), unixepoch())
           ON CONFLICT(email) DO NOTHING`,
        ).bind(personId, row.email, row.email, commandId),
        this.env.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_by_person_id,
             created_at, updated_at
           )
           SELECT ?, person.id, 'import', 'active', ?, unixepoch(), unixepoch()
             FROM people person
            WHERE person.email = ? COLLATE NOCASE
              AND (person.id = ? OR ${existingPersonOrganisationRelationshipSql})
           ON CONFLICT(organisation_id, person_id) DO UPDATE SET
             updated_at = unixepoch()
           WHERE organisation_contacts.status = 'active'`,
        ).bind(
          viewer.organisationId,
          viewer.personId,
          row.email,
          personId,
          ...organisationRelationshipBindings(scopedViewer),
        ),
        this.env.DB.prepare(
          `INSERT INTO organisation_contact_profiles (
             organisation_id, person_id, display_name, biography,
             organisation_name, job_title, source, created_by_person_id,
             updated_by_person_id, last_operation_id, created_at, updated_at
           )
           SELECT ?, person.id, ?, ?, ?, ?, 'import', ?, ?, ?,
                  unixepoch(), unixepoch()
             FROM people person
             JOIN organisation_contacts contact
               ON contact.organisation_id = ? AND contact.person_id = person.id
              AND contact.status = 'active'
            WHERE person.email = ? COLLATE NOCASE
           ON CONFLICT(organisation_id, person_id) DO UPDATE SET
             display_name = excluded.display_name,
             biography = CASE WHEN ? = 1 THEN excluded.biography
                              ELSE organisation_contact_profiles.biography END,
             organisation_name = CASE WHEN ? = 1 THEN excluded.organisation_name
                                      ELSE organisation_contact_profiles.organisation_name END,
             job_title = CASE WHEN ? = 1 THEN excluded.job_title
                              ELSE organisation_contact_profiles.job_title END,
             source = 'import', updated_by_person_id = excluded.updated_by_person_id,
             last_operation_id = excluded.last_operation_id,
             updated_at = unixepoch()`,
        ).bind(
          viewer.organisationId,
          row.name,
          row.biography || null,
          row.organisationName || null,
          row.jobTitle || null,
          viewer.personId,
          viewer.personId,
          `${commandId}:${row.rowNumber}`,
          viewer.organisationId,
          row.email,
          row.biographySupplied ? 1 : 0,
          row.organisationNameSupplied ? 1 : 0,
          row.jobTitleSupplied ? 1 : 0,
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
    const evaluatorEmailRoutings = rows.flatMap((row) =>
      row.evaluatorEmailRouting ? [row.evaluatorEmailRouting] : [],
    );
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, 'person', 'admin_ui', 1, ?, ?, ?,
                   CASE WHEN (
                     SELECT COUNT(*) FROM event_speaker_workflows workflow
                      WHERE workflow.event_id = ?
                        AND workflow.last_operation_id IN (
                          SELECT CAST(value AS TEXT) FROM json_each(?)
                        )
                   ) = ? AND (
                     SELECT COUNT(*)
                       FROM organisation_contact_profiles profile
                      WHERE profile.organisation_id = ?
                        AND profile.last_operation_id IN (
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
        viewer.organisationId,
        JSON.stringify(rowOperationIds),
        rows.length,
        viewer.eventId,
        commandId,
        JSON.stringify({
          count: rows.length,
          ...(evaluatorEmailRoutings.length ? { evaluatorEmailRoutings } : {}),
        }),
      ),
    );
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        IMPORT_GUARD_CONSTRAINT.test(error.message)
      ) {
        throw new SpeakerRosterImportError(
          "The event roster changed while this import was being applied. Preview the CSV again before confirming.",
          409,
        );
      }
      throw error;
    }
    return importResult(rows.length, evaluatorEmailRoutings);
  }

  private async recover(viewer: Viewer, commandId: string) {
    const row = await this.env.DB.prepare(
      `SELECT metadata_json AS metadataJson
         FROM audit_events
        WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ?
          AND action = 'speaker.roster.imported'
          AND entity_type = 'speaker_roster' AND correlation_id = ?
      LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{ metadataJson: string }>();
    if (!row) return null;
    const metadata = importAuditMetadataSchema.parse(
      JSON.parse(row.metadataJson) as unknown,
    );
    return importResult(
      metadata.count,
      (metadata.evaluatorEmailRoutings ?? []) as EvaluatorEmailRouting[],
    );
  }
}

import {
  formSchemaSchema,
  routingSchema,
  submittedSnapshotSchema,
  type SubmittedSnapshot,
} from "./submission-schema";
import {
  parseJson,
  type AdminSubmission,
} from "./submission-repository-shared";

function requireSubmittedSnapshot(
  submissionId: string,
  snapshotJson: string | null,
): SubmittedSnapshot {
  if (!snapshotJson) {
    throw new Error(
      `Submission ${submissionId} is missing its immutable submitted snapshot.`,
    );
  }
  try {
    return parseJson(snapshotJson, submittedSnapshotSchema);
  } catch {
    throw new Error(
      `Submission ${submissionId} has an invalid immutable submitted snapshot.`,
    );
  }
}

function snapshotSummaryAnswer(
  snapshot: SubmittedSnapshot,
  fieldId: "title" | "category" | "format",
) {
  const value = snapshot.answers[fieldId];
  if (Array.isArray(value)) return value.join(", ").trim() || null;
  return value?.trim() || null;
}

function requireSnapshotTitle(
  submissionId: string,
  snapshot: SubmittedSnapshot,
) {
  const title = snapshotSummaryAnswer(snapshot, "title");
  if (!title) {
    throw new Error(
      `Submission ${submissionId} has an invalid immutable title answer.`,
    );
  }
  return title;
}

export class SubmissionAdminRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async listAdminSubmissionCategories(
    organisationId: string,
    eventId: string,
  ): Promise<string[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT DISTINCT trim(s.category) AS category
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
       WHERE s.event_id = ?
         AND s.category IS NOT NULL
         AND trim(s.category) <> ''
       ORDER BY category COLLATE NOCASE, category
    `,
    )
      .bind(organisationId, eventId)
      .all<{ category: string }>();
    return rows.results.map((row) => row.category);
  }

  async listAdminSubmissions(
    organisationId: string,
    eventId: string,
    filters: { status?: string; category?: string; query?: string },
    pagination: { limit: number; offset: number } = { limit: 200, offset: 0 },
  ): Promise<AdminSubmission[]> {
    if (
      !Number.isInteger(pagination.limit) ||
      pagination.limit < 1 ||
      pagination.limit > 200 ||
      !Number.isInteger(pagination.offset) ||
      pagination.offset < 0
    ) {
      throw new Error("Submission pagination is outside its supported range.");
    }
    const query = `%${filters.query ?? ""}%`;
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.public_reference AS publicReference, s.title, COALESCE(s.category, '') AS category,
             COALESCE(s.format, '') AS format, s.status,
             COALESCE(p.display_name, s.submitter_email, 'Unknown') AS submitterName,
             COALESCE(p.email, s.submitter_email, '') AS submitterEmail,
             (SELECT COUNT(*) FROM submission_speakers ss WHERE ss.submission_id = s.id) AS speakerCount,
             fv.version_number AS versionNumber, s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             s.routed_team_id AS routedTeamId,
             COALESCE(
               fv.routing_json,
               json_extract(s.submitted_snapshot_json, '$.routing'),
               '{}'
             ) AS routingJson
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv ON fv.id = s.form_version_id
       WHERE s.event_id = ?
         AND (? = '' OR s.status = ?)
         AND (? = '' OR s.category = ?)
         AND (? = '%%' OR s.title LIKE ? OR p.display_name LIKE ? OR COALESCE(p.email, s.submitter_email) LIKE ?)
       ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC, s.id DESC
       LIMIT ? OFFSET ?
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
        pagination.limit,
        pagination.offset,
      )
      .all<Omit<AdminSubmission, "routedTo"> & { routingJson: string }>();
    return rows.results.map(({ routingJson, ...row }) => {
      const routing = routingSchema.parse(JSON.parse(routingJson));
      return {
        ...row,
        speakerCount: Number(row.speakerCount),
        routedTo: row.routedTeamId
          ? (routing.teamNames[row.routedTeamId] ?? row.routedTeamId)
          : "Unassigned",
      };
    });
  }

  async getAdminSubmission(
    organisationId: string,
    eventId: string,
    submissionId: string,
  ) {
    const row = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.category, s.format, s.status, s.answers_json AS answersJson,
             e.timezone AS eventTimezone,
             s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             COALESCE(p.display_name, s.submitter_email) AS submitterName,
             COALESCE(p.email, s.submitter_email) AS submitterEmail,
             fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             s.routed_team_id AS routedTeamId,
             COALESCE(
               fv.routing_json,
               json_extract(s.submitted_snapshot_json, '$.routing'),
               '{}'
             ) AS routingJson,
             s.submitted_snapshot_json AS snapshotJson,
             (
               SELECT revision.speaker_snapshot_json
                 FROM submission_revisions revision
                WHERE revision.submission_id = s.id
                  AND revision.event_id = s.event_id
                ORDER BY revision.revision_number DESC LIMIT 1
             ) AS latestSpeakerSnapshotJson
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
        eventTimezone: string;
        answersJson: string;
        submittedAt: number | null;
        updatedAt: number;
        submitterName: string | null;
        submitterEmail: string | null;
        versionNumber: number | null;
        schemaJson: string | null;
        routingJson: string;
        routedTeamId: string | null;
        snapshotJson: string | null;
        latestSpeakerSnapshotJson: string | null;
      }>();
    if (!row) return null;
    const speakers = await this.env.DB.prepare(
      `
      SELECT ss.id, ss.person_id AS personId, ss.display_name AS name,
             ss.email, ss.position, ss.invitation_status AS invitationStatus,
             ss.is_primary AS isPrimary,
             COALESCE(person.biography, '') AS currentBiography
        FROM submission_speakers ss
        LEFT JOIN people person ON person.id = ss.person_id
       WHERE ss.submission_id = ? AND ss.event_id = ?
       ORDER BY ss.position
    `,
    )
      .bind(submissionId, eventId)
      .all<{
        id: string;
        personId: string | null;
        name: string;
        email: string;
        position: number;
        invitationStatus: string;
        isPrimary: number;
        currentBiography: string;
      }>();
    const snapshot =
      row.status === "draft"
        ? null
        : requireSubmittedSnapshot(row.id, row.snapshotJson);
    const routing = routingSchema.parse(JSON.parse(row.routingJson));
    const sourceSpeakers = snapshot
      ? snapshot.speakers
      : row.latestSpeakerSnapshotJson
        ? (JSON.parse(row.latestSpeakerSnapshotJson) as Array<{
            email: string;
            biography?: string;
          }>)
        : [];
    const snapshotBiographies = new Map(
      sourceSpeakers.map((speaker) => [
        speaker.email.toLowerCase(),
        speaker.biography ?? "",
      ]),
    );
    const answers = snapshot
      ? snapshot.answers
      : (JSON.parse(row.answersJson) as Record<string, string | string[]>);
    const schema = snapshot
      ? snapshot.schema
      : row.schemaJson
        ? parseJson(row.schemaJson, formSchemaSchema)
        : null;
    const {
      answersJson: _answersJson,
      schemaJson: _schemaJson,
      routingJson: _routingJson,
      snapshotJson: _snapshotJson,
      latestSpeakerSnapshotJson: _latestSpeakerSnapshotJson,
      ...summary
    } = row;
    return {
      ...summary,
      ...(snapshot
        ? {
            title: requireSnapshotTitle(row.id, snapshot),
            category: snapshotSummaryAnswer(snapshot, "category"),
            format: snapshotSummaryAnswer(snapshot, "format"),
          }
        : {}),
      answers,
      schema,
      routedTo: row.routedTeamId
        ? (routing.teamNames[row.routedTeamId] ?? row.routedTeamId)
        : "Unassigned",
      uploads: snapshot ? snapshot.uploads : {},
      speakers: speakers.results.map(({ currentBiography, ...speaker }) => {
        const submittedBiography =
          snapshotBiographies.get(speaker.email.toLowerCase()) ?? "";
        return {
          ...speaker,
          biography:
            speaker.personId && speaker.invitationStatus === "claimed"
              ? currentBiography
              : submittedBiography,
          submittedBiography,
          isPrimary: Boolean(speaker.isPrimary),
        };
      }),
    };
  }
}

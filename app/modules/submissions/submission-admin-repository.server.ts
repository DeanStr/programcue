import { z } from "zod";
import { AuditReader } from "~/platform/audit/audit-reader.server";
import {
  ADMIN_SUBMISSION_STATUSES,
  type AdminSubmission,
  type AdminSubmissionFilters,
  type AdminSubmissionStatus,
  type AdminSubmissionSummary,
  parseJson,
} from "./submission-repository-shared";
import {
  classifySubmissionRouting,
  explainSubmissionRouting,
} from "./submission-routing-explanation";
import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  type FormRouting,
  routingSchema,
  type SubmittedSnapshot,
  storedFormSchemaSchema,
  submittedSnapshotSchema,
} from "./submission-schema";

function requireRoutedTeamSummary(
  submissionId: string,
  routedTeamIds: string[],
  routing: FormRouting,
) {
  if (routedTeamIds.length === 0) {
    return "Unassigned";
  }
  return routedTeamIds
    .map((teamId) => {
      const teamName = routing.teamNames[teamId];
      if (!teamName) {
        throw new Error(
          `Submission ${submissionId} is missing an immutable routed-team name.`,
        );
      }
      return teamName;
    })
    .join(", ");
}

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

const adminSubmissionFilterSql = `
  s.event_id = ?
  AND (? = '' OR s.status = ?)
  AND (? = '' OR (s.status = 'draft' AND s.category = ?) OR EXISTS (
    SELECT 1 FROM submission_track_selections selected_filter
     WHERE selected_filter.submission_id = s.id
       AND selected_filter.event_id = s.event_id
       AND selected_filter.track_name_snapshot = ?
  ))
  AND (
    ? = '%%'
    OR s.title LIKE ? ESCAPE '!'
    OR p.display_name LIKE ? ESCAPE '!'
    OR COALESCE(p.email, s.submitter_email) LIKE ? ESCAPE '!'
  )
  AND (
    ? = ''
    OR (
      ? = 'manual_override'
      AND s.status <> 'draft'
      AND s.form_version_id IS NULL
      AND json_extract(s.submitted_snapshot_json, '$.formVersionId') = ?
      AND EXISTS (
        SELECT 1 FROM submission_routing_teams manual_route
         WHERE manual_route.submission_id = s.id
           AND manual_route.event_id = s.event_id
      )
    )
    OR (
      ? = 'missing_automatic'
      AND s.status <> 'draft'
      AND s.form_version_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM submission_track_selections selected_route
         WHERE selected_route.submission_id = s.id
           AND selected_route.event_id = s.event_id
           AND NOT EXISTS (
             SELECT 1
               FROM json_each(fv.routing_json, '$.categories') automatic_route
              WHERE automatic_route.key = selected_route.track_name_snapshot
                AND typeof(automatic_route.value) = 'text'
                AND trim(automatic_route.value) <> ''
           )
      )
    )
  )`;

function adminSubmissionFilterBindings(
  eventId: string,
  filters: AdminSubmissionFilters,
) {
  const query = `%${(filters.query ?? "")
    .replaceAll("!", "!!")
    .replaceAll("%", "!%")
    .replaceAll("_", "!_")}%`;
  return [
    eventId,
    filters.status ?? "",
    filters.status ?? "",
    filters.category ?? "",
    filters.category ?? "",
    filters.category ?? "",
    query,
    query,
    query,
    query,
    filters.routing ?? "",
    filters.routing ?? "",
    ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
    filters.routing ?? "",
  ];
}

function adminSubmissionOrder(filters: AdminSubmissionFilters) {
  switch (filters.sort ?? "submittedAt-desc") {
    case "submittedAt-desc":
      return "COALESCE(s.submitted_at, s.updated_at) DESC, s.id DESC";
    case "submittedAt-asc":
      return "COALESCE(s.submitted_at, s.updated_at) ASC, s.id ASC";
    case "title-asc":
      return "s.title COLLATE NOCASE ASC, s.title ASC, s.id ASC";
    case "title-desc":
      return "s.title COLLATE NOCASE DESC, s.title DESC, s.id DESC";
  }
}

type AdminSubmissionRow = Omit<
  AdminSubmission,
  "category" | "routedTo" | "routedTeamIds" | "routingState"
> & {
  category: string | null;
  formVersionId: string | null;
  snapshotFormVersionId: string | null;
  snapshotVersionNumber: number | null;
  routingJson: string | null;
  routedTeamIdsJson: string;
  selectedTracksJson: string;
};

function assertAdminSubmissionPagination(pagination: {
  limit: number;
  offset: number;
}) {
  if (
    !Number.isSafeInteger(pagination.limit) ||
    pagination.limit < 1 ||
    pagination.limit > 200 ||
    !Number.isSafeInteger(pagination.offset) ||
    pagination.offset < 0
  ) {
    throw new Error("Submission pagination is outside its supported range.");
  }
}

function adminSubmissionRowsStatement(
  db: D1Database,
  organisationId: string,
  eventId: string,
  filters: AdminSubmissionFilters,
  pagination: { limit: number; offset: number },
) {
  assertAdminSubmissionPagination(pagination);
  return db
    .prepare(
      `SELECT s.id, s.public_reference AS publicReference, s.title,
              CASE WHEN s.status = 'draft' THEN COALESCE(s.category, '')
                   ELSE (
                     SELECT group_concat(selected.track_name_snapshot, ', ')
                       FROM (
                         SELECT track_name_snapshot
                           FROM submission_track_selections
                          WHERE submission_id = s.id AND event_id = s.event_id
                          ORDER BY position
                       ) selected
                   )
              END AS category,
              COALESCE(s.format, '') AS format, s.status,
              COALESCE(p.display_name, s.submitter_email, 'Unknown') AS submitterName,
              COALESCE(p.email, s.submitter_email, '') AS submitterEmail,
              (SELECT COUNT(*) FROM submission_speakers ss
                WHERE ss.submission_id = s.id AND ss.event_id = s.event_id) AS speakerCount,
              fv.version_number AS versionNumber, s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
              s.form_version_id AS formVersionId,
              json_extract(s.submitted_snapshot_json, '$.formVersionId') AS snapshotFormVersionId,
              json_extract(s.submitted_snapshot_json, '$.versionNumber') AS snapshotVersionNumber,
              COALESCE((
                SELECT json_group_array(json_object(
                         'trackId', selected_track.track_id,
                         'trackName', selected_track.track_name_snapshot
                       ))
                  FROM submission_track_selections selected_track
                 WHERE selected_track.submission_id = s.id
                   AND selected_track.event_id = s.event_id
                 ORDER BY selected_track.position
              ), '[]') AS selectedTracksJson,
              COALESCE((
                SELECT json_group_array(routed.team_id)
                  FROM (
                    SELECT route.team_id
                      FROM submission_routing_teams route
                     WHERE route.submission_id = s.id AND route.event_id = s.event_id
                     ORDER BY route.team_id
                  ) routed
              ), '[]') AS routedTeamIdsJson,
              CASE
                WHEN s.form_version_id IS NULL
                  THEN json_extract(s.submitted_snapshot_json, '$.routing')
                ELSE fv.routing_json
              END AS routingJson
         FROM (
           SELECT s.id
             FROM submissions s
             JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
             LEFT JOIN people p ON p.id = s.submitter_person_id
             LEFT JOIN form_versions fv
               ON fv.id = s.form_version_id AND fv.event_id = s.event_id
            WHERE ${adminSubmissionFilterSql}
            ORDER BY ${adminSubmissionOrder(filters)}
            LIMIT ? OFFSET ?
         ) page
         JOIN submissions s ON s.id = page.id
         LEFT JOIN people p ON p.id = s.submitter_person_id
         LEFT JOIN form_versions fv
           ON fv.id = s.form_version_id AND fv.event_id = s.event_id
        ORDER BY ${adminSubmissionOrder(filters)}
        `,
    )
    .bind(
      organisationId,
      ...adminSubmissionFilterBindings(eventId, filters),
      pagination.limit,
      pagination.offset,
    );
}

function adminSubmissionCategoriesStatement(
  db: D1Database,
  organisationId: string,
  eventId: string,
) {
  return db
    .prepare(
      `SELECT DISTINCT selection.track_name_snapshot AS category
         FROM submission_track_selections selection
         JOIN submissions s
           ON s.id = selection.submission_id AND s.event_id = selection.event_id
         JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        WHERE selection.event_id = ?
          AND trim(selection.track_name_snapshot) <> ''
       UNION
       SELECT DISTINCT trim(s.category) AS category
         FROM submissions s
         JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        WHERE s.event_id = ? AND s.category IS NOT NULL AND trim(s.category) <> ''
          AND s.status = 'draft'
          AND NOT EXISTS (
            SELECT 1 FROM submission_track_selections selection
             WHERE selection.submission_id = s.id AND selection.event_id = s.event_id
          )
        ORDER BY category COLLATE NOCASE, category`,
    )
    .bind(organisationId, eventId, organisationId, eventId);
}

function adminSubmissionCountStatement(
  db: D1Database,
  organisationId: string,
  eventId: string,
  filters: AdminSubmissionFilters,
) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM submissions s
         JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
         LEFT JOIN people p ON p.id = s.submitter_person_id
         LEFT JOIN form_versions fv
           ON fv.id = s.form_version_id AND fv.event_id = s.event_id
        WHERE ${adminSubmissionFilterSql}`,
    )
    .bind(organisationId, ...adminSubmissionFilterBindings(eventId, filters));
}

function adminSubmissionStatusSummaryStatement(
  db: D1Database,
  organisationId: string,
  eventId: string,
) {
  return db
    .prepare(
      `SELECT submission.status, COUNT(*) AS count
         FROM submissions submission
         JOIN events event
           ON event.id = submission.event_id AND event.organisation_id = ?
        WHERE submission.event_id = ?
        GROUP BY submission.status`,
    )
    .bind(organisationId, eventId);
}

function adminSubmissionRoutedTeamSummaryStatement(
  db: D1Database,
  organisationId: string,
  eventId: string,
) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT route.team_id) AS count
         FROM submission_routing_teams route
         JOIN submissions submission
           ON submission.id = route.submission_id
          AND submission.event_id = route.event_id
         JOIN events event
           ON event.id = submission.event_id AND event.organisation_id = ?
        WHERE route.event_id = ?`,
    )
    .bind(organisationId, eventId);
}

function requireAggregateCount(
  rows: Array<{ count: number }>,
  missingMessage: string,
  invalidMessage: string,
) {
  const row = rows[0];
  if (!row) throw new Error(missingMessage);
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(invalidMessage);
  }
  return count;
}

function adminSubmissionSummary(
  statusRows: Array<{ status: AdminSubmissionStatus; count: number }>,
  routedTeamRows: Array<{ count: number }>,
): AdminSubmissionSummary {
  const byStatus = Object.fromEntries(
    ADMIN_SUBMISSION_STATUSES.map((status) => [status, 0]),
  ) as Record<AdminSubmissionStatus, number>;
  let eventTotal = 0;
  for (const row of statusRows) {
    if (!ADMIN_SUBMISSION_STATUSES.includes(row.status)) {
      throw new Error(`Unknown persisted submission status: ${row.status}`);
    }
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Submission status ${row.status} has an invalid count.`);
    }
    byStatus[row.status] = count;
    eventTotal += count;
  }
  return {
    eventTotal,
    byStatus,
    routedTeamCount: requireAggregateCount(
      routedTeamRows,
      "The routed-team aggregate count was not returned.",
      "The routed-team aggregate count is invalid.",
    ),
  };
}

function mapAdminSubmissionRows(results: AdminSubmissionRow[]) {
  return results.map((result) => {
    const {
      formVersionId,
      snapshotFormVersionId,
      snapshotVersionNumber,
      routingJson,
      routedTeamIdsJson,
      selectedTracksJson,
      ...row
    } = result;
    if (row.status !== "draft" && !row.category) {
      throw new Error(
        `Submission ${row.id} is missing persisted track selections.`,
      );
    }
    if (!routingJson) {
      throw new Error(
        `Submission ${row.id} is missing its immutable routing snapshot.`,
      );
    }
    const routing = routingSchema.parse(JSON.parse(routingJson));
    const routedTeamIds = z
      .array(z.string())
      .parse(JSON.parse(routedTeamIdsJson));
    const selectedTracks = z
      .array(z.object({ trackId: z.string(), trackName: z.string() }))
      .parse(JSON.parse(selectedTracksJson));
    const routingState = classifySubmissionRouting({
      submissionId: row.id,
      status: row.status,
      formVersionId,
      snapshotFormVersionId,
      versionNumber: row.versionNumber,
      snapshotVersionNumber,
      routing,
      selectedTracks,
      routedTeamIds,
    });
    return {
      ...row,
      category: row.category ?? "",
      speakerCount: Number(row.speakerCount),
      routedTeamIds,
      routedTo: requireRoutedTeamSummary(row.id, routedTeamIds, routing),
      routingState,
    };
  });
}

export class SubmissionAdminRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async listAdminSubmissionPage(
    organisationId: string,
    eventId: string,
    filters: AdminSubmissionFilters,
    pagination: { limit: number; offset: number },
  ) {
    const [rowResult, categoryResult, countResult, statusResult, routedResult] =
      await this.env.DB.batch([
        adminSubmissionRowsStatement(
          this.env.DB,
          organisationId,
          eventId,
          filters,
          pagination,
        ),
        adminSubmissionCategoriesStatement(
          this.env.DB,
          organisationId,
          eventId,
        ),
        adminSubmissionCountStatement(
          this.env.DB,
          organisationId,
          eventId,
          filters,
        ),
        adminSubmissionStatusSummaryStatement(
          this.env.DB,
          organisationId,
          eventId,
        ),
        adminSubmissionRoutedTeamSummaryStatement(
          this.env.DB,
          organisationId,
          eventId,
        ),
      ]);
    const matchingTotal = requireAggregateCount(
      countResult.results as unknown as Array<{ count: number }>,
      "The submission result count was not returned.",
      "The submission result count is invalid.",
    );
    return {
      submissions: mapAdminSubmissionRows(
        rowResult.results as unknown as AdminSubmissionRow[],
      ),
      categories: (
        categoryResult.results as unknown as Array<{ category: string }>
      ).map((row) => row.category),
      matchingTotal,
      summary: adminSubmissionSummary(
        statusResult.results as unknown as Array<{
          status: AdminSubmissionStatus;
          count: number;
        }>,
        routedResult.results as unknown as Array<{ count: number }>,
      ),
    };
  }

  async listAdminSubmissions(
    organisationId: string,
    eventId: string,
    filters: AdminSubmissionFilters,
    pagination: { limit: number; offset: number } = { limit: 200, offset: 0 },
  ): Promise<AdminSubmission[]> {
    const rows = await adminSubmissionRowsStatement(
      this.env.DB,
      organisationId,
      eventId,
      filters,
      pagination,
    ).all<AdminSubmissionRow>();
    return mapAdminSubmissionRows(rows.results);
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
             CASE WHEN EXISTS (
               SELECT 1 FROM memberships participant_membership
                WHERE participant_membership.event_id = s.event_id
                  AND participant_membership.organisation_id = e.organisation_id
                  AND participant_membership.person_id = s.submitter_person_id
                  AND participant_membership.role IN ('speaker','submitter')
                  AND participant_membership.accepted_at IS NOT NULL
                  AND participant_membership.revoked_at IS NULL
             ) THEN s.submitter_person_id ELSE NULL END AS participantPreviewPersonId,
             s.form_version_id AS formVersionId,
             fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             json_extract(fv.settings_snapshot_json, '$.name') AS formName,
             EXISTS (
               SELECT 1 FROM evaluation_plans plan
                WHERE plan.event_id = s.event_id
                  AND plan.status <> 'archived'
             ) AS hasEvaluationPlan,
             COALESCE((
               SELECT json_group_array(routed.team_id)
                 FROM (
                   SELECT route.team_id
                     FROM submission_routing_teams route
                    WHERE route.submission_id = s.id AND route.event_id = s.event_id
                    ORDER BY route.team_id
                 ) routed
             ), '[]') AS routedTeamIdsJson,
             COALESCE(
               fv.routing_json,
               json_extract(s.submitted_snapshot_json, '$.routing')
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
        LEFT JOIN form_versions fv
          ON fv.id = s.form_version_id AND fv.event_id = s.event_id
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
        participantPreviewPersonId: string | null;
        formVersionId: string | null;
        versionNumber: number | null;
        formName: string | null;
        hasEvaluationPlan: number | boolean;
        schemaJson: string | null;
        routingJson: string | null;
        routedTeamIdsJson: string;
        snapshotJson: string | null;
        latestSpeakerSnapshotJson: string | null;
      }>();
    if (!row) return null;
    if (!row.routingJson) {
      throw new Error(
        `Submission ${row.id} is missing its immutable routing snapshot.`,
      );
    }
    const [speakers, selectedTracks, savedRevisions, statusTimeline] =
      await Promise.all([
        this.env.DB.prepare(
          `
      SELECT ss.id, ss.person_id AS personId, ss.display_name AS name,
             ss.email, ss.position, ss.invitation_status AS invitationStatus,
             ss.is_primary AS isPrimary, ss.role_label AS roleLabel,
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
            roleLabel: string | null;
            currentBiography: string;
          }>(),
        this.env.DB.prepare(
          `SELECT track_id AS trackId, track_name_snapshot AS trackName
           FROM submission_track_selections
          WHERE submission_id = ? AND event_id = ?
          ORDER BY position`,
        )
          .bind(submissionId, eventId)
          .all<{ trackId: string; trackName: string }>(),
        this.env.DB.prepare(
          `SELECT revision.revision_number AS revisionNumber,
                revision.save_kind AS saveKind,
                revision.created_at AS createdAt,
                COALESCE(person.display_name, 'System') AS savedByName,
                version.version_number AS formVersionNumber,
                COALESCE(json_extract(version.settings_snapshot_json, '$.name'),
                         'Application form') AS formName,
                (SELECT COUNT(*) FROM json_each(revision.answers_json)) AS answerCount,
                json_array_length(revision.speaker_snapshot_json) AS speakerCount
           FROM submission_revisions revision
           JOIN submissions submission
             ON submission.id = revision.submission_id
            AND submission.event_id = revision.event_id
           JOIN events event
             ON event.id = submission.event_id AND event.organisation_id = ?
           JOIN form_versions version
             ON version.id = revision.form_version_id
            AND version.event_id = revision.event_id
           LEFT JOIN people person ON person.id = revision.saved_by_person_id
          WHERE revision.event_id = ? AND revision.submission_id = ?
            AND revision.save_kind <> 'autosave'
          ORDER BY revision.revision_number DESC
          LIMIT 50`,
        )
          .bind(organisationId, eventId, submissionId)
          .all<{
            revisionNumber: number;
            saveKind: "manual" | "submitted" | "withdrawn";
            createdAt: number;
            savedByName: string;
            formVersionNumber: number;
            formName: string;
            answerCount: number;
            speakerCount: number;
          }>(),
        new AuditReader(this.env).eventEntityHistory(
          { organisationId, eventId },
          {
            entityType: "submission",
            entityId: submissionId,
            relatedMetadataKey: "submissionId",
            actions: [
              "submission.draft.created",
              "submission.manual.created",
              "submission.submitted",
              "submission.revised",
              "submission.updated",
              "submission.withdrawn",
            ],
            limit: 50,
          },
        ),
      ]);
    const snapshot =
      row.status === "draft"
        ? null
        : requireSubmittedSnapshot(row.id, row.snapshotJson);
    const routing = routingSchema.parse(JSON.parse(row.routingJson));
    const routedTeamIds = z
      .array(z.string())
      .parse(JSON.parse(row.routedTeamIdsJson));
    const routingExplanation = explainSubmissionRouting({
      submissionId: row.id,
      status: row.status,
      formVersionId: row.formVersionId,
      snapshotFormVersionId: snapshot?.formVersionId ?? null,
      snapshotVersionNumber: snapshot?.versionNumber ?? null,
      formName: row.formName,
      versionNumber: row.versionNumber,
      routing,
      selectedTracks: selectedTracks.results,
      routedTeamIds,
    });
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
        ? parseJson(row.schemaJson, storedFormSchemaSchema)
        : null;
    if (!schema) {
      throw new Error(`Submission ${row.id} is missing its form schema.`);
    }
    const {
      answersJson: _answersJson,
      formVersionId: _formVersionId,
      formName: _formName,
      hasEvaluationPlan,
      schemaJson: _schemaJson,
      routingJson: _routingJson,
      routedTeamIdsJson: _routedTeamIdsJson,
      snapshotJson: _snapshotJson,
      latestSpeakerSnapshotJson: _latestSpeakerSnapshotJson,
      ...summary
    } = row;
    return {
      ...summary,
      hasEvaluationPlan: Boolean(hasEvaluationPlan),
      ...(snapshot
        ? {
            title: requireSnapshotTitle(row.id, snapshot),
            category: snapshotSummaryAnswer(snapshot, "category"),
            format: snapshotSummaryAnswer(snapshot, "format"),
          }
        : {}),
      answers,
      schema,
      routedTeamIds,
      routedTo: requireRoutedTeamSummary(row.id, routedTeamIds, routing),
      routingExplanation,
      savedRevisions: savedRevisions.results,
      statusTimeline,
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

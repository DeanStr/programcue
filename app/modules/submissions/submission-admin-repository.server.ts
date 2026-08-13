import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  formSchemaSchema,
  routingSchema,
  submittedSnapshotSchema,
  type FormRouting,
  type SubmittedSnapshot,
} from "./submission-schema";
import { z } from "zod";
import {
  parseJson,
  type AdminSubmission,
  type AdminSubmissionFilters,
} from "./submission-repository-shared";
import {
  classifySubmissionRouting,
  explainSubmissionRouting,
} from "./submission-routing-explanation";

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

export class SubmissionAdminRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async listAdminSubmissionCategories(
    organisationId: string,
    eventId: string,
  ): Promise<string[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT DISTINCT selection.track_name_snapshot AS category
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
       ORDER BY category COLLATE NOCASE, category
    `,
    )
      .bind(organisationId, eventId, organisationId, eventId)
      .all<{ category: string }>();
    return rows.results.map((row) => row.category);
  }

  async listAdminSubmissions(
    organisationId: string,
    eventId: string,
    filters: AdminSubmissionFilters,
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
      SELECT s.id, s.public_reference AS publicReference, s.title,
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
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv
          ON fv.id = s.form_version_id AND fv.event_id = s.event_id
       WHERE s.event_id = ?
         AND (? = '' OR s.status = ?)
         AND (? = '' OR (s.status = 'draft' AND s.category = ?) OR EXISTS (
           SELECT 1 FROM submission_track_selections selected_filter
            WHERE selected_filter.submission_id = s.id
              AND selected_filter.event_id = s.event_id
              AND selected_filter.track_name_snapshot = ?
         ))
         AND (? = '%%' OR s.title LIKE ? OR p.display_name LIKE ? OR COALESCE(p.email, s.submitter_email) LIKE ?)
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
                      FROM json_each(
                        CASE
                          WHEN s.form_version_id IS NULL
                            THEN json_extract(s.submitted_snapshot_json, '$.routing')
                          ELSE fv.routing_json
                        END,
                        '$.categories'
                      ) automatic_route
                     WHERE automatic_route.key = selected_route.track_name_snapshot
                       AND typeof(automatic_route.value) = 'text'
                       AND trim(automatic_route.value) <> ''
                  )
             )
           )
         )
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
        filters.category ?? "",
        query,
        query,
        query,
        query,
        filters.routing ?? "",
        filters.routing ?? "",
        ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        filters.routing ?? "",
        pagination.limit,
        pagination.offset,
      )
      .all<
        Omit<
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
        }
      >();
    return rows.results.map((result) => {
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
    const [speakers, selectedTracks] = await Promise.all([
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
        ? parseJson(row.schemaJson, formSchemaSchema)
        : null;
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

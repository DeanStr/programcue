import { requireValue } from "~/lib/required-value";
import {
  isCanonicalSessionDetailsReviewTask,
  loadParticipantSessionDetailsReview,
  SESSION_DETAILS_REVIEW_PRESET,
  sessionDetailsReviewEvidenceSchema,
} from "~/modules/tasks/session-details-review.server";
import { assignedTaskConfigurationSchema } from "~/modules/tasks/task-schema";
import { participantTaskAccessSql } from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
} from "./api-pagination.server";
import type {
  ParticipantApiResource,
  ParticipantQuery,
} from "./api-participant-service.server";

type PageRow = { id: string; sort: number } & Record<string, unknown>;

function parseJson(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid persisted JSON.`);
  }
}

function cursor(input: ParticipantQuery) {
  if (!input.cursor) return { sql: "", bindings: [] as unknown[] };
  const decoded = decodePrivateCursor(input.cursor);
  return {
    sql: " AND (base.sort < ? OR (base.sort = ? AND base.id < ?))",
    bindings: [decoded.sort, decoded.sort, decoded.id],
  };
}

export class ApiParticipantResourceReader {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(
    viewer: Viewer,
    resource: Exclude<ParticipantApiResource, "profile">,
    input: ParticipantQuery & { limit: number },
  ) {
    const rows = await this.query(viewer, resource, input);
    const visible = rows.slice(0, input.limit);
    const records = visible.map(({ sort: _sort, ...row }) =>
      this.serialise(resource, row),
    );
    if (resource === "tasks" && records.length) {
      const ids = records.map((record) => String(record.id));
      const [dependencies, comments] = await Promise.all([
        this.env.DB.prepare(
          `WITH requested_tasks(id) AS (
             SELECT CAST(value AS TEXT) FROM json_each(?)
           ), scoped_dependencies AS (
             SELECT dependency.task_id AS taskId, prerequisite.id,
                    prerequisite.title, prerequisite.status,
                    CASE WHEN prerequisite.event_id = ?
                               AND ${participantTaskAccessSql("prerequisite", true)}
                         THEN 1 ELSE 0 END AS participantAccessible
               FROM task_instance_dependencies dependency
               JOIN requested_tasks requested ON requested.id = dependency.task_id
               JOIN task_instances prerequisite
                 ON prerequisite.id = dependency.depends_on_task_id
           )
           SELECT taskId, id, title, status
             FROM scoped_dependencies
            WHERE participantAccessible = 1
           UNION ALL
           SELECT taskId, 'restricted-prerequisite:' || taskId,
                  'a prerequisite managed by the event team', 'blocked'
             FROM scoped_dependencies
            WHERE participantAccessible = 0
            GROUP BY taskId
            ORDER BY taskId, title`,
        )
          .bind(
            JSON.stringify(ids),
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
          )
          .all<Record<string, unknown> & { taskId: string }>(),
        this.env.DB.prepare(
          `SELECT comment.id, comment.task_id AS taskId, comment.body,
                  comment.created_at AS createdAt,
                  author.display_name AS authorName
             FROM task_comments comment
             JOIN people author ON author.id = comment.author_person_id
            WHERE comment.task_id IN (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            ) AND comment.visibility = 'participant'
            ORDER BY comment.task_id, comment.created_at, comment.id`,
        )
          .bind(JSON.stringify(ids))
          .all<
            Record<string, unknown> & { taskId: string; createdAt: number }
          >(),
      ]);
      for (const record of records) {
        const taskDependencies = dependencies.results.filter(
          (item) => item.taskId === record.id,
        );
        record.dependencies = taskDependencies;
        if (
          !["completed", "waived", "submitted"].includes(
            String(record.status),
          ) &&
          taskDependencies.some((item) =>
            String(item.id).startsWith("restricted-prerequisite:"),
          )
        ) {
          record.status = "blocked";
          record.readinessState = "blocked";
          record.readinessPercent = 0;
        }
        record.comments = comments.results
          .filter((item) => item.taskId === record.id)
          .map((item) => ({
            ...item,
            createdAt: isoTimestamp(item.createdAt),
          }));
        const configuration = assignedTaskConfigurationSchema.parse(
          record.configuration,
        );
        if (configuration.preset === SESSION_DETAILS_REVIEW_PRESET) {
          const taskId = String(record.id);
          if (
            !(await isCanonicalSessionDetailsReviewTask(
              this.env,
              viewer.eventId,
              taskId,
            ))
          ) {
            throw new Error(
              `Session-details review task ${taskId} differs from the required shared acknowledgement.`,
            );
          }
          const review = await loadParticipantSessionDetailsReview(
            this.env,
            viewer,
            String(record.targetId),
          );
          if (!review) {
            throw new Error(
              `Session-details review task ${taskId} is no longer available to this participant.`,
            );
          }
          const evidence = record.evidence;
          const historicalReview =
            evidence && typeof evidence === "object" && !Array.isArray(evidence)
              ? (evidence as Record<string, unknown>).sessionDetailsReview
              : undefined;
          if (
            record.status === "completed" &&
            !sessionDetailsReviewEvidenceSchema.safeParse(historicalReview)
              .success
          ) {
            throw new Error(
              `Completed session-details review task ${taskId} is missing its canonical review evidence.`,
            );
          }
          record.sessionDetailsReview = review;
        }
      }
    }
    return {
      [resource]: records,
      nextCursor:
        rows.length > input.limit && visible.length
          ? encodePrivateCursor(
              requireValue(
                visible.at(-1),
                "Required visible.at(-1) is unavailable.",
              ).sort,
              String(
                requireValue(
                  visible.at(-1),
                  "Required visible.at(-1) is unavailable.",
                ).id,
              ),
            )
          : null,
    };
  }

  private async query(
    viewer: Viewer,
    resource: Exclude<ParticipantApiResource, "profile">,
    input: ParticipantQuery & { limit: number },
  ): Promise<PageRow[]> {
    const continuation = cursor(input);
    const limit = input.limit + 1;
    if (resource === "submissions") {
      const statusSql = input.status ? " AND base.status = ?" : "";
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT submission.id, submission.updated_at AS sort,
                    submission.public_reference AS publicReference,
                    form.id AS formId, form.name AS formName,
                    form.public_slug AS formSlug, form.kind AS formKind,
                    form.status AS formStatus, version.schema_json AS schemaJson,
                    form.max_speakers AS maxSpeakers,
                    submission.title, submission.category, submission.format,
                    submission.status, submission.revision,
                    submission.answers_json AS answersJson,
                    submission.submitted_snapshot_json AS submittedSnapshotJson,
                    EXISTS (
                      SELECT 1 FROM sessions published_session
                       WHERE published_session.source_submission_id = submission.id
                         AND published_session.event_id = submission.event_id
                         AND published_session.status = 'published'
                    ) AS speakerListPublished,
                    (
                      SELECT COUNT(*) = 1
                        FROM sessions editable_session
                       WHERE editable_session.source_submission_id = submission.id
                         AND editable_session.event_id = submission.event_id
                         AND editable_session.status IN ('unscheduled','scheduled')
                    ) AND (
                      SELECT COUNT(*) = 1
                        FROM sessions derived_session
                       WHERE derived_session.source_submission_id = submission.id
                         AND derived_session.event_id = submission.event_id
                    ) AS speakerListEditable,
                    (
                      SELECT json_group_array(json(ordered_speaker.value))
                        FROM (
                          SELECT json_object(
                            'id', speaker.id,
                            'name', speaker.display_name,
                            'email', speaker.email,
                            'roleLabel', speaker.role_label,
                            'invitationStatus', speaker.invitation_status,
                            'isPrimary', speaker.is_primary
                          ) AS value
                            FROM submission_speakers speaker
                           WHERE speaker.submission_id = submission.id
                             AND speaker.event_id = submission.event_id
                           ORDER BY speaker.position
                        ) ordered_speaker
                    ) AS speakersJson,
                    submission.submitter_person_id = ? AS primarySubmitter,
                    submission.submitted_at AS submittedAt,
                    submission.withdrawn_at AS withdrawnAt,
                    submission.created_at AS createdAt,
                    submission.updated_at AS updatedAt
               FROM submissions submission
               JOIN events event ON event.id = submission.event_id
                 AND event.organisation_id = ?
               JOIN form_versions version
                 ON version.id = submission.form_version_id
                AND version.event_id = submission.event_id
               JOIN form_definitions form
                 ON form.id = version.form_id AND form.event_id = submission.event_id
              WHERE submission.event_id = ?
                AND (
                  submission.submitter_person_id = ?
                  OR EXISTS (
                    SELECT 1 FROM submission_speakers speaker
                     WHERE speaker.submission_id = submission.id
                       AND speaker.event_id = submission.event_id
                       AND speaker.person_id = ?
                       AND speaker.invitation_status = 'claimed'
                  )
                )
           ) base WHERE 1 = 1${statusSql}${continuation.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            viewer.personId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            ...(input.status ? [input.status] : []),
            ...continuation.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "sessions") {
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT session.id, session.updated_at AS sort,
                    session.title, session.slug, session.description,
                    session.format, session.duration_minutes AS durationMinutes,
                    session.status, session.visibility, session.revision,
                    relationship.role_label AS roleLabel,
                    entry.starts_at AS startsAt, entry.ends_at AS endsAt,
                    room.name AS roomName,
                    session.created_at AS createdAt,
                    session.updated_at AS updatedAt
               FROM session_speakers relationship
               JOIN sessions session
                 ON session.id = relationship.session_id
                AND session.event_id = relationship.event_id
               JOIN events event ON event.id = session.event_id
                 AND event.organisation_id = ?
               LEFT JOIN schedule_versions version
                 ON version.event_id = session.event_id
                AND version.status = 'published'
               LEFT JOIN schedule_entries entry
                 ON entry.schedule_version_id = version.id
                AND entry.event_id = session.event_id
                AND entry.session_id = session.id
               LEFT JOIN rooms room
                 ON room.id = entry.room_id AND room.event_id = session.event_id
              WHERE relationship.event_id = ? AND relationship.person_id = ?
                AND session.status <> 'archived'
           ) base WHERE 1 = 1${continuation.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            ...continuation.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "files") {
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT asset.id, asset.updated_at AS sort,
                    asset.asset_kind AS kind, asset.target_type AS targetType,
                    asset.target_id AS targetId, asset.status,
                    asset.current_version_id AS currentVersionId,
                    version.original_filename AS filename,
                    COALESCE(
                      version.detected_content_type,
                      version.declared_content_type
                    ) AS contentType,
                    version.size_bytes AS sizeBytes,
                    version.upload_status AS uploadStatus,
                    version.signature_status AS signatureStatus,
                    version.scan_status AS scanStatus,
                    version.version_number AS versionNumber,
                    version.released_at AS releasedAt,
                    asset.created_at AS createdAt,
                    asset.updated_at AS updatedAt
               FROM file_assets asset
               JOIN events event ON event.id = asset.event_id
                 AND event.organisation_id = ?
               LEFT JOIN task_instances task
                 ON asset.target_type = 'task'
                AND task.id = asset.target_id
                AND task.event_id = asset.event_id
               LEFT JOIN file_versions version
                 ON version.id = asset.current_version_id
                AND version.event_id = asset.event_id
                AND version.deleted_at IS NULL
              WHERE asset.event_id = ? AND asset.owner_person_id = ?
                AND asset.status <> 'deleted'
                AND (
                  asset.target_type <> 'task'
                  OR (
                    task.id IS NOT NULL
                    AND ${participantTaskAccessSql("task", true)}
                  )
                )
           ) base WHERE 1 = 1${continuation.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
            ...continuation.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    return (
      await this.env.DB.prepare(
        `SELECT * FROM (
           SELECT task.id, task.updated_at AS sort,
                  task.template_id AS templateId,
                  task.target_type AS targetType, task.target_id AS targetId,
                  task.owner_person_id AS ownerPersonId,
                  owner.display_name AS ownerName,
                  task.title, task.description, task.task_type AS taskType,
                  task.impact,
                  CASE
                    WHEN task.status IN ('not_started','in_progress')
                     AND task.due_at IS NOT NULL AND task.due_at < unixepoch()
                    THEN 'overdue' ELSE task.status
                  END AS status,
                  task.readiness_state AS readinessState,
                  task.readiness_percent AS readinessPercent,
                  task.revision, task.due_at AS dueAt,
                  task.configuration_json AS configurationJson,
                  task.evidence_json AS evidenceJson,
                  task.waiver_json AS waiverJson,
                  task.submitted_at AS submittedAt,
                  task.completed_at AS completedAt,
                  task.created_at AS createdAt,
                  task.updated_at AS updatedAt
             FROM task_instances task
             JOIN events event ON event.id = task.event_id
               AND event.organisation_id = ?
             LEFT JOIN people owner ON owner.id = task.owner_person_id
            WHERE task.event_id = ?
              AND ${participantTaskAccessSql("task", true)}
         ) base WHERE 1 = 1${continuation.sql}
         ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          viewer.personId,
          viewer.personId,
          ...continuation.bindings,
          limit,
        )
        .all<PageRow>()
    ).results;
  }

  private serialise(
    resource: Exclude<ParticipantApiResource, "profile">,
    row: Record<string, unknown>,
  ) {
    const result = { ...row };
    for (const field of [
      "startsAt",
      "endsAt",
      "dueAt",
      "releasedAt",
      "submittedAt",
      "withdrawnAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ]) {
      if (field in result) {
        result[field] = isoTimestamp(result[field] as number | null);
      }
    }
    if (resource === "submissions") {
      result.primarySubmitter = Boolean(result.primarySubmitter);
      result.speakerListPublished = Boolean(result.speakerListPublished);
      result.speakerListEditable = Boolean(result.speakerListEditable);
      result.schema = parseJson(
        result.schemaJson,
        `Submission ${String(result.id)} form schema`,
      );
      result.answers = parseJson(
        result.answersJson,
        `Submission ${String(result.id)} answers`,
      );
      result.submittedSnapshot = parseJson(
        result.submittedSnapshotJson,
        `Submission ${String(result.id)} submitted snapshot`,
      );
      const speakers = parseJson(
        result.speakersJson,
        `Submission ${String(result.id)} current speakers`,
      );
      if (!Array.isArray(speakers)) {
        throw new Error(
          `Submission ${String(result.id)} current speakers must be a JSON array.`,
        );
      }
      result.speakers = speakers.map((speaker) => {
        if (
          !speaker ||
          typeof speaker !== "object" ||
          Array.isArray(speaker) ||
          typeof (speaker as Record<string, unknown>).isPrimary !== "number"
        ) {
          throw new Error(
            `Submission ${String(result.id)} contains an invalid current speaker relationship.`,
          );
        }
        return {
          ...(speaker as Record<string, unknown>),
          isPrimary: Boolean((speaker as Record<string, unknown>).isPrimary),
        };
      });
      delete result.answersJson;
      delete result.schemaJson;
      delete result.submittedSnapshotJson;
      delete result.speakersJson;
    }
    if (resource === "tasks") {
      result.configuration = assignedTaskConfigurationSchema.parse(
        parseJson(
          result.configurationJson,
          `Task ${String(result.id)} configuration`,
        ),
      );
      result.evidence = parseJson(
        result.evidenceJson,
        `Task ${String(result.id)} evidence`,
      );
      result.waiver = parseJson(
        result.waiverJson,
        `Task ${String(result.id)} waiver`,
      );
      delete result.configurationJson;
      delete result.evidenceJson;
      delete result.waiverJson;
    }
    return result;
  }
}

import { z } from "zod";

import {
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Applicant } from "~/modules/submissions/submission-repository.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "./api-pagination.server";
import { ApiError } from "./api.server";

export const PARTICIPANT_API_RESOURCES = [
  "profile",
  "submissions",
  "sessions",
  "files",
  "tasks",
] as const;

export type ParticipantApiResource = (typeof PARTICIPANT_API_RESOURCES)[number];

const resourceSchema = z.enum(PARTICIPANT_API_RESOURCES);
const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);
const pageQuery = {
  limit: limitSchema,
  cursor: z.string().trim().min(1).max(512).optional(),
};
const querySchemas = {
  profile: z.object({}).strict(),
  submissions: z
    .object({
      ...pageQuery,
      status: z
        .enum([
          "draft",
          "submitted",
          "assigned",
          "in_review",
          "decision_ready",
          "accepted",
          "waitlisted",
          "rejected",
          "withdrawn",
        ])
        .optional(),
    })
    .strict(),
  sessions: z.object(pageQuery).strict(),
  files: z.object(pageQuery).strict(),
  tasks: z.object(pageQuery).strict(),
} satisfies Record<ParticipantApiResource, z.ZodType>;

type ParticipantQuery = {
  limit?: number;
  cursor?: string;
  status?: string;
};

type PageRow = { id: string; sort: number } & Record<string, unknown>;

export const participantProfilePatchSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(2).max(120),
    biography: z.string().trim().min(40).max(2_000),
  })
  .strict();

export function parseParticipantResource(value: string | undefined) {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      404,
      "API_RESOURCE_NOT_FOUND",
      "Participant API resource not found",
    );
  }
  return parsed.data;
}

export function parseParticipantQuery(
  request: Request,
  resource: ParticipantApiResource,
) {
  return parseStrictQuery(
    request,
    querySchemas[resource] as unknown as z.ZodType<ParticipantQuery>,
    `The participant ${resource} query parameters are invalid`,
  );
}

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

type ParticipantCommandRecord = {
  id: string;
  requestHash: string;
  status: string;
  responseJson: string | null;
};

type ParticipantCommandRecovery<T> = {
  response: T | null;
  progressed: boolean;
};

const MAX_PARTICIPANT_COMMAND_RESPONSE_BYTES = 64 * 1_024;

function serialiseParticipantCommandResponse(value: unknown) {
  const serialised = JSON.stringify(value);
  if (serialised === undefined) {
    throw new TypeError(
      "A participant command result must be JSON serializable.",
    );
  }
  if (
    new TextEncoder().encode(serialised).byteLength >
    MAX_PARTICIPANT_COMMAND_RESPONSE_BYTES
  ) {
    throw new TypeError("A participant command result cannot exceed 64 KB.");
  }
  return serialised;
}

export class ApiParticipantService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async profile(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    return this.profileD1(viewer);
  }

  private async profileD1(viewer: Viewer) {
    const profile = await this.env.DB.prepare(
      `SELECT person.id, person.email, person.display_name AS name,
              person.biography, person.pronunciation,
              person.organisation_name AS organisationName,
              person.job_title AS jobTitle,
              person.profile_status AS profileStatus,
              person.profile_revision AS revision,
              person.email_verified AS emailVerified,
              person.created_at AS createdAt,
              person.updated_at AS updatedAt
         FROM people person
         JOIN events event ON event.id = ? AND event.organisation_id = ?
        WHERE person.id = ?
          AND (
            EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.event_id = event.id
                 AND membership.person_id = person.id
                 AND membership.role IN ('speaker','submitter')
                 AND membership.accepted_at IS NOT NULL
                 AND membership.revoked_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM submission_speakers speaker
               WHERE speaker.event_id = event.id
                 AND speaker.person_id = person.id
                 AND speaker.invitation_status = 'claimed'
            )
          )`,
    )
      .bind(viewer.eventId, viewer.organisationId, viewer.personId)
      .first<
        Record<string, unknown> & {
          emailVerified: number;
          createdAt: number;
          updatedAt: number;
        }
      >();
    if (!profile) {
      throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "Participant not found");
    }
    return {
      ...profile,
      emailVerified: Boolean(profile.emailVerified),
      createdAt: isoTimestamp(profile.createdAt),
      updatedAt: isoTimestamp(profile.updatedAt),
    };
  }

  async updateProfile(
    viewer: Viewer,
    input: z.infer<typeof participantProfilePatchSchema>,
    correlationId: string,
    operationId: string = crypto.randomUUID(),
  ) {
    const command = await airtableIntentCommand(
      "participant.profile.update",
      viewer,
      operationId,
      input,
    );
    return this.airtable.executeIdempotent(viewer, command, () =>
      this.updateProfileD1(viewer, input, correlationId, operationId),
    );
  }

  private async updateProfileD1(
    viewer: Viewer,
    input: z.infer<typeof participantProfilePatchSchema>,
    correlationId: string,
    operationId: string,
  ) {
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE people
            SET display_name = ?, biography = ?,
                profile_revision = profile_revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND profile_revision = ? AND email_verified = 1
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = ? AND event.organisation_id = ?
                 AND (
                   EXISTS (
                     SELECT 1 FROM memberships membership
                      WHERE membership.event_id = event.id
                        AND membership.person_id = people.id
                        AND membership.role IN ('speaker','submitter')
                        AND membership.accepted_at IS NOT NULL
                        AND membership.revoked_at IS NULL
                   )
                   OR EXISTS (
                     SELECT 1 FROM submission_speakers speaker
                      WHERE speaker.event_id = event.id
                        AND speaker.person_id = people.id
                        AND speaker.invitation_status = 'claimed'
                   )
                 )
            )`,
      ).bind(
        input.name,
        input.biography,
        operationId,
        viewer.personId,
        input.revision,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE submission_speakers
            SET display_name = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?
            AND invitation_status = 'claimed'
            AND EXISTS (
              SELECT 1 FROM people
               WHERE id = ? AND last_operation_id = ?
            )`,
      ).bind(
        input.name,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'participant.profile.updated', 'person', ?, ?, ?,
                  unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM people
               WHERE id = ? AND last_operation_id = ?
            )`,
      ).bind(
        `participant-profile:${operationId}`,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        correlationId,
        JSON.stringify({ revision: input.revision + 1 }),
        viewer.personId,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new ApiError(
        409,
        "PARTICIPANT_REVISION_CONFLICT",
        "The participant profile changed; refresh before saving again",
      );
    }
    return { profile: await this.profileD1(viewer) };
  }

  async recoverProfileUpdate(
    viewer: Viewer,
    input: z.infer<typeof participantProfilePatchSchema>,
    operationId: string,
  ): Promise<ParticipantCommandRecovery<{ profile: Record<string, unknown> }>> {
    const committed = await this.env.DB.prepare(
      `SELECT id FROM people
        WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
          AND EXISTS (
            SELECT 1 FROM events
             WHERE id = ? AND organisation_id = ?
          )`,
    )
      .bind(
        viewer.personId,
        input.revision + 1,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first();
    return committed
      ? {
          response: {
            profile: (await this.profile(viewer)) as Record<string, unknown>,
          },
          progressed: true,
        }
      : { response: null, progressed: false };
  }

  async recoverTaskCompletion(
    viewer: Viewer,
    taskId: string,
    previousRevision: number,
    operationId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT task.id AS taskId, task.status, task.revision
         FROM task_instances task
         JOIN events event
           ON event.id = task.event_id AND event.organisation_id = ?
        WHERE task.id = ? AND task.event_id = ?
          AND task.last_operation_id = ? AND task.revision = ?
          AND task.status IN ('completed','submitted')
          AND (
            task.owner_person_id = ?
            OR (task.target_type = 'speaker' AND task.target_id = ?)
            OR (task.target_type = 'session' AND EXISTS (
              SELECT 1 FROM session_speakers speaker
               WHERE speaker.event_id = task.event_id
                 AND speaker.session_id = task.target_id
                 AND speaker.person_id = ?
            ))
          )`,
    )
      .bind(
        viewer.organisationId,
        taskId,
        viewer.eventId,
        operationId,
        previousRevision + 1,
        viewer.personId,
        viewer.personId,
        viewer.personId,
      )
      .first<{
        taskId: string;
        status: "completed" | "submitted";
        revision: number;
      }>();
  }

  async recoverSubmissionCommand(
    viewer: Viewer,
    submissionId: string,
    command: "submit" | "withdraw",
    operationId: string,
  ): Promise<
    ParticipantCommandRecovery<{
      submission: {
        id: string;
        status: string;
        revision?: number;
        directSessionId?: string | null;
      };
    }>
  > {
    const row = await this.env.DB.prepare(
      `SELECT submission.status, submission.revision,
              submission.last_operation_id AS lastOperationId
         FROM submissions submission
         JOIN events event ON event.id = submission.event_id
           AND event.organisation_id = ?
        WHERE submission.id = ? AND submission.event_id = ?
          AND submission.submitter_person_id = ?`,
    )
      .bind(
        viewer.organisationId,
        submissionId,
        viewer.eventId,
        viewer.personId,
      )
      .first<{
        status: string;
        revision: number;
        lastOperationId: string | null;
      }>();
    if (!row) return { response: null, progressed: false };
    if (command === "withdraw") {
      return row.status === "withdrawn" && row.lastOperationId === operationId
        ? {
            response: {
              submission: {
                id: submissionId,
                status: "withdrawn",
                revision: row.revision,
              },
            },
            progressed: true,
          }
        : { response: null, progressed: false };
    }
    if (row.status === "draft") {
      return {
        response: null,
        progressed: row.lastOperationId === `${operationId}:draft`,
      };
    }
    if (row.lastOperationId !== operationId) {
      return { response: null, progressed: false };
    }
    const materialised = await this.env.DB.prepare(
      `SELECT entity_id AS sessionId
         FROM audit_events
        WHERE event_id = ? AND action = 'session.direct.public_materialized'
          AND json_extract(metadata_json, '$.intakeReference') = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(viewer.eventId, submissionId)
      .first<{ sessionId: string }>();
    return {
      response: {
        submission: {
          id: submissionId,
          status: row.status,
          directSessionId: materialised?.sessionId ?? null,
        },
      },
      progressed: true,
    };
  }

  async resumeSubmissionNotifications(viewer: Viewer, submissionId: string) {
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const jobs = await this.env.DB.prepare(
      `SELECT job.id, job.payload_json AS payloadJson,
              communication.id AS communicationId
         FROM operation_jobs job
         LEFT JOIN communications communication
           ON communication.operation_id = job.id
          AND communication.event_id = job.event_id
        WHERE job.organisation_id = ? AND job.event_id = ?
          AND job.status = 'queued'
          AND (
            (job.type = 'submission.notification'
             AND job.idempotency_key = ?)
            OR
            (job.type = 'communication.send'
             AND json_extract(communication.audience_json, '$.submissionId') = ?)
          )
        ORDER BY job.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        `submission-confirmation:${submissionId}`,
        submissionId,
      )
      .all<{
        id: string;
        payloadJson: string;
        communicationId: string | null;
      }>();
    for (const job of jobs.results) {
      try {
        let message: unknown;
        try {
          message = JSON.parse(job.payloadJson);
        } catch {
          throw new Error(
            `Submission operation ${job.id} contains invalid persisted JSON.`,
          );
        }
        await operationsQueue.send(message);
      } catch (error) {
        const failure = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 2_000);
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'queue_failed', last_error = ?,
                    updated_at = unixepoch()
              WHERE id = ? AND organisation_id = ? AND event_id = ?
                AND status = 'queued'`,
          ).bind(failure, job.id, viewer.organisationId, viewer.eventId),
          this.env.DB.prepare(
            `UPDATE operation_items
                SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
                    error_message = ?, completed_at = unixepoch(),
                    updated_at = unixepoch()
              WHERE operation_id = ? AND status = 'pending'`,
          ).bind(failure, job.id),
          this.env.DB.prepare(
            `UPDATE communications SET status = 'failed', updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND status = 'queued'`,
          ).bind(job.communicationId, viewer.eventId),
        ]);
      }
    }
  }

  async submissionNotificationState(viewer: Viewer, submissionId: string) {
    const jobs = await this.env.DB.prepare(
      `SELECT job.id AS operationId, job.type,
              job.idempotency_key AS idempotencyKey, job.status,
              communication.id AS communicationId
         FROM operation_jobs job
         LEFT JOIN communications communication
           ON communication.operation_id = job.id
          AND communication.event_id = job.event_id
        WHERE job.organisation_id = ? AND job.event_id = ?
          AND (
            (job.type = 'submission.notification'
             AND job.idempotency_key = ?)
            OR
            (job.type = 'communication.send'
             AND json_extract(communication.audience_json, '$.submissionId') = ?)
          )
        ORDER BY job.type, job.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        `submission-confirmation:${submissionId}`,
        submissionId,
      )
      .all<{
        operationId: string;
        type: string;
        idempotencyKey: string;
        status: string;
        communicationId: string | null;
      }>();
    return jobs.results;
  }

  async recordSubmissionCommandChange(
    viewer: Viewer,
    operationId: string,
    submissionId: string,
    changeType: "created" | "updated",
  ) {
    try {
      let row = await this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         ) SELECT event.id, 'submission', ?, ?, ?, unixepoch()
             FROM events event
            WHERE event.id = ? AND event.organisation_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM event_changes existing
                 WHERE existing.event_id = event.id
                   AND existing.entity_type = 'submission'
                   AND existing.entity_id = ?
                   AND existing.change_type = ?
                   AND existing.correlation_id = ?
              )
         RETURNING sequence`,
      )
        .bind(
          submissionId,
          changeType,
          operationId,
          viewer.eventId,
          viewer.organisationId,
          submissionId,
          changeType,
          operationId,
        )
        .first<{ sequence: number }>();
      row ??= await this.env.DB.prepare(
        `SELECT sequence FROM event_changes
          WHERE event_id = ? AND entity_type = 'submission'
            AND entity_id = ? AND change_type = ? AND correlation_id = ?
          ORDER BY sequence LIMIT 1`,
      )
        .bind(viewer.eventId, submissionId, changeType, operationId)
        .first<{ sequence: number }>();
      if (!row) {
        throw new Error("The participant event change could not be recorded.");
      }
      try {
        await new EventRealtimeService(this.env).notifyCommittedChange(
          viewer,
          Number(row.sequence),
        );
        return { changeCursor: Number(row.sequence), realtimeWarning: null };
      } catch (error) {
        console.error("Failed to notify a participant API change", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return {
          changeCursor: Number(row.sequence),
          realtimeWarning:
            "The submission committed, but live invalidation failed.",
        };
      }
    } catch (error) {
      console.error("Failed to record a participant API change", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return {
        changeCursor: null,
        realtimeWarning:
          "The submission committed, but its durable live invalidation could not be recorded.",
      };
    }
  }

  async submissionCommandContext(
    viewer: Viewer,
    submissionId: string,
  ): Promise<{
    applicant: Extract<Applicant, { verified: true }>;
    publicSlug: string;
  }> {
    const row = await this.env.DB.prepare(
      `SELECT person.email, person.display_name AS name,
              COALESCE(person.biography, '') AS biography,
              person.profile_revision AS profileRevision,
              person.email_verified AS emailVerified,
              form.public_slug AS publicSlug
         FROM submissions submission
         JOIN events event ON event.id = submission.event_id
           AND event.organisation_id = ?
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = submission.event_id
         JOIN people person ON person.id = submission.submitter_person_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND submission.submitter_person_id = ?`,
    )
      .bind(
        viewer.organisationId,
        submissionId,
        viewer.eventId,
        viewer.personId,
      )
      .first<{
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
        emailVerified: number;
        publicSlug: string;
      }>();
    if (!row) {
      throw new ApiError(
        404,
        "SUBMISSION_NOT_FOUND",
        "Participant submission not found",
      );
    }
    if (!row.emailVerified) {
      throw new ApiError(
        409,
        "PARTICIPANT_EMAIL_UNVERIFIED",
        "Verify the participant email before changing this submission",
      );
    }
    return {
      applicant: {
        personId: viewer.personId,
        email: row.email,
        name: row.name,
        verified: true,
        anonymousDraftId: null,
        biography: row.biography,
        profileRevision: row.profileRevision,
      },
      publicSlug: row.publicSlug,
    };
  }

  async list(
    viewer: Viewer,
    resource: Exclude<ParticipantApiResource, "profile">,
    input: ParticipantQuery & { limit: number },
  ) {
    if (resource !== "files") {
      await this.airtable.assertReadable(viewer);
    }
    const rows = await this.query(viewer, resource, input);
    const visible = rows.slice(0, input.limit);
    const records = visible.map(({ sort: _sort, ...row }) =>
      this.serialise(resource, row),
    );
    if (resource === "tasks" && records.length) {
      const ids = records.map((record) => String(record.id));
      const [dependencies, comments] = await Promise.all([
        this.env.DB.prepare(
          `SELECT dependency.task_id AS taskId,
                  prerequisite.id, prerequisite.title, prerequisite.status
             FROM task_instance_dependencies dependency
             JOIN task_instances prerequisite
               ON prerequisite.id = dependency.depends_on_task_id
            WHERE dependency.task_id IN (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            )
            ORDER BY dependency.task_id, prerequisite.title`,
        )
          .bind(JSON.stringify(ids))
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
        record.dependencies = dependencies.results.filter(
          (item) => item.taskId === record.id,
        );
        record.comments = comments.results
          .filter((item) => item.taskId === record.id)
          .map((item) => ({
            ...item,
            createdAt: isoTimestamp(item.createdAt),
          }));
      }
    }
    return {
      [resource]: records,
      nextCursor:
        rows.length > input.limit && visible.length
          ? encodePrivateCursor(
              visible.at(-1)!.sort,
              String(visible.at(-1)!.id),
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
                    submission.title, submission.category, submission.format,
                    submission.status, submission.revision,
                    submission.answers_json AS answersJson,
                    submission.submitted_snapshot_json AS submittedSnapshotJson,
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
               LEFT JOIN file_versions version
                 ON version.id = asset.current_version_id
                AND version.event_id = asset.event_id
                AND version.deleted_at IS NULL
              WHERE asset.event_id = ? AND asset.owner_person_id = ?
                AND asset.status <> 'deleted'
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
              AND (
                task.owner_person_id = ?
                OR (task.target_type = 'speaker' AND task.target_id = ?)
                OR (task.target_type = 'session' AND EXISTS (
                  SELECT 1 FROM session_speakers speaker
                   WHERE speaker.event_id = task.event_id
                     AND speaker.session_id = task.target_id
                     AND speaker.person_id = ?
                ))
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
      result.answers = parseJson(
        result.answersJson,
        `Submission ${String(result.id)} answers`,
      );
      result.submittedSnapshot = parseJson(
        result.submittedSnapshotJson,
        `Submission ${String(result.id)} submitted snapshot`,
      );
      delete result.answersJson;
      delete result.submittedSnapshotJson;
    }
    if (resource === "tasks") {
      result.evidence = parseJson(
        result.evidenceJson,
        `Task ${String(result.id)} evidence`,
      );
      result.waiver = parseJson(
        result.waiverJson,
        `Task ${String(result.id)} waiver`,
      );
      delete result.evidenceJson;
      delete result.waiverJson;
    }
    return result;
  }

  async runCommand<T extends Record<string, unknown>>(
    viewer: Viewer,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    operation: (operationId: string) => Promise<T>,
    recover: (operationId: string) => Promise<ParticipantCommandRecovery<T>>,
  ): Promise<{ response: T; replayed: boolean }> {
    const recordId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        `person:${viewer.personId}`,
        scope,
        idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        recordId,
        viewer.organisationId,
        viewer.eventId,
        `person:${viewer.personId}`,
        scope,
        idempotencyKey,
        requestHash,
      ),
    ]);
    const claim = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status,
              response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        `person:${viewer.personId}`,
        scope,
        idempotencyKey,
      )
      .first<ParticipantCommandRecord>();
    if (!claim) {
      throw new Error("The participant idempotency claim was not recorded.");
    }
    if (claim.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request",
      );
    }
    if (claim.status === "completed") {
      if (!claim.responseJson) {
        throw new Error(
          "A completed participant idempotency record is missing its durable result.",
        );
      }
      let response: unknown;
      try {
        response = JSON.parse(claim.responseJson);
      } catch {
        throw new Error(
          "A completed participant idempotency record contains invalid JSON.",
        );
      }
      if (
        !response ||
        typeof response !== "object" ||
        Array.isArray(response)
      ) {
        throw new Error(
          "A completed participant idempotency record is missing its durable result.",
        );
      }
      return { response: response as T, replayed: true };
    }
    const activeRecordId = claim.id;
    const preflight = await recover(activeRecordId);
    if (preflight.response) {
      const response = await this.completeParticipantCommand(
        viewer,
        activeRecordId,
        scope,
        idempotencyKey,
        requestHash,
        preflight.response,
      );
      return { response, replayed: claim.id !== recordId };
    }
    const ownsClaim = claim.id === recordId;
    if (!ownsClaim && !preflight.progressed) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "This Idempotency-Key is already processing; retry after the first request completes",
      );
    }
    try {
      const response = await operation(activeRecordId);
      const completedResponse = await this.completeParticipantCommand(
        viewer,
        activeRecordId,
        scope,
        idempotencyKey,
        requestHash,
        response,
      );
      return {
        response: completedResponse,
        replayed: claim.id !== recordId,
      };
    } catch (error) {
      const recovered = await recover(activeRecordId);
      if (recovered.response) {
        const response = await this.completeParticipantCommand(
          viewer,
          activeRecordId,
          scope,
          idempotencyKey,
          requestHash,
          recovered.response,
        );
        return {
          response,
          replayed: claim.id !== recordId,
        };
      }
      if (!recovered.progressed && ownsClaim) {
        await this.env.DB.prepare(
          `DELETE FROM idempotency_records
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND actor_id = ? AND status = 'processing'`,
        )
          .bind(
            activeRecordId,
            viewer.organisationId,
            viewer.eventId,
            `person:${viewer.personId}`,
          )
          .run();
      }
      throw error;
    }
  }

  private async completeParticipantCommand<T extends Record<string, unknown>>(
    viewer: Viewer,
    recordId: string,
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    response: T,
  ): Promise<T> {
    const serialisedResponse = serialiseParticipantCommandResponse(response);
    const completed = await this.env.DB.prepare(
      `UPDATE idempotency_records
          SET status = 'completed', response_status = 200,
              response_json = ?, completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND scope = ? AND idempotency_key = ?
          AND request_hash = ? AND status = 'processing'`,
    )
      .bind(
        serialisedResponse,
        recordId,
        viewer.organisationId,
        viewer.eventId,
        `person:${viewer.personId}`,
        scope,
        idempotencyKey,
        requestHash,
      )
      .run();
    if ((completed.meta.changes ?? 0) !== 1) {
      const current = await this.env.DB.prepare(
        `SELECT request_hash AS requestHash, status, response_json AS responseJson
           FROM idempotency_records WHERE id = ? AND organisation_id = ?
             AND event_id = ? AND actor_id = ? AND scope = ?
             AND idempotency_key = ?`,
      )
        .bind(
          recordId,
          viewer.organisationId,
          viewer.eventId,
          `person:${viewer.personId}`,
          scope,
          idempotencyKey,
        )
        .first<{
          requestHash: string;
          status: string;
          responseJson: string | null;
        }>();
      if (
        current?.requestHash === requestHash &&
        current.status === "completed" &&
        current.responseJson
      ) {
        let stored: unknown;
        try {
          stored = JSON.parse(current.responseJson);
        } catch {
          throw new Error(
            "A completed participant idempotency record contains invalid JSON.",
          );
        }
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
          throw new Error(
            "A completed participant idempotency record is missing its durable result.",
          );
        }
        return stored as T;
      }
      throw new Error(
        "The participant command committed without its idempotency result.",
      );
    }
    return response;
  }
}

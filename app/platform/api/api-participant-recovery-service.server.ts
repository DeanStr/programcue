import type { Applicant } from "~/modules/submissions/submission-repository.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import { ApiError } from "./api.server";

type ParticipantCommandRecovery<T> = {
  response: T | null;
  progressed: boolean;
};

export class ApiParticipantRecoveryService {
  constructor(private readonly env: CloudflareEnvironment) {}

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
          AND task.completed_by_person_id = ?`,
    )
      .bind(
        viewer.organisationId,
        taskId,
        viewer.eventId,
        operationId,
        previousRevision + 1,
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
}

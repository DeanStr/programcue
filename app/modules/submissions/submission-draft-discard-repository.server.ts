import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  type Applicant,
  type FormSummary,
  type FormVersion,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "./submission-repository-shared";

/** Owns the durable discard lock, private-file checks and atomic finalization. */
export class SubmissionDraftDiscardRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async beginDraftDiscard(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
    expectedRevision: number,
    requestedOperationId: string,
  ) {
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO submission_draft_discards (
             submission_id, event_id, expected_revision,
             requested_by_person_id, operation_id, created_at
           )
           SELECT submission.id, submission.event_id, submission.revision,
                  ?, ?, unixepoch()
             FROM submissions submission
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE submission.id = ? AND submission.event_id = ?
              AND version.form_id = ? AND submission.status = 'draft'
              AND submission.revision = ?
              AND (
                (? IS NOT NULL AND submission.submitter_person_id = ?)
                OR
                (? IS NOT NULL AND submission.id = ?
                  AND submission.submitter_person_id IS NULL
                  AND submission.submitter_email IS NULL)
              )
              AND (
                ? IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1 FROM file_assets asset
                   WHERE asset.event_id = submission.event_id
                     AND asset.target_type = 'submission'
                     AND asset.target_id = submission.id
                     AND (
                       asset.status <> 'deleted'
                       OR asset.current_version_id IS NOT NULL
                       OR EXISTS (
                         SELECT 1 FROM file_versions file_version
                          WHERE file_version.asset_id = asset.id
                            AND file_version.event_id = asset.event_id
                            AND file_version.deleted_at IS NULL
                       )
                     )
                )
              )`,
        ).bind(
          applicant.personId,
          requestedOperationId,
          submissionId,
          form.eventId,
          form.id,
          expectedRevision,
          applicant.personId,
          applicant.personId,
          applicant.anonymousDraftId,
          applicant.anonymousDraftId,
          applicant.personId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `NOT EXISTS (
             SELECT 1 FROM submission_draft_discards discard
              WHERE discard.submission_id = ? AND discard.event_id = ?
                AND discard.expected_revision = ?
                AND discard.requested_by_person_id IS ?
           )`,
          [submissionId, form.eventId, expectedRevision, applicant.personId],
        ),
      ]);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      const current = await this.env.DB.prepare(
        `SELECT submission.revision, submission.status,
                EXISTS (
                  SELECT 1 FROM file_assets asset
                   WHERE asset.event_id = submission.event_id
                     AND asset.target_type = 'submission'
                     AND asset.target_id = submission.id
                     AND (
                       asset.status <> 'deleted'
                       OR asset.current_version_id IS NOT NULL
                       OR EXISTS (
                         SELECT 1 FROM file_versions file_version
                          WHERE file_version.asset_id = asset.id
                            AND file_version.event_id = asset.event_id
                            AND file_version.deleted_at IS NULL
                       )
                     )
                ) AS hasPrivateUpload
           FROM submissions submission
           JOIN form_versions version
             ON version.id = submission.form_version_id
            AND version.event_id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?
            AND version.form_id = ?
            AND (
              (? IS NOT NULL AND submission.submitter_person_id = ?)
              OR
              (? IS NOT NULL AND submission.id = ?
                AND submission.submitter_person_id IS NULL
                AND submission.submitter_email IS NULL)
            )`,
      )
        .bind(
          submissionId,
          form.eventId,
          form.id,
          applicant.personId,
          applicant.personId,
          applicant.anonymousDraftId,
          applicant.anonymousDraftId,
        )
        .first<{
          revision: number;
          status: string;
          hasPrivateUpload: number;
        }>();
      if (!current)
        throw new Response("Application draft not found", { status: 404 });
      if (current.revision !== expectedRevision)
        throw new SubmissionRevisionConflictError();
      if (current.status !== "draft")
        throw new SubmissionStateError(
          "Only an unsubmitted draft can be discarded.",
        );
      if (!applicant.verified && current.hasPrivateUpload) {
        throw new SubmissionStateError(
          "Verify your email before discarding a draft that contains an uploaded video.",
        );
      }
      throw new SubmissionStateError(
        "This application draft is already being discarded. Retry the discard to finish private-file erasure.",
      );
    }
    const lock = await this.env.DB.prepare(
      `SELECT operation_id AS operationId
         FROM submission_draft_discards
        WHERE submission_id = ? AND event_id = ?
          AND expected_revision = ? AND requested_by_person_id IS ?`,
    )
      .bind(submissionId, form.eventId, expectedRevision, applicant.personId)
      .first<{ operationId: string }>();
    if (!lock) {
      throw new Error("The durable application draft discard lock is missing.");
    }
    return lock;
  }

  async findDraftDiscardReplay(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
    expectedRevision: number,
    organisationId: string,
  ) {
    if (!applicant.verified && applicant.anonymousDraftId !== submissionId) {
      return null;
    }
    const replay = await this.env.DB.prepare(
      `SELECT 1
         FROM audit_events audit
        WHERE audit.id = ? AND audit.organisation_id = ?
          AND audit.event_id = ? AND audit.actor_person_id IS ?
          AND audit.origin = 'public_form' AND audit.metadata_version = 1
          AND audit.action = 'submission.draft.discarded'
          AND audit.entity_type = 'submission' AND audit.entity_id = ?
          AND json_valid(audit.metadata_json)
          AND json_extract(audit.metadata_json, '$.revision') = ?
          AND json_extract(audit.metadata_json, '$.formId') = ?
          AND json_extract(audit.metadata_json, '$.anonymous') = ?`,
    )
      .bind(
        `submission-draft-discarded:${submissionId}`,
        organisationId,
        form.eventId,
        applicant.personId,
        submissionId,
        expectedRevision,
        form.id,
        applicant.verified ? 0 : 1,
      )
      .first();
    return replay
      ? { submissionId, organisationId, eventId: form.eventId }
      : null;
  }

  async getDraftFileAssets(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
    expectedRevision: number,
    operationId: string,
  ) {
    const rows = await this.env.DB.prepare(
      `SELECT asset.id, asset.status,
              EXISTS (
                SELECT 1 FROM file_versions version
                 WHERE version.asset_id = asset.id
                   AND version.event_id = asset.event_id
                   AND version.deleted_at IS NULL
              ) AS hasStoredVersion
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN submission_draft_discards discard
           ON discard.submission_id = submission.id
          AND discard.event_id = submission.event_id
          AND discard.expected_revision = submission.revision
         JOIN file_assets asset
           ON asset.event_id = submission.event_id
          AND asset.target_type = 'submission'
          AND asset.target_id = submission.id
        WHERE submission.id = ? AND submission.event_id = ?
          AND version.form_id = ? AND submission.status = 'draft'
          AND submission.revision = ?
          AND discard.operation_id = ?
          AND discard.requested_by_person_id IS ?
          AND (
            (? IS NOT NULL AND submission.submitter_person_id = ?)
            OR
            (? IS NOT NULL AND submission.id = ?
              AND submission.submitter_person_id IS NULL
              AND submission.submitter_email IS NULL)
          )
        ORDER BY asset.created_at, asset.id`,
    )
      .bind(
        submissionId,
        form.eventId,
        form.id,
        expectedRevision,
        operationId,
        applicant.personId,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
      .all<{ id: string; status: string; hasStoredVersion: number }>();
    return rows.results.map((row) => ({
      id: row.id,
      requiresErasure:
        row.status !== "deleted" || Boolean(row.hasStoredVersion),
    }));
  }

  async completeDraftDiscard(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
    expectedRevision: number,
    scope: { organisationId: string; operationId: string },
  ) {
    const auditEventId = `submission-draft-discarded:${submissionId}`;
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM submissions
            WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
              AND EXISTS (
                SELECT 1 FROM submission_draft_discards discard
                 WHERE discard.submission_id = submissions.id
                   AND discard.event_id = submissions.event_id
                   AND discard.expected_revision = submissions.revision
                   AND discard.operation_id = ?
                   AND discard.requested_by_person_id IS ?
              )
              AND EXISTS (
                SELECT 1 FROM form_versions version
                 WHERE version.id = submissions.form_version_id
                   AND version.event_id = submissions.event_id
                   AND version.form_id = ?
              )
              AND (
                (? IS NOT NULL AND submitter_person_id = ?)
                OR
                (? IS NOT NULL AND id = ?
                  AND submitter_person_id IS NULL AND submitter_email IS NULL)
              )
              AND NOT EXISTS (
                SELECT 1 FROM file_assets asset
                 WHERE asset.event_id = submissions.event_id
                   AND asset.target_type = 'submission'
                   AND asset.target_id = submissions.id
                   AND (
                     asset.status <> 'deleted'
                     OR asset.current_version_id IS NOT NULL
                     OR EXISTS (
                       SELECT 1 FROM file_versions version
                        WHERE version.asset_id = asset.id
                          AND version.event_id = asset.event_id
                          AND version.deleted_at IS NULL
                     )
                   )
              )`,
        ).bind(
          submissionId,
          form.eventId,
          expectedRevision,
          scope.operationId,
          applicant.personId,
          form.id,
          applicant.personId,
          applicant.personId,
          applicant.anonymousDraftId,
          applicant.anonymousDraftId,
        ),
        this.env.DB.prepare(
          `DELETE FROM memberships
            WHERE event_id = ? AND person_id = ? AND role = 'submitter'
              AND ? IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = memberships.last_operation_id
                   AND audit.event_id = memberships.event_id
                   AND audit.organisation_id = memberships.organisation_id
                   AND audit.actor_person_id = memberships.person_id
                   AND audit.action = 'submission.draft.created'
                   AND audit.entity_type = 'submission'
              )
              AND NOT EXISTS (
                SELECT 1 FROM submissions remaining
                 WHERE remaining.event_id = memberships.event_id
                   AND remaining.submitter_person_id = memberships.person_id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM submission_speakers claimed
                  JOIN submissions remaining
                    ON remaining.id = claimed.submission_id
                   AND remaining.event_id = claimed.event_id
                 WHERE claimed.event_id = memberships.event_id
                   AND claimed.person_id = memberships.person_id
                   AND claimed.invitation_status = 'claimed'
              )`,
        ).bind(form.eventId, applicant.personId, applicant.personId),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id,
             event_id, actor_person_id, action, entity_type, entity_id,
             correlation_id, metadata_json, created_at
           )
           SELECT ?, CASE WHEN ? IS NULL THEN 'system' ELSE 'person' END,
                  'public_form', 1, ?, ?, ?, 'submission.draft.discarded',
                  'submission', ?, ?, ?, unixepoch()
            WHERE NOT EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ?
            )
              AND EXISTS (
                SELECT 1 FROM audit_events created
                 WHERE created.event_id = ?
                   AND created.action = 'submission.draft.created'
                   AND created.entity_type = 'submission'
                   AND created.entity_id = ?
              )`,
        ).bind(
          auditEventId,
          applicant.personId,
          scope.organisationId,
          form.eventId,
          applicant.personId,
          submissionId,
          scope.operationId,
          JSON.stringify({
            revision: expectedRevision,
            anonymous: !applicant.verified,
            formId: form.id,
            formVersionId: form.version.id,
          }),
          submissionId,
          form.eventId,
          form.eventId,
          submissionId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `EXISTS (SELECT 1 FROM submissions WHERE id = ? AND event_id = ?)
           OR NOT EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ? AND event_id = ?
                AND action = 'submission.draft.discarded'
                AND entity_type = 'submission' AND entity_id = ?
           )`,
          [
            submissionId,
            form.eventId,
            auditEventId,
            form.eventId,
            submissionId,
          ],
        ),
      ]);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      const current = await this.env.DB.prepare(
        `SELECT submission.revision, submission.status
           FROM submissions submission
           JOIN form_versions version
             ON version.id = submission.form_version_id
            AND version.event_id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?
            AND version.form_id = ?
            AND (
              (? IS NOT NULL AND submission.submitter_person_id = ?)
              OR
              (? IS NOT NULL AND submission.id = ?
                AND submission.submitter_person_id IS NULL
                AND submission.submitter_email IS NULL)
            )`,
      )
        .bind(
          submissionId,
          form.eventId,
          form.id,
          applicant.personId,
          applicant.personId,
          applicant.anonymousDraftId,
          applicant.anonymousDraftId,
        )
        .first<{ revision: number; status: string }>();
      if (!current)
        throw new Response("Application draft not found", { status: 404 });
      if (current.revision !== expectedRevision)
        throw new SubmissionRevisionConflictError();
      if (current.status !== "draft")
        throw new SubmissionStateError(
          "Only an unsubmitted draft can be discarded.",
        );
      throw new SubmissionStateError(
        "The draft still has a private upload that must be erased before it can be discarded.",
      );
    }
    return {
      submissionId,
      organisationId: scope.organisationId,
      eventId: form.eventId,
    };
  }
}

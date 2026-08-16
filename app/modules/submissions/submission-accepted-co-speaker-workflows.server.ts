import { z } from "zod";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluatorEmailAliasContextError,
  type EvaluatorEmailRouting,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import {
  buildCoSpeakerInvitationPlan,
  parseCoSpeakerQueueMessage,
  persistCoSpeakerQueueFailure,
  persistQueueFailure,
} from "./co-speaker-invitation.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "./submission-repository-shared";
import {
  draftPayloadSchema,
  MAX_SUBMISSION_SPEAKERS,
} from "./submission-schema";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";

export const acceptedCoSpeakerInvitationSchema = z
  .object({
    submissionId: z.string().trim().min(1).max(100),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    roleLabel: z.enum(["Co-author", "Co-speaker", "Co-presenter"]),
    confirmed: z.literal(true),
  })
  .strict();

export type AcceptedCoSpeakerInvitationInput = z.infer<
  typeof acceptedCoSpeakerInvitationSchema
>;

export class AcceptedCoSpeakerWorkflows extends SubmissionServiceFoundation {
  async inviteAcceptedCoSpeaker(
    viewer: Viewer,
    rawInput: unknown,
    operationId: string = crypto.randomUUID(),
  ) {
    const parsed = acceptedCoSpeakerInvitationSchema.parse(rawInput);
    let emailResolution: Awaited<ReturnType<typeof resolveEvaluatorEmailAlias>>;
    try {
      emailResolution = await resolveEvaluatorEmailAlias(
        this.env,
        viewer,
        parsed.email,
      );
    } catch (error) {
      if (error instanceof EvaluatorEmailAliasContextError) {
        throw new SubmissionStateError(error.message);
      }
      throw error;
    }
    const deliveryIssue = emailDeliveryIssue(
      emailResolution.email,
      this.env.APP_ENV,
    );
    if (deliveryIssue) {
      throw new SubmissionStateError(
        `The co-speaker invitation email address is not deliverable: ${deliveryIssue.toLowerCase()}.`,
      );
    }
    const input = { ...parsed, email: emailResolution.email };
    const parsedOperationId = z.string().min(1).max(200).parse(operationId);
    return this.projectIntentCommand(
      viewer,
      "submission.co_speaker.invite_after_acceptance",
      parsedOperationId,
      { ...input, evaluatorEmailRouting: emailResolution.routing },
      () =>
        this.inviteAcceptedCoSpeakerD1(
          viewer,
          input,
          parsedOperationId,
          emailResolution.routing,
        ),
    );
  }

  protected async inviteAcceptedCoSpeakerD1(
    viewer: Viewer,
    input: AcceptedCoSpeakerInvitationInput,
    operationId: string,
    routing: EvaluatorEmailRouting | null,
  ) {
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const context = await this.env.DB.prepare(
      `SELECT submission.title AS submissionTitle, submission.status,
              submission.revision, form.id AS formId,
              form.public_slug AS publicSlug,
              form.kind AS formKind,
              form.max_speakers AS maxSpeakers,
              event.name AS eventName, event.starts_at AS startsAt,
              event.ends_at AS endsAt, event.brand_accent AS brandAccent,
              event.venue_name AS venueName, event.city,
              actor.email_verified AS actorEmailVerified,
              (SELECT revision.speaker_snapshot_json
                 FROM submission_revisions revision
                WHERE revision.submission_id = submission.id
                  AND revision.event_id = submission.event_id
                ORDER BY revision.revision_number DESC LIMIT 1
              ) AS latestSpeakerSnapshotJson,
              (SELECT COUNT(*) FROM submission_speakers speaker
                WHERE speaker.submission_id = submission.id
                  AND speaker.event_id = submission.event_id) AS speakerCount,
              (SELECT COUNT(*) FROM sessions session
                WHERE session.source_submission_id = submission.id
                  AND session.event_id = submission.event_id
              ) AS derivedSessionCount,
              (SELECT session.status FROM sessions session
                WHERE session.source_submission_id = submission.id
                  AND session.event_id = submission.event_id
                ORDER BY session.id LIMIT 1
              ) AS derivedSessionStatus,
              (SELECT COUNT(*) FROM submission_decisions decision
                WHERE decision.submission_id = submission.id
                  AND decision.event_id = submission.event_id
                  AND decision.status = 'published'
                  AND decision.decision = 'accepted'
              ) AS publishedAcceptanceCount
         FROM submissions submission
         JOIN events event
           ON event.id = submission.event_id AND event.organisation_id = ?
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
         JOIN people actor ON actor.id = submission.submitter_person_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND submission.submitter_person_id = ?`,
    )
      .bind(
        viewer.organisationId,
        input.submissionId,
        viewer.eventId,
        viewer.personId,
      )
      .first<{
        submissionTitle: string;
        status: string;
        revision: number;
        formId: string;
        publicSlug: string;
        formKind: "submission" | "direct_session";
        maxSpeakers: number | null;
        eventName: string;
        startsAt: number;
        endsAt: number;
        brandAccent: string;
        venueName: string | null;
        city: string | null;
        actorEmailVerified: number;
        latestSpeakerSnapshotJson: string | null;
        speakerCount: number;
        derivedSessionCount: number;
        derivedSessionStatus: string | null;
        publishedAcceptanceCount: number;
      }>();
    if (!context) {
      throw new SubmissionStateError(
        "This accepted application is unavailable to the current participant.",
      );
    }
    if (!context.actorEmailVerified && viewer.evaluation !== true) {
      throw new SubmissionStateError(
        "Verify your email before inviting a co-speaker.",
      );
    }
    if (context.status !== "accepted") {
      throw new SubmissionStateError(
        "Co-speakers can be added here only after the application is accepted.",
      );
    }
    if (context.revision !== input.revision) {
      throw new SubmissionRevisionConflictError();
    }
    if (context.derivedSessionCount !== 1) {
      throw new SubmissionStateError(
        "This accepted application must have exactly one derived session before its speaker list can be changed.",
      );
    }
    if (
      context.derivedSessionStatus !== "unscheduled" &&
      context.derivedSessionStatus !== "scheduled"
    ) {
      throw new SubmissionStateError(
        "This accepted session is not editable, so its speaker list is locked.",
      );
    }
    if (
      context.formKind === "submission" &&
      context.publishedAcceptanceCount !== 1
    ) {
      throw new SubmissionStateError(
        "This accepted application is missing its published acceptance decision.",
      );
    }
    const effectiveMaximumSpeakers = Math.min(
      context.maxSpeakers ?? MAX_SUBMISSION_SPEAKERS,
      MAX_SUBMISSION_SPEAKERS,
    );
    if (context.speakerCount >= effectiveMaximumSpeakers) {
      throw new SubmissionStateError(
        `This application already has the maximum of ${effectiveMaximumSpeakers} speakers.`,
      );
    }
    if (!context.latestSpeakerSnapshotJson) {
      throw new SubmissionStateError(
        "The accepted application is missing its latest speaker revision.",
      );
    }
    let persistedSpeakerSnapshot: unknown;
    try {
      persistedSpeakerSnapshot = JSON.parse(context.latestSpeakerSnapshotJson);
    } catch {
      throw new SubmissionStateError(
        "The accepted application has an invalid latest speaker revision.",
      );
    }
    const latestSpeakerSnapshot = draftPayloadSchema.shape.speakers.safeParse(
      persistedSpeakerSnapshot,
    );
    if (!latestSpeakerSnapshot.success) {
      throw new SubmissionStateError(
        "The accepted application has an invalid latest speaker revision.",
      );
    }
    const existingSpeakers = await this.env.DB.prepare(
      `SELECT email, display_name AS name, role_label AS roleLabel,
              is_primary AS isPrimary
         FROM submission_speakers
        WHERE submission_id = ? AND event_id = ?
        ORDER BY position`,
    )
      .bind(input.submissionId, viewer.eventId)
      .all<{
        email: string;
        name: string;
        roleLabel: string | null;
        isPrimary: number;
      }>();
    const submittedByEmail = new Map(
      latestSpeakerSnapshot.data.map((speaker) => [
        speaker.email.toLowerCase(),
        speaker,
      ]),
    );
    if (
      existingSpeakers.results.length !== context.speakerCount ||
      existingSpeakers.results.some(
        (speaker) => !submittedByEmail.has(speaker.email.toLowerCase()),
      )
    ) {
      throw new SubmissionStateError(
        "The accepted application's current speakers do not match its latest speaker revision.",
      );
    }
    if (
      existingSpeakers.results.some(
        (speaker) => speaker.email.toLowerCase() === input.email,
      )
    ) {
      throw new SubmissionStateError(
        "That email address is already on this application.",
      );
    }

    const speakerId = crypto.randomUUID();
    const plan = await buildCoSpeakerInvitationPlan(
      this.env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        eventName: context.eventName,
        brandAccent: context.brandAccent,
        startsAt: context.startsAt,
        endsAt: context.endsAt,
        physicalAddress: [context.venueName, context.city]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(", "),
        formId: context.formId,
        publicSlug: context.publicSlug,
        submissionId: input.submissionId,
        submissionTitle: context.submissionTitle,
        requestedByPersonId: viewer.personId,
        operationId,
      },
      {
        id: speakerId,
        email: input.email,
        displayName: input.name,
        claimTokenHash: null,
      },
    );
    const speakerSnapshot = JSON.stringify([
      ...existingSpeakers.results.map((speaker) => ({
        ...submittedByEmail.get(speaker.email.toLowerCase())!,
        roleLabel: speaker.roleLabel,
        isPrimary: Boolean(speaker.isPrimary),
      })),
      {
        name: input.name,
        email: input.email,
        biography: "",
        roleLabel: input.roleLabel,
        isPrimary: false,
      },
    ]);
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE submissions
            SET revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND status = 'accepted' AND submitter_person_id = ?
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = submissions.event_id
                 AND event.organisation_id = ?
            )
            AND 1 = (
              SELECT COUNT(*) FROM sessions session
               WHERE session.source_submission_id = submissions.id
                 AND session.event_id = submissions.event_id
            )
            AND EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.source_submission_id = submissions.id
                 AND session.event_id = submissions.event_id
                 AND session.status IN ('unscheduled','scheduled')
            )
            AND (
              (SELECT form.kind
                 FROM form_versions version
                 JOIN form_definitions form
                   ON form.id = version.form_id
                  AND form.event_id = version.event_id
                WHERE version.id = submissions.form_version_id
                  AND version.event_id = submissions.event_id) = 'direct_session'
              OR 1 = (
                SELECT COUNT(*) FROM submission_decisions decision
                 WHERE decision.submission_id = submissions.id
                   AND decision.event_id = submissions.event_id
                   AND decision.status = 'published'
                   AND decision.decision = 'accepted'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM submission_speakers speaker
               WHERE speaker.submission_id = submissions.id
                 AND speaker.event_id = submissions.event_id
                 AND speaker.email = ? COLLATE NOCASE
            )
            AND (SELECT COUNT(*) FROM submission_speakers speaker
                   WHERE speaker.submission_id = submissions.id
                     AND speaker.event_id = submissions.event_id) < 20
            AND (
              (SELECT form.max_speakers
                 FROM form_versions version
                 JOIN form_definitions form
                   ON form.id = version.form_id
                  AND form.event_id = version.event_id
                WHERE version.id = submissions.form_version_id
                  AND version.event_id = submissions.event_id) IS NULL
              OR (SELECT COUNT(*) FROM submission_speakers speaker
                   WHERE speaker.submission_id = submissions.id
                     AND speaker.event_id = submissions.event_id) <
                 (SELECT form.max_speakers
                    FROM form_versions version
                    JOIN form_definitions form
                      ON form.id = version.form_id
                     AND form.event_id = version.event_id
                   WHERE version.id = submissions.form_version_id
                     AND version.event_id = submissions.event_id)
            )`,
      ).bind(
        operationId,
        input.submissionId,
        viewer.eventId,
        input.revision,
        viewer.personId,
        viewer.organisationId,
        input.email,
      ),
      this.env.DB.prepare(
        `INSERT INTO submission_speakers (
           id, event_id, submission_id, person_id, email, display_name,
           role_label, position, invitation_status, is_primary,
           created_at, updated_at
         )
         SELECT ?, submission.event_id, submission.id, NULL, ?, ?, ?,
                COALESCE((
                  SELECT MAX(existing.position) + 1
                    FROM submission_speakers existing
                   WHERE existing.submission_id = submission.id
                     AND existing.event_id = submission.event_id
                ), 0), 'pending', 0, unixepoch(), unixepoch()
           FROM submissions submission
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.last_operation_id = ?`,
      ).bind(
        speakerId,
        input.email,
        input.name,
        input.roleLabel,
        input.submissionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind,
           saved_by_person_id, idempotency_key, created_at
         )
         SELECT ?, submission.event_id, submission.id,
                submission.form_version_id, submission.revision,
                submission.answers_json, ?, 'manual', ?, ?, unixepoch()
           FROM submissions submission
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM submission_speakers speaker
               WHERE speaker.id = ? AND speaker.event_id = submission.event_id
            )`,
      ).bind(
        crypto.randomUUID(),
        speakerSnapshot,
        viewer.personId,
        operationId,
        input.submissionId,
        viewer.eventId,
        operationId,
        speakerId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'public_form', 1, ?, submission.event_id, ?,
                'submission.speaker.added_after_acceptance',
                'submission_speaker', ?, ?, ?, unixepoch()
           FROM submissions submission
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM submission_revisions revision
               WHERE revision.submission_id = submission.id
                 AND revision.event_id = submission.event_id
                 AND revision.idempotency_key = ?
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        speakerId,
        operationId,
        JSON.stringify({
          submissionId: input.submissionId,
          roleLabel: input.roleLabel,
          previousRevision: input.revision,
          revision: input.revision + 1,
          ...(routing ? { evaluatorEmailRouting: routing } : {}),
        }),
        input.submissionId,
        viewer.eventId,
        operationId,
        operationId,
      ),
      ...plan.statements,
    ];
    const results = await this.env.DB.batch(statements);
    const [submissionUpdated, speakerCreated, revisionCreated, auditCreated] =
      results;
    if (
      (submissionUpdated.meta.changes ?? 0) !== 1 ||
      (speakerCreated.meta.changes ?? 0) !== 1 ||
      (revisionCreated.meta.changes ?? 0) !== 1 ||
      (auditCreated.meta.changes ?? 0) !== 1 ||
      (results[4]?.meta.changes ?? 0) !== 1
    ) {
      throw new SubmissionRevisionConflictError();
    }
    let invitationStatus: "queued" | "queue_failed" = "queued";
    let speakerInvitationStatus: "sent" | "pending" = "sent";
    try {
      await operationsQueue.send(plan.message);
    } catch (error) {
      invitationStatus = "queue_failed";
      speakerInvitationStatus = "pending";
      await persistQueueFailure(this.env, plan, error);
    }
    return {
      submission: {
        id: input.submissionId,
        status: "accepted" as const,
        revision: input.revision + 1,
      },
      speaker: {
        id: speakerId,
        name: input.name,
        email: input.email,
        roleLabel: input.roleLabel,
        invitationStatus: speakerInvitationStatus,
      },
      invitation: {
        status: invitationStatus,
        operationId: plan.operationId,
      },
      ...(routing ? { routing } : {}),
    };
  }

  async recoverAcceptedCoSpeakerInvitation(
    viewer: Viewer,
    submissionId: string,
    operationId: string,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT CAST(json_extract(audit.metadata_json, '$.revision') AS INTEGER)
                AS committedRevision,
              json_extract(audit.metadata_json, '$.evaluatorEmailRouting.enteredEmail') AS routedEnteredEmail,
              json_extract(audit.metadata_json, '$.evaluatorEmailRouting.routedEmail') AS routedEmail,
              json_extract(audit.metadata_json, '$.evaluatorEmailRouting.personId') AS routedPersonId,
              speaker.id AS speakerId, delivery.recipient_name AS speakerName,
              delivery.recipient_address AS speakerEmail,
              speaker.role_label AS roleLabel,
              speaker.invitation_status AS speakerInvitationStatus,
              speaker.claim_token_hash AS claimTokenHash,
              communication.id AS communicationId,
              delivery.id AS deliveryId,
              operation.status AS operationStatus,
              operation.payload_json AS operationPayloadJson,
              operation.idempotency_key AS operationIdempotencyKey
         FROM audit_events audit
         JOIN submission_speakers speaker
           ON speaker.id = audit.entity_id AND speaker.event_id = audit.event_id
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN events event
           ON event.id = submission.event_id AND event.organisation_id = ?
         JOIN operation_jobs operation
          ON operation.id = audit.correlation_id
          AND operation.event_id = audit.event_id
         JOIN communications communication
           ON communication.operation_id = operation.id
          AND communication.event_id = operation.event_id
         JOIN communication_deliveries delivery
           ON delivery.communication_id = communication.id
          AND delivery.event_id = communication.event_id
          AND delivery.source_id = speaker.id
        WHERE audit.event_id = ? AND audit.actor_person_id = ?
          AND audit.action = 'submission.speaker.added_after_acceptance'
          AND audit.correlation_id = ? AND submission.id = ?
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        submissionId,
      )
      .first<{
        committedRevision: number;
        routedEnteredEmail: EvaluatorEmailRouting["enteredEmail"] | null;
        routedEmail: string | null;
        routedPersonId: string | null;
        speakerId: string;
        speakerName: string;
        speakerEmail: string;
        roleLabel: "Co-author" | "Co-speaker" | "Co-presenter";
        speakerInvitationStatus:
          | "pending"
          | "sent"
          | "claimed"
          | "declined"
          | "expired"
          | "revoked";
        claimTokenHash: string | null;
        communicationId: string;
        deliveryId: string;
        operationStatus: string;
        operationPayloadJson: string;
        operationIdempotencyKey: string;
      }>();
    if (!row) return null;
    if (!Number.isInteger(row.committedRevision) || row.committedRevision < 1) {
      throw new Error(
        "The co-speaker invitation audit is missing its committed submission revision.",
      );
    }
    if (
      [row.routedEnteredEmail, row.routedEmail, row.routedPersonId].some(
        Boolean,
      ) &&
      ![row.routedEnteredEmail, row.routedEmail, row.routedPersonId].every(
        Boolean,
      )
    ) {
      throw new Error(
        "The co-speaker evaluator email routing audit is incomplete.",
      );
    }
    const operationStatus = z
      .enum([
        "queued",
        "queue_failed",
        "received",
        "running",
        "retrying",
        "completed",
        "partially_failed",
        "failed",
        "cancelled",
      ])
      .parse(row.operationStatus);
    let recoveredOperationStatus = operationStatus;
    if (operationStatus === "queued") {
      const operationsQueue = this.env.OPERATIONS_QUEUE;
      if (!operationsQueue) {
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      }
      const message = parseCoSpeakerQueueMessage(row.operationPayloadJson, {
        operationId,
        communicationId: row.communicationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: row.operationIdempotencyKey,
      });
      try {
        await operationsQueue.send(message);
      } catch (error) {
        if (!row.claimTokenHash) {
          throw new Error(
            "The queued co-speaker invitation is missing its claim token hash.",
          );
        }
        await persistCoSpeakerQueueFailure(
          this.env,
          {
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            operationId,
            communicationId: row.communicationId,
            deliveryId: row.deliveryId,
            speakerId: row.speakerId,
            tokenHash: row.claimTokenHash,
          },
          error,
        );
        recoveredOperationStatus = "queue_failed";
      }
    }
    const requiresAttention = [
      "queue_failed",
      "partially_failed",
      "failed",
      "cancelled",
    ].includes(recoveredOperationStatus);
    let recoveredSpeakerStatus = row.speakerInvitationStatus;
    if (requiresAttention && recoveredSpeakerStatus === "sent") {
      const result = await this.env.DB.prepare(
        `UPDATE submission_speakers
            SET invitation_status = 'pending', updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND invitation_status = 'sent'
            AND EXISTS (
              SELECT 1 FROM communications communication
              JOIN communication_deliveries delivery
                ON delivery.communication_id = communication.id
               AND delivery.event_id = communication.event_id
             WHERE communication.id = ? AND communication.operation_id = ?
               AND communication.event_id = ? AND delivery.id = ?
               AND delivery.source_id = submission_speakers.id
            )`,
      )
        .bind(
          row.speakerId,
          viewer.eventId,
          row.communicationId,
          operationId,
          viewer.eventId,
          row.deliveryId,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) {
        throw new Error(
          "The failed co-speaker invitation could not be marked for attention.",
        );
      }
      recoveredSpeakerStatus = "pending";
    }
    return {
      submission: {
        id: submissionId,
        status: "accepted" as const,
        revision: row.committedRevision,
      },
      speaker: {
        id: row.speakerId,
        name: row.speakerName,
        email: row.speakerEmail,
        roleLabel: row.roleLabel,
        invitationStatus: recoveredSpeakerStatus,
      },
      invitation: {
        status: requiresAttention
          ? ("queue_failed" as const)
          : ("queued" as const),
        operationId,
      },
      ...(row.routedEnteredEmail && row.routedEmail && row.routedPersonId
        ? {
            routing: {
              enteredEmail: row.routedEnteredEmail,
              routedEmail: row.routedEmail,
              personId: row.routedPersonId,
            },
          }
        : {}),
    };
  }
}

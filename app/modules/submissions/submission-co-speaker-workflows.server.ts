import { z } from "zod";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluatorEmailAliasContextError,
  resolveEvaluatorEmailAlias,
  type EvaluatorEmailRouting,
} from "~/platform/evaluation/evaluator-email-alias.server";
import {
  hashApplicantToken,
  type PublicForm,
} from "./applicant-session.server";
import {
  buildCoSpeakerInvitationPlan,
  parseCoSpeakerQueueMessage,
  persistCoSpeakerQueueFailure,
  persistQueueFailure,
} from "./co-speaker-invitation.server";
import { SubmissionFormWorkflows } from "./submission-form-workflows.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
} from "./submission-repository-shared";
import {
  draftPayloadSchema,
  MAX_SUBMISSION_SPEAKERS,
} from "./submission-schema";
import { SubmissionCommittedStateError } from "./submission-service-foundation.server";

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

export abstract class SubmissionCoSpeakerWorkflows extends SubmissionFormWorkflows {
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
    if (!context.actorEmailVerified) {
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
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, submission.event_id, ?,
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
          "pending" | "sent" | "claimed" | "declined" | "expired" | "revoked";
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

  async updateClaimedSpeakerProfile(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before updating a speaker profile.",
      );
    }
    const form = await this.getPublicForm(publicSlug);
    return this.updateClaimedSpeakerProfileForForm(
      publicSlug,
      form,
      applicant,
      rawInput,
    );
  }

  async updateClaimedCoSpeakerProfile(
    publicSlug: string,
    speakerId: string,
    request: Request,
    rawInput: unknown,
  ) {
    const { form, applicant } = await this.requireClaimedCoSpeakerContext(
      publicSlug,
      speakerId,
      request,
    );
    return this.updateClaimedSpeakerProfileForForm(
      publicSlug,
      form,
      applicant,
      rawInput,
    );
  }

  protected async updateClaimedSpeakerProfileForForm(
    publicSlug: string,
    form: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
  ) {
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.speaker_profile.update",
      { publicSlug, rawInput },
      () => this.updateClaimedSpeakerProfileD1(form, applicant, rawInput),
    );
  }

  protected async updateClaimedSpeakerProfileD1(
    form: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        revision: z.coerce.number().int().positive(),
        name: z.string().trim().min(1).max(120),
        biography: z.string().trim().max(5_000),
      })
      .parse(rawInput);
    const operationId = crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE people
            SET display_name = ?, biography = ?, profile_revision = profile_revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND profile_revision = ? AND email_verified = 1
            AND EXISTS (
              SELECT 1 FROM submission_speakers speaker
              JOIN submissions submission
                ON submission.id = speaker.submission_id
               AND submission.event_id = speaker.event_id
              JOIN form_versions version
                ON version.id = submission.form_version_id
               AND version.event_id = submission.event_id
             WHERE speaker.person_id = people.id
               AND speaker.invitation_status = 'claimed'
               AND version.form_id = ? AND speaker.event_id = ?
            )`,
      ).bind(
        input.name,
        input.biography || null,
        operationId,
        applicant.personId,
        input.revision,
        form.id,
        form.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE submission_speakers
            SET display_name = ?, updated_at = unixepoch()
          WHERE person_id = ? AND event_id = ? AND invitation_status = 'claimed'
            AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        input.name,
        applicant.personId,
        form.eventId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         ) SELECT ?, event.organisation_id, ?, ?, 'speaker.profile.updated',
                  'person', ?, ?, unixepoch()
             FROM events event
            WHERE event.id = ?
              AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        applicant.personId,
        applicant.personId,
        JSON.stringify({ source: "application_claim" }),
        form.eventId,
        applicant.personId,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionRevisionConflictError();
    }
  }

  async claimCoSpeaker(
    publicSlug: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    await this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.co_speaker.claim",
      { publicSlug, invitationId, applicant },
      () => this.repository.claimCoSpeaker(form.id, applicant, invitationId),
    );
  }

  async getCoSpeakerClaim(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form) return null;
    return this.getCoSpeakerClaimD1(form, speakerId, rawToken);
  }

  protected async requireCoSpeakerClaimForm(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form || !(await this.getCoSpeakerClaimD1(form, speakerId, rawToken))) {
      throw new SubmissionStateError(
        "This co-speaker claim link is invalid or has been replaced.",
      );
    }
    return form;
  }

  async requireClaimedCoSpeakerContext(
    publicSlug: string,
    speakerIdInput: string,
    request: Request,
  ) {
    const speakerId = z.string().min(1).max(100).parse(speakerIdInput);
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form) {
      throw new Response("Application form not found", { status: 404 });
    }
    const applicant = await this.applicants.get(request, form);
    const claimedRelationship = applicant?.verified
      ? await this.env.DB.prepare(
          `SELECT 1 AS available
             FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE speaker.id = ? AND speaker.person_id = ?
              AND speaker.invitation_status = 'claimed'
              AND version.form_id = ? AND speaker.event_id = ?
            LIMIT 1`,
        )
          .bind(speakerId, applicant.personId, form.id, form.eventId)
          .first<{ available: number }>()
      : null;
    if (!applicant?.verified || !claimedRelationship) {
      throw new Response("Application form not found", { status: 404 });
    }
    return { form, applicant };
  }

  protected async getCoSpeakerClaimD1(
    form: PublicForm,
    speakerId: string,
    rawToken: string,
  ) {
    if (!speakerId || !rawToken) return null;
    const tokenHash = await hashApplicantToken(
      `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
    );
    const claim = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.email, speaker.display_name AS displayName,
              speaker.invitation_expires_at AS expiresAt,
              submission.id AS submissionId, submission.title AS submissionTitle
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE speaker.id = ? AND speaker.event_id = ?
          AND speaker.claim_token_hash = ?
          AND speaker.invitation_status IN ('pending','sent','expired')
          AND version.form_id = ?`,
    )
      .bind(speakerId, form.eventId, tokenHash, form.id)
      .first<{
        id: string;
        email: string;
        displayName: string;
        expiresAt: number | null;
        submissionId: string;
        submissionTitle: string;
      }>();
    if (!claim) return null;
    return {
      ...claim,
      expired:
        claim.expiresAt === null ||
        claim.expiresAt <= Math.floor(Date.now() / 1_000),
    };
  }

  async claimCoSpeakerToken(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.requireCoSpeakerClaimForm(
      publicSlug,
      speakerId,
      rawToken,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: null },
      "submission.co_speaker_token.claim",
      { publicSlug, speakerId, rawToken },
      () => this.claimCoSpeakerTokenD1(form, speakerId, rawToken),
      { replay: "reject" },
    );
  }

  protected async claimCoSpeakerTokenD1(
    form: PublicForm,
    speakerId: string,
    rawToken: string,
  ) {
    const expectedClaimTokenHash = await hashApplicantToken(
      `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
    );
    const claim = await this.getCoSpeakerClaimD1(form, speakerId, rawToken);
    if (!claim) {
      throw new SubmissionStateError(
        "This co-speaker claim link is invalid or has been replaced.",
      );
    }
    if (claim.expired) {
      await this.env.DB.prepare(
        `UPDATE submission_speakers
            SET invitation_status = 'expired', updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND invitation_status IN ('pending','sent')
            AND invitation_expires_at <= unixepoch()`,
      )
        .bind(speakerId, form.eventId)
        .run();
      throw new SubmissionCommittedStateError(
        "This co-speaker claim link has expired. Ask an administrator to resend it.",
      );
    }
    const proposedBiography = await this.env.DB.prepare(
      `SELECT revision.speaker_snapshot_json AS speakerSnapshotJson
         FROM submission_revisions revision
        WHERE revision.submission_id = ? AND revision.event_id = ?
        ORDER BY revision.revision_number DESC LIMIT 1`,
    )
      .bind(claim.submissionId, form.eventId)
      .first<{ speakerSnapshotJson: string }>();
    if (!proposedBiography) {
      throw new SubmissionStateError(
        "The latest submission speaker revision is unavailable for this co-speaker claim.",
      );
    }
    const speakers = draftPayloadSchema.shape.speakers.parse(
      JSON.parse(proposedBiography.speakerSnapshotJson),
    );
    const matchingSpeaker = speakers.find(
      (speaker) => speaker.email.toLowerCase() === claim.email.toLowerCase(),
    );
    if (!matchingSpeaker) {
      throw new SubmissionStateError(
        "The latest submission speaker revision does not contain this co-speaker claim.",
      );
    }
    const biography = matchingSpeaker.biography;
    const personId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(personId, claim.email, claim.displayName, biography ?? null),
    ]);
    const person = await this.env.DB.prepare(
      `SELECT id AS personId, email, display_name AS name,
              COALESCE(biography, '') AS biography,
              profile_revision AS profileRevision
         FROM people WHERE email = ? COLLATE NOCASE`,
    )
      .bind(claim.email)
      .first<{
        personId: string;
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
      }>();
    if (!person) {
      throw new SubmissionStateError(
        "The co-speaker identity could not be established.",
      );
    }
    const preparedSession = await this.applicants.prepareVerifiedSession(
      form,
      person.personId,
    );
    if (!preparedSession.applicant.verified) {
      throw new Error("A prepared co-speaker claim session must be verified.");
    }
    await this.repository.claimCoSpeaker(
      form.id,
      preparedSession.applicant,
      speakerId,
      expectedClaimTokenHash,
      preparedSession.persistence,
      biography ?? null,
    );
    const claimedApplicant = {
      ...preparedSession.applicant,
      biography:
        preparedSession.applicant.biography.trim() || biography?.trim() || "",
    };
    return {
      applicant:
        form.accessMode === "account_required"
          ? { ...claimedApplicant, claimOnly: true }
          : claimedApplicant,
      cookie: preparedSession.cookie,
    };
  }

  async resendCoSpeakerInvitation(viewer: Viewer, invitationId: string) {
    return this.projectCommand(
      viewer,
      "submission.co_speaker.resend",
      { invitationId },
      () => this.resendCoSpeakerInvitationD1(viewer, invitationId),
    );
  }

  protected async resendCoSpeakerInvitationD1(
    viewer: Viewer,
    invitationId: string,
  ) {
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const row = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.email, speaker.display_name AS displayName,
              speaker.claim_token_hash AS claimTokenHash,
              submission.id AS submissionId, submission.title AS submissionTitle,
              form.id AS formId, form.public_slug AS publicSlug,
              event.name AS eventName, event.starts_at AS startsAt,
              event.ends_at AS endsAt, event.brand_accent AS brandAccent,
              event.venue_name AS venueName,
              event.city
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
         JOIN events event
           ON event.id = speaker.event_id AND event.organisation_id = ?
        WHERE speaker.id = ? AND speaker.event_id = ? AND speaker.is_primary = 0
          AND speaker.invitation_status IN ('pending','sent','expired')`,
    )
      .bind(viewer.organisationId, invitationId, viewer.eventId)
      .first<{
        id: string;
        email: string;
        displayName: string;
        claimTokenHash: string | null;
        submissionId: string;
        submissionTitle: string;
        formId: string;
        publicSlug: string;
        eventName: string;
        brandAccent: string;
        startsAt: number;
        endsAt: number;
        venueName: string | null;
        city: string | null;
      }>();
    if (!row) {
      throw new SubmissionStateError(
        "This co-speaker invitation is unavailable in the current event.",
      );
    }
    const plan = await buildCoSpeakerInvitationPlan(
      this.env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        eventName: row.eventName,
        brandAccent: row.brandAccent,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        physicalAddress: [row.venueName, row.city]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(", "),
        formId: row.formId,
        publicSlug: row.publicSlug,
        submissionId: row.submissionId,
        submissionTitle: row.submissionTitle,
        requestedByPersonId: viewer.personId,
      },
      row,
    );
    const [updated] = await this.env.DB.batch(plan.statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionStateError(
        "This invitation changed before it could be resent. Refresh and try again.",
      );
    }
    try {
      await operationsQueue.send(plan.message);
      return { status: "queued" as const, operationId: plan.operationId };
    } catch (error) {
      await persistQueueFailure(this.env, plan, error);
      return { status: "queue_failed" as const, operationId: plan.operationId };
    }
  }
}

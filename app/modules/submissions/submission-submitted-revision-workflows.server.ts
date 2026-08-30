import { z } from "zod";
import {
  type AirtableCommandIdentity,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { PublicForm } from "./applicant-session.server";
import { dispatchCoSpeakerInvitationsForSubmissionRevision } from "./co-speaker-invitation.server";
import { routeEvaluationCoSpeakerEmails } from "./evaluation-co-speaker-email-routing.server";
import { SubmissionApplicantEventService } from "./submission-applicant-events.server";
import {
  type Applicant,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type SubmittedRevisionCommand,
  type SubmittedRevisionCommit,
} from "./submission-repository.server";
import {
  draftPayloadSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleAnswers,
} from "./submission-schema";
import {
  answerValidationError,
  PublicFormUnavailableError,
  SubmissionServiceFoundation,
} from "./submission-service-foundation.server";

const SUBMITTED_REVISION_SCOPE = "submission.submitted.revise" as const;

const submittedRevisionCommitSchema = z
  .object({
    submissionId: z.string().min(1).max(100),
    organisationId: z.string().min(1),
    eventId: z.string().min(1),
    revision: z.number().int().positive(),
    invitationCount: z.number().int().nonnegative(),
    webhookCount: z.number().int().nonnegative(),
    auditEventId: z.string().min(1),
  })
  .strict();

function submittedRevisionActorId(personId: string) {
  return `person:${personId}`;
}

export class SubmissionSubmittedRevisionWorkflows extends SubmissionServiceFoundation {
  async reviseSubmitted(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
    intentId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before revising this application.",
      );
    }
    const currentForm = await this.getPublicForm(publicSlug);
    const restoredPayload =
      await this.restoreProtectedParticipantDraftSpeakerFields(
        currentForm,
        applicant,
        rawPayload,
        false,
      );
    const parsedPayload = draftPayloadSchema.parse(restoredPayload);
    const scope = await this.publicScope(currentForm.eventId);
    const identity = await airtableIntentCommand(
      SUBMITTED_REVISION_SCOPE,
      { ...scope, personId: applicant.personId },
      intentId,
      { publicSlug, payload: parsedPayload },
    );
    return this.airtable.executeIdempotent(
      { ...scope, personId: applicant.personId },
      identity,
      () =>
        this.reviseSubmittedD1(
          currentForm,
          scope,
          applicant,
          parsedPayload,
          identity,
        ),
    );
  }

  private async readSubmittedRevisionReplay(
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    identity: AirtableCommandIdentity,
  ): Promise<{ commandId: string; committed: SubmittedRevisionCommit } | null> {
    const actorId = submittedRevisionActorId(applicant.personId);
    const record = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status,
              response_json AS responseJson, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        scope.organisationId,
        scope.eventId,
        actorId,
        SUBMITTED_REVISION_SCOPE,
        identity.idempotencyKey,
      )
      .first<{
        id: string;
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
        entityId: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== identity.requestHash) {
      throw new SubmissionStateError(
        "This revision identifier was already used with different application details. Refresh before trying again.",
      );
    }
    if (record.status !== "completed") {
      throw new SubmissionStateError(
        record.status === "processing"
          ? "This revision request is still being processed. Retry the same revision shortly."
          : "This revision request did not complete. Refresh and submit a new explicit revision.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed submitted-revision command is missing its durable result.",
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(record.responseJson);
    } catch {
      throw new Error(
        "The completed submitted-revision command has an invalid durable result.",
      );
    }
    const committed = submittedRevisionCommitSchema.parse(decoded);
    if (
      committed.organisationId !== scope.organisationId ||
      committed.eventId !== scope.eventId ||
      committed.submissionId !== record.entityId
    ) {
      throw new Error(
        "The completed submitted-revision command is outside its durable event or submission scope.",
      );
    }
    return { commandId: record.id, committed };
  }

  private async resumeSubmittedRevision(
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    commandId: string,
    committed: SubmittedRevisionCommit,
  ) {
    const invitations = await dispatchCoSpeakerInvitationsForSubmissionRevision(
      {
        env: this.env,
        organisationId: scope.organisationId,
        eventId: scope.eventId,
        submissionId: committed.submissionId,
        commandId,
        expectedCount: committed.invitationCount,
      },
    );
    const webhookDeliveries = await new SubmissionApplicantEventService(
      this.env,
    ).resumeRevised(
      scope,
      applicant,
      committed.submissionId,
      commandId,
      committed.revision,
      committed.auditEventId,
    );
    if (webhookDeliveries.length !== committed.webhookCount) {
      throw new Error(
        "The committed submission revision is missing a durable webhook operation.",
      );
    }
    return {
      submissionId: committed.submissionId,
      organisationId: committed.organisationId,
      eventId: committed.eventId,
      revision: committed.revision,
      invitations,
      webhookQueueFailed: webhookDeliveries.some(
        (delivery) => delivery.status === "queue_failed",
      ),
    };
  }

  private async reviseSubmittedD1(
    currentForm: PublicForm,
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    parsedPayload: ReturnType<typeof draftPayloadSchema.parse>,
    identity: AirtableCommandIdentity,
  ) {
    const replay = await this.readSubmittedRevisionReplay(
      scope,
      applicant,
      identity,
    );
    if (replay) {
      return this.resumeSubmittedRevision(
        scope,
        applicant,
        replay.commandId,
        replay.committed,
      );
    }
    const revisionAvailability =
      this.applicationRevisionAvailability(currentForm);
    if (!revisionAvailability.accepting) {
      throw new PublicFormUnavailableError(revisionAvailability.reason);
    }
    const routed = await routeEvaluationCoSpeakerEmails(
      this.env,
      currentForm.eventId,
      applicant,
      parsedPayload,
    );
    const payload = routed.payload;
    if (
      payload.speakers[0]?.email.toLowerCase() !== applicant.email.toLowerCase()
    ) {
      throw answerValidationError({
        speakers: [
          "The primary speaker email must match the verified applicant email.",
        ],
      });
    }
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    if (form.kind !== "submission") {
      throw new SubmissionStateError(
        "Only a submitted proposal can be revised through this workflow.",
      );
    }
    const shapeErrors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(shapeErrors).length) {
      throw answerValidationError(shapeErrors);
    }
    const answers = visibleAnswers(form.version.schema, payload.answers);
    const submittedPayload = { ...payload, answers };
    const errors = validateFinalAnswers(
      form.version.schema,
      submittedPayload.answers,
      submittedPayload.speakers,
      form.minSpeakers,
      form.maxSpeakers,
      submittedPayload.uploads,
    );
    if (Object.keys(errors).length) {
      throw answerValidationError(errors);
    }
    const categoryAnswer = submittedPayload.answers.category;
    const selectedTrackNames = Array.isArray(categoryAnswer)
      ? categoryAnswer
      : typeof categoryAnswer === "string" && categoryAnswer
        ? [categoryAnswer]
        : [];
    const trackSelections = selectedTrackNames.map((trackName) => {
      const trackId = form.version.routing.trackIds[trackName];
      if (!trackId || form.version.routing.trackNames[trackId] !== trackName) {
        throw new SubmissionStateError(
          `Track “${trackName}” is no longer valid for this form version.`,
        );
      }
      return { trackId, trackName };
    });
    if (trackSelections.length === 0) {
      throw new SubmissionStateError(
        "A submission must retain at least one submitted event track.",
      );
    }
    const routedTeamIds = [
      ...new Set(
        selectedTrackNames
          .map((trackName) => form.version.routing.categories[trackName])
          .filter((teamId): teamId is string => Boolean(teamId)),
      ),
    ];
    const command: SubmittedRevisionCommand = {
      recordId: crypto.randomUUID(),
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorId: submittedRevisionActorId(applicant.personId),
      scope: SUBMITTED_REVISION_SCOPE,
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
    };
    const events = new SubmissionApplicantEventService(this.env);
    const prepared = await events.prepareRevised(
      scope,
      applicant,
      submittedPayload.submissionId,
      command.recordId,
      submittedPayload.revision + 1,
    );
    let committed: SubmittedRevisionCommit;
    try {
      committed = await this.repository.reviseSubmitted(
        form,
        applicant,
        submittedPayload,
        {
          trackSelections,
          routedTeamIds,
          command,
          event: prepared,
          evaluatorEmailRoutings: routed.evaluatorEmailRoutings,
        },
      );
    } catch (error) {
      if (!(error instanceof SubmissionRevisionConflictError)) throw error;
      const converged = await this.readSubmittedRevisionReplay(
        scope,
        applicant,
        identity,
      );
      if (!converged) throw error;
      return this.resumeSubmittedRevision(
        scope,
        applicant,
        converged.commandId,
        converged.committed,
      );
    }
    return this.resumeSubmittedRevision(
      scope,
      applicant,
      command.recordId,
      committed,
    );
  }
}

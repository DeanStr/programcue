import {
  findSessionFormatConfiguration,
  parseSessionFormatsConfiguration,
} from "~/modules/events/event-configuration";
import type { EvaluatorEmailRouting } from "~/platform/evaluation/evaluator-email-alias.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  buildCoSpeakerInvitationPlan,
  persistQueueFailure,
} from "./co-speaker-invitation.server";
import {
  buildSubmissionCommitStatements,
  type SubmissionFinalizationOptions,
} from "./submission-commit-statements.server";
import { submissionManagementUrl } from "./submission-management-url.server";
import {
  type Applicant,
  type FormSummary,
  type FormVersion,
  SubmissionDraftSavedError,
  SubmissionStateError,
} from "./submission-repository-shared";
import type { DraftPayload } from "./submission-schema";

function resolveDirectSessionFormat(
  selectedFormat: unknown,
  sessionFormatsJson: string,
  durationOverride: number | null | undefined,
) {
  if (typeof selectedFormat !== "string") {
    throw new SubmissionStateError(
      "Choose one configured format before creating the direct session.",
    );
  }
  let configuredFormat: ReturnType<typeof findSessionFormatConfiguration>;
  try {
    configuredFormat = findSessionFormatConfiguration(
      parseSessionFormatsConfiguration(sessionFormatsJson),
      selectedFormat,
    );
  } catch (error) {
    throw new SubmissionStateError(
      error instanceof Error
        ? error.message
        : "The event has invalid session-format configuration.",
    );
  }
  if (!configuredFormat) {
    throw new SubmissionStateError(
      `Session format “${selectedFormat}” is not configured for this event.`,
    );
  }
  return {
    format: configuredFormat.key,
    durationMinutes:
      durationOverride ?? configuredFormat.defaultDurationMinutes,
  };
}

type SaveApplicantDraft = (
  form: FormSummary & { version: FormVersion },
  applicant: Applicant,
  payload: DraftPayload,
  command?: {
    operationId?: string;
    evaluatorEmailRoutings?: EvaluatorEmailRouting[];
  } | null,
) => Promise<number>;

export class SubmissionDraftFinalizer {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly saveDraft: SaveApplicantDraft,
  ) {}

  async submitDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
    options: SubmissionFinalizationOptions,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before submitting this application.",
      );
    }
    if (options.trackSelections.length === 0) {
      throw new SubmissionStateError(
        "A submission must retain at least one submitted event track.",
      );
    }
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const applicationUrl = submissionManagementUrl(
      this.env,
      payload.submissionId,
    );
    const operationId = options.operationId ?? crypto.randomUUID();
    const draftOperationId = options.operationId
      ? `${options.operationId}:draft`
      : null;
    const event = await this.env.DB.prepare(
      `SELECT organisation_id AS organisationId, name, starts_at AS startsAt,
              ends_at AS endsAt, venue_name AS venueName, city, revision,
              session_formats_json AS sessionFormatsJson,
              brand_accent AS brandAccent
         FROM events WHERE id = ?`,
    )
      .bind(form.eventId)
      .first<{
        organisationId: string;
        name: string;
        startsAt: number;
        endsAt: number;
        venueName: string | null;
        city: string | null;
        revision: number;
        sessionFormatsJson: string;
        brandAccent: string;
      }>();
    if (!event)
      throw new SubmissionStateError("The submission event is unavailable.");
    const directSessionId =
      form.kind === "direct_session" ? crypto.randomUUID() : null;
    const directSession = directSessionId
      ? resolveDirectSessionFormat(
          payload.answers.format,
          event.sessionFormatsJson,
          form.version.routing.directSessionDurationMinutes,
        )
      : null;
    const directSessionFormat = directSession?.format ?? null;
    const directSessionDurationMinutes = directSession?.durationMinutes ?? null;
    let revision: number;
    if (draftOperationId) {
      const state = await this.env.DB.prepare(
        `SELECT status, revision, last_operation_id AS lastOperationId
           FROM submissions
          WHERE id = ? AND event_id = ? AND submitter_person_id = ?`,
      )
        .bind(payload.submissionId, form.eventId, applicant.personId)
        .first<{
          status: string;
          revision: number;
          lastOperationId: string | null;
        }>();
      if (
        state?.status === "draft" &&
        state.lastOperationId === draftOperationId &&
        state.revision === payload.revision + 1
      ) {
        revision = state.revision;
      } else {
        revision = await this.saveDraft(form, applicant, payload, {
          operationId: draftOperationId,
          evaluatorEmailRoutings: options.evaluatorEmailRoutings,
        });
      }
    } else {
      revision = await this.saveDraft(form, applicant, payload, {
        evaluatorEmailRoutings: options.evaluatorEmailRoutings,
      });
    }
    const confirmationOperationId = crypto.randomUUID();
    const confirmationCommunicationId = crypto.randomUUID();
    const confirmationIdempotencyKey = `submission-confirmation:${payload.submissionId}`;
    const confirmationMessage = {
      type: "submission.notification" as const,
      operationId: confirmationOperationId,
      communicationId: confirmationCommunicationId,
      submissionId: payload.submissionId,
      eventId: form.eventId,
      organisationId: event.organisationId,
      idempotencyKey: confirmationIdempotencyKey,
      applicationUrl,
    };
    const invitedSpeakers = await this.env.DB.prepare(
      `SELECT id, email, display_name AS displayName,
              claim_token_hash AS claimTokenHash
         FROM submission_speakers
        WHERE submission_id = ? AND event_id = ? AND is_primary = 0
          AND person_id IS NULL AND invitation_status IN ('pending','sent','expired')
        ORDER BY position, id`,
    )
      .bind(payload.submissionId, form.eventId)
      .all<{
        id: string;
        email: string;
        displayName: string;
        claimTokenHash: string | null;
      }>();
    let invitationPlans: Awaited<
      ReturnType<typeof buildCoSpeakerInvitationPlan>
    >[];
    try {
      invitationPlans = await Promise.all(
        invitedSpeakers.results.map((speaker) =>
          buildCoSpeakerInvitationPlan(
            this.env,
            {
              organisationId: event.organisationId,
              eventId: form.eventId,
              eventName: event.name,
              brandAccent: event.brandAccent,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              physicalAddress: [event.venueName, event.city]
                .filter((value): value is string => Boolean(value?.trim()))
                .join(", "),
              formId: form.id,
              publicSlug: form.publicSlug,
              submissionId: payload.submissionId,
              submissionTitle: String(payload.answers.title),
              requestedByPersonId: applicant.personId,
              submissionOperationId: operationId,
            },
            speaker,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof SubmissionStateError) {
        throw new SubmissionDraftSavedError(
          `Your latest changes were saved, but the application was not submitted: ${error.message}`,
          payload.submissionId,
          revision,
        );
      }
      throw error;
    }
    const nextRevision = revision + 1;
    const submissionSnapshot = JSON.stringify({
      formVersionId: form.version.id,
      versionNumber: form.version.versionNumber,
      schema: form.version.schema,
      answers: payload.answers,
      speakers: payload.speakers,
      uploads: payload.uploads ?? {},
    });
    const finalStatus =
      form.kind === "direct_session" ? "accepted" : "submitted";
    const submissionAuditEventId = crypto.randomUUID();
    const directSessionAuditEventId = directSessionId
      ? crypto.randomUUID()
      : null;
    const webhookService = new WebhookService(this.env);
    const preparedWebhooks = [
      await webhookService.prepareEventForAudit(
        {
          organisationId: event.organisationId,
          eventId: form.eventId,
          personId: applicant.personId,
        },
        {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: payload.submissionId,
          idempotencyKey: `submission.submitted:${payload.submissionId}`,
          correlationId: operationId,
          data: { status: finalStatus, directSessionId },
        },
        submissionAuditEventId,
      ),
      ...(directSessionId && directSessionAuditEventId
        ? [
            await webhookService.prepareEventForAudit(
              {
                organisationId: event.organisationId,
                eventId: form.eventId,
                personId: applicant.personId,
              },
              {
                eventType: "session.created",
                entityType: "session",
                entityId: directSessionId,
                idempotencyKey: `session.created:${directSessionId}`,
                correlationId: operationId,
                data: {
                  source: options.operationId
                    ? "participant_api_direct_session_form"
                    : "public_direct_session_form",
                  intakeReference: payload.submissionId,
                },
              },
              directSessionAuditEventId,
            ),
          ]
        : []),
    ];
    const finalStatements = buildSubmissionCommitStatements({
      env: this.env,
      form,
      applicant,
      payload,
      options,
      event,
      operationId,
      revision,
      nextRevision,
      directSessionId,
      directSessionFormat,
      directSessionDurationMinutes,
      finalStatus,
      submissionSnapshot,
      submissionAuditEventId,
      directSessionAuditEventId,
      confirmationOperationId,
      confirmationCommunicationId,
      confirmationIdempotencyKey,
      applicationUrl,
      confirmationMessage,
    });
    const invitationStatementIndexes: number[] = [];
    for (const plan of invitationPlans) {
      invitationStatementIndexes.push(finalStatements.length);
      finalStatements.push(...plan.statements);
    }
    finalStatements.push(
      ...preparedWebhooks.flatMap((webhook) => webhook.statements),
    );
    const batchResults = await this.env.DB.batch(finalStatements);
    const [result] = batchResults;
    if ((result.meta.changes ?? 0) !== 1) {
      throw new SubmissionDraftSavedError(
        "The form, session-format configuration, submission limit, routed evaluation team or native upload changed before final submission. Your latest changes were saved as a draft.",
        payload.submissionId,
        revision,
      );
    }
    await Promise.all(
      preparedWebhooks.map((webhook) =>
        webhookService.dispatchPreparedEvent(webhook),
      ),
    );
    let confirmationStatus: "queued" | "queue_failed" = "queued";
    try {
      await operationsQueue.send(confirmationMessage);
    } catch (error) {
      confirmationStatus = "queue_failed";
      const internalMessage = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(internalMessage, confirmationOperationId, form.eventId),
        this.env.DB.prepare(
          `UPDATE communications SET status = 'failed', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(confirmationCommunicationId, form.eventId),
      ]);
    }
    const persistedInvitationPlans = invitationPlans.filter(
      (_plan, index) =>
        (batchResults[invitationStatementIndexes[index]]?.meta.changes ?? 0) ===
        1,
    );
    let invitationQueueFailures = 0;
    for (const plan of persistedInvitationPlans) {
      try {
        await operationsQueue.send(plan.message);
      } catch (error) {
        invitationQueueFailures += 1;
        await persistQueueFailure(this.env, plan, error);
      }
    }
    return {
      submissionId: payload.submissionId,
      eventId: form.eventId,
      organisationId: event.organisationId,
      directSessionId,
      status: finalStatus,
      confirmation: {
        status: confirmationStatus,
        communicationId: confirmationCommunicationId,
        operationId: confirmationOperationId,
      },
      invitations: {
        queued: persistedInvitationPlans.length - invitationQueueFailures,
        queueFailed: invitationQueueFailures,
      },
    };
  }
}

import type { PreparedWebhookEvent } from "~/platform/operations/webhook-service.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import type { Applicant } from "./submission-repository-shared";

export type PreparedApplicantMutationEvent = {
  organisationId: string;
  eventId: string;
  auditEventId: string;
  webhook: PreparedWebhookEvent;
};

type EventScope = { organisationId: string; eventId: string };

export class SubmissionApplicantEventService {
  private readonly webhooks: WebhookService;

  constructor(env: CloudflareEnvironment) {
    this.webhooks = new WebhookService(env);
  }

  async prepareDraftCreated(
    scope: EventScope,
    applicant: Applicant,
    submissionId: string,
  ): Promise<PreparedApplicantMutationEvent> {
    const auditEventId = crypto.randomUUID();
    return {
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      auditEventId,
      webhook: await this.webhooks.prepareEventForAudit(
        { ...scope, personId: applicant.personId },
        {
          eventType: "submission.created",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.created:${submissionId}`,
          correlationId: submissionId,
          data: {
            source: "public_application_form",
            status: "draft",
            anonymous: !applicant.verified,
          },
        },
        auditEventId,
      ),
    };
  }

  async prepareWithdrawn(
    scope: EventScope,
    applicant: Extract<Applicant, { verified: true }>,
    submissionId: string,
    operationId: string,
    revision: number,
  ): Promise<PreparedApplicantMutationEvent> {
    const auditEventId = crypto.randomUUID();
    return {
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      auditEventId,
      webhook: await this.webhooks.prepareEventForAudit(
        { ...scope, personId: applicant.personId },
        {
          eventType: "submission.withdrawn",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.withdrawn:${submissionId}`,
          correlationId: operationId,
          data: { status: "withdrawn", revision },
        },
        auditEventId,
      ),
    };
  }

  dispatch(event: PreparedApplicantMutationEvent) {
    return this.webhooks.dispatchPreparedEvent(event.webhook);
  }
}

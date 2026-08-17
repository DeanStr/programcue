import type { Viewer } from "~/platform/auth/authorize.server";
import { communicationDeliveryIdempotencyKey } from "./communication-service-shared";
import {
  type DecisionNotificationReadiness,
  inspectDecisionNotificationReadiness,
} from "./decision-notification-readiness.server";
import { formatEventDateMarkers, renderMergeTemplate } from "./merge-template";

export const DECISION_NOTIFICATION_RENDER_CONTRACT_VERSION = 1;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type DecisionNotificationIntent = {
  decisionId: string;
  submissionId: string;
  operationId: string;
  communicationId: string;
  deliveryId: string;
  operationItemId: string;
  operationIdempotencyKey: string;
  correlationId: string;
  queuePayloadJson: string;
  templateVersionId: string;
  templateName: string;
  templateVersionNumber: number;
  templateSubject: string;
  templateContentJson: string;
  senderProfileId: string;
  senderProvider: "resend" | "mailpit";
  senderFromName: string;
  senderFromEmail: string;
  senderReplyToEmail: string | null;
  recipientPersonId: string | null;
  recipientAddress: string;
  recipientName: string;
  deliveryIdempotencyKey: string;
  audienceJson: string;
  contentSnapshotJson: string;
  sourceValuesJson: string;
  renderedSubject: string;
  renderedBodySha256: string;
  eventName: string;
  eventBrandAccent: string;
  eventStartsAt: number;
  eventEndsAt: number;
};

export async function prepareDecisionNotificationIntent(
  env: CloudflareEnvironment,
  input: {
    viewer: Pick<Viewer, "organisationId" | "eventId">;
    decisionId: string;
    operationId: string;
    submissionId: string;
    submissionTitle: string;
    decision: "accepted" | "rejected" | "waitlisted";
    rationale: string;
    feedback: string[];
    recipientPersonId: string | null;
    recipientAddress: string | null;
    recipientName: string | null;
    event: {
      name: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
    };
  },
): Promise<
  | { error: string; intent: null }
  | { error: null; intent: DecisionNotificationIntent }
> {
  const readiness = await inspectDecisionNotificationReadiness(env, {
    organisationId: input.viewer.organisationId,
    eventId: input.viewer.eventId,
    recipientAddress: input.recipientAddress,
  });
  if (readiness.error) return { error: readiness.error, intent: null };
  return {
    error: null,
    intent: await intentFromReadiness(input, readiness),
  };
}

async function intentFromReadiness(
  input: Parameters<typeof prepareDecisionNotificationIntent>[1],
  readiness: DecisionNotificationReadiness,
): Promise<DecisionNotificationIntent> {
  const { provider, template, content, sender } = readiness;
  if (
    !provider ||
    !template?.subjectTemplate ||
    !content ||
    !sender ||
    !input.recipientAddress
  ) {
    throw new Error(
      "Decision notification readiness succeeded without its required records.",
    );
  }
  const operationIdempotencyKey = `decision-notification:${input.decisionId}`;
  const communicationId = `decision-communication:${input.operationId}`;
  const deliveryId = `decision-delivery:${input.operationId}`;
  const operationItemId = `decision-delivery-item:${input.operationId}`;
  const recipientName = input.recipientName ?? input.recipientAddress;
  const sourceValues = {
    "submission.title": input.submissionTitle,
    "decision.outcome": input.decision,
    "decision.rationale": input.rationale,
    "decision.feedback": input.feedback.join("\n\n"),
  };
  const mergeValues = {
    "recipient.name": recipientName,
    "recipient.firstName":
      recipientName.trim().split(/\s+/)[0] || recipientName,
    "event.name": input.event.name,
    "event.dates": formatEventDateMarkers(
      input.event.startsAt,
      input.event.endsAt,
    ),
    ...sourceValues,
  };
  const renderedSubject = renderMergeTemplate(
    template.subjectTemplate,
    mergeValues,
  );
  if (!renderedSubject.trim() || renderedSubject.length > 500) {
    throw new Error(
      "The rendered decision notification subject must contain 1 to 500 characters.",
    );
  }
  const renderedBody = renderMergeTemplate(content.body, mergeValues);
  const queuePayload = {
    operationId: input.operationId,
    communicationId,
    eventId: input.viewer.eventId,
    organisationId: input.viewer.organisationId,
    type: "decision.notification" as const,
    idempotencyKey: operationIdempotencyKey,
    payload: { decisionId: input.decisionId },
  };
  return {
    decisionId: input.decisionId,
    submissionId: input.submissionId,
    operationId: input.operationId,
    communicationId,
    deliveryId,
    operationItemId,
    operationIdempotencyKey,
    correlationId: crypto.randomUUID(),
    queuePayloadJson: JSON.stringify(queuePayload),
    templateVersionId: template.id,
    templateName: template.name,
    templateVersionNumber: template.versionNumber,
    templateSubject: template.subjectTemplate,
    templateContentJson: template.contentJson,
    senderProfileId: sender.id,
    senderProvider: provider.provider,
    senderFromName: sender.fromName,
    senderFromEmail: sender.fromEmail,
    senderReplyToEmail: sender.replyToEmail,
    recipientPersonId: input.recipientPersonId,
    recipientAddress: input.recipientAddress,
    recipientName,
    deliveryIdempotencyKey: await communicationDeliveryIdempotencyKey(
      operationIdempotencyKey,
      input.recipientAddress,
    ),
    audienceJson: JSON.stringify({
      type: "decision",
      decisionId: input.decisionId,
      submissionId: input.submissionId,
      renderContractVersion: DECISION_NOTIFICATION_RENDER_CONTRACT_VERSION,
    }),
    contentSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      category: "decision",
      renderContractVersion: DECISION_NOTIFICATION_RENDER_CONTRACT_VERSION,
      subjectTemplate: template.subjectTemplate,
      template: {
        id: template.id,
        name: template.name,
        versionNumber: template.versionNumber,
      },
      sender: {
        id: sender.id,
        provider: provider.provider,
        fromName: sender.fromName,
        fromEmail: sender.fromEmail,
        replyToEmail: sender.replyToEmail,
      },
      content,
      event: {
        eventName: input.event.name,
        brandAccent: input.event.brandAccent,
        startsAt: input.event.startsAt,
        endsAt: input.event.endsAt,
      },
    }),
    sourceValuesJson: JSON.stringify(sourceValues),
    renderedSubject,
    renderedBodySha256: await sha256(renderedBody),
    eventName: input.event.name,
    eventBrandAccent: input.event.brandAccent,
    eventStartsAt: input.event.startsAt,
    eventEndsAt: input.event.endsAt,
  };
}

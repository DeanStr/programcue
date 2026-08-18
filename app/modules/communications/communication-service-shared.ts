import { requireValue } from "~/lib/required-value";
import { isCredentialFreeHttpsUrl } from "~/modules/events/https-url";
import {
  type AudienceType,
  type CommunicationCategory,
  type ConfirmCommunicationInput,
  type TemplateContent,
  templateContentSchema,
} from "./communication-schema";
import {
  formatEventDateMarkers,
  formatTaskDueDate,
  type MergeValues,
  mergeTemplateVariables,
  representativeMergeValues,
} from "./merge-template";
import type { RecipientPreview } from "./recipient-query.server";

export type TemplateVersionRow = {
  id: string;
  templateId: string;
  name: string;
  category: CommunicationCategory;
  templateStatus: "draft" | "active" | "archived";
  versionNumber: number;
  subject: string | null;
  contentJson: string;
  versionStatus: "draft" | "published" | "retired";
  publishedAt: number | null;
};

export type EventMergeRow = {
  eventName: string;
  brandAccent: string;
  logoUrl: string | null;
  startsAt: number;
  endsAt: number;
};

export function eventEmailLogoUrl(
  env: CloudflareEnvironment,
  event: Pick<EventMergeRow, "logoUrl">,
) {
  if (!event.logoUrl) return undefined;
  const logoUrl = event.logoUrl.trim();
  if (isCredentialFreeHttpsUrl(logoUrl)) return logoUrl;
  if (
    !logoUrl.startsWith("/") ||
    logoUrl.startsWith("//") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Logo paths reject ASCII controls.
    /[\u0000-\u001f\u007f\\]/u.test(logoUrl)
  ) {
    throw new CommunicationStateError(
      "The published event logo URL is invalid.",
    );
  }
  const base = env.BETTER_AUTH_URL?.trim();
  if (!base)
    throw new CommunicationStateError(
      "BETTER_AUTH_URL is required to render a published event logo in email.",
    );
  let resolved: URL;
  let configured: URL;
  try {
    configured = new URL(base);
    resolved = new URL(logoUrl, configured);
  } catch {
    throw new CommunicationStateError(
      "BETTER_AUTH_URL must be an absolute HTTP(S) URL.",
    );
  }
  if (resolved.origin !== configured.origin) {
    throw new CommunicationStateError(
      "The published event logo URL is invalid.",
    );
  }
  return resolved.toString();
}

export type SenderRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

export const resendDeliveryEventStates = {
  "email.sent": { status: "sent", precedenceRank: 1, statusRank: 1 },
  "email.delivered": { status: "delivered", precedenceRank: 1, statusRank: 2 },
  "email.opened": { status: "opened", precedenceRank: 1, statusRank: 3 },
  "email.clicked": { status: "clicked", precedenceRank: 1, statusRank: 4 },
  "email.failed": { status: "failed", precedenceRank: 2, statusRank: 1 },
  "email.bounced": { status: "bounced", precedenceRank: 2, statusRank: 2 },
  "email.complained": {
    status: "suppressed",
    precedenceRank: 2,
    statusRank: 3,
  },
  "email.suppressed": {
    status: "suppressed",
    precedenceRank: 2,
    statusRank: 3,
  },
} as const;

export const resendDeliveryEventStatesJson = JSON.stringify(
  Object.entries(resendDeliveryEventStates).map(([eventType, state]) => ({
    eventType,
    ...state,
  })),
);

export type CommunicationTemplateVersion = Omit<
  TemplateVersionRow,
  "contentJson" | "subject"
> & { subject: string; content: TemplateContent };

export type CommunicationPreview = {
  template: CommunicationTemplateVersion;
  recipients: RecipientPreview;
  confirmation: {
    recipientFingerprint: string;
    deliverableFingerprint: string;
    suppressedCount: number;
  };
  rendered: { subject: string; html: string; text: string };
  mergeSnapshot: {
    event: EventMergeRow;
    sourceValues: Record<string, MergeValues>;
  };
  provider: {
    configured: boolean;
    sender: string | null;
    senderProfile: SenderRow | null;
    queueConfigured: boolean;
  };
};

export class CommunicationNotFoundError extends Error {
  constructor(message = "Communication template was not found in this event.") {
    super(message);
    this.name = "CommunicationNotFoundError";
  }
}

export class CommunicationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationStateError";
  }
}

export class CommunicationQueueUnavailableError extends Error {
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      "The communication was saved but could not be sent. Retry it from the Operation Centre.",
      { cause },
    );
    this.name = "CommunicationQueueUnavailableError";
  }
}

export function parseContent(row: TemplateVersionRow) {
  let value: unknown;
  try {
    value = JSON.parse(row.contentJson);
  } catch {
    throw new CommunicationStateError(
      `Template version ${row.id} contains invalid JSON.`,
    );
  }
  return templateContentSchema.parse(value);
}

export function parseEmailSubject(
  row: Pick<TemplateVersionRow, "id" | "subject">,
) {
  if (
    row.subject === null ||
    row.subject !== row.subject.trim() ||
    row.subject.length < 1 ||
    row.subject.length > 200
  ) {
    throw new CommunicationStateError(
      `Email template version ${row.id} has an invalid subject.`,
    );
  }
  return row.subject;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export function mergeValues(
  event: EventMergeRow,
  recipient?: { name: string },
): MergeValues {
  return {
    ...representativeMergeValues,
    "recipient.name":
      recipient?.name ?? representativeMergeValues["recipient.name"],
    "recipient.firstName": firstName(
      recipient?.name ?? String(representativeMergeValues["recipient.name"]),
    ),
    "event.name": event.eventName,
    "event.dates": formatEventDateMarkers(event.startsAt, event.endsAt),
  };
}

const sourceVariableRequirements: Record<
  string,
  {
    audiences: ReadonlySet<AudienceType>;
    categories: ReadonlySet<CommunicationCategory>;
  }
> = {
  "submission.title": {
    audiences: new Set(["submitted_applicants", "decision_recipients"]),
    categories: new Set(["submission_confirmation", "decision"]),
  },
  "decision.outcome": {
    audiences: new Set(["decision_recipients"]),
    categories: new Set(["decision"]),
  },
  "decision.rationale": {
    audiences: new Set(["decision_recipients"]),
    categories: new Set(["decision"]),
  },
  "decision.feedback": {
    audiences: new Set(["decision_recipients"]),
    categories: new Set(["decision"]),
  },
  "task.title": {
    audiences: new Set([
      "incomplete_speakers",
      "due_speakers",
      "overdue_speakers",
    ]),
    categories: new Set(["task_reminder"]),
  },
  "task.dueDate": {
    audiences: new Set([
      "incomplete_speakers",
      "due_speakers",
      "overdue_speakers",
    ]),
    categories: new Set(["task_reminder"]),
  },
};

export function sourceVariables(
  template: Pick<
    CommunicationTemplateVersion,
    "subject" | "content" | "category"
  >,
) {
  return [
    ...new Set([
      ...mergeTemplateVariables(template.subject),
      ...mergeTemplateVariables(template.content.body),
    ]),
  ].filter((variable) => variable in sourceVariableRequirements);
}

export function assertMergeAudienceCompatible(
  template: Pick<
    CommunicationTemplateVersion,
    "subject" | "content" | "category"
  >,
  audienceType: AudienceType,
) {
  const incompatible = sourceVariables(template).filter((variable) => {
    const requirement = requireValue(
      sourceVariableRequirements[variable],
      "Required sourceVariableRequirements[variable] is unavailable.",
    );
    return (
      !requirement.audiences.has(audienceType) ||
      !requirement.categories.has(template.category)
    );
  });
  if (incompatible.length) {
    throw new CommunicationStateError(
      `The selected audience cannot provide ${incompatible.map((variable) => `{{${variable}}}`).join(", ")}. Choose an audience backed by the referenced records.`,
    );
  }
}

export async function snapshotSourceValues(
  env: CloudflareEnvironment,
  eventId: string,
  variables: string[],
  recipients: RecipientPreview["deliverable"],
) {
  const snapshots = new Map<string, MergeValues>();
  if (!variables.length) return snapshots;
  const sourceIds = [
    ...new Set(
      recipients.map((recipient) => recipient.sourceId).filter(Boolean),
    ),
  ] as string[];
  if (
    sourceIds.length !== new Set(recipients.map((item) => item.sourceId)).size
  ) {
    throw new CommunicationStateError(
      "Every recipient must have the source record required by this template.",
    );
  }
  for (const sourceId of sourceIds) snapshots.set(sourceId, {});
  const requiresDecision = variables.some((variable) =>
    variable.startsWith("decision."),
  );

  if (
    variables.some(
      (variable) =>
        variable.startsWith("submission.") || variable.startsWith("decision."),
    )
  ) {
    const rows = await env.DB.prepare(
      `SELECT submission.id, submission.title,
              decision.id AS decisionId, decision.decision AS decisionOutcome,
              decision.rationale,
              decision.notification_feedback_json AS notificationFeedbackJson
         FROM submissions submission
         LEFT JOIN submission_decisions decision
           ON decision.submission_id = submission.id
          AND decision.event_id = submission.event_id
          AND decision.status = 'published'
        WHERE submission.event_id = ?
          AND submission.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(eventId, JSON.stringify(sourceIds))
      .all<{
        id: string;
        title: string;
        decisionId: string | null;
        decisionOutcome: string | null;
        rationale: string | null;
        notificationFeedbackJson: string | null;
      }>();
    if (rows.results.length !== sourceIds.length) {
      throw new CommunicationStateError(
        "A submission required by this audience is no longer available. Preview again.",
      );
    }
    for (const row of rows.results) {
      if (requiresDecision && (!row.decisionId || !row.decisionOutcome)) {
        throw new CommunicationStateError(
          "A published decision required by this audience is unavailable. Preview again.",
        );
      }
      const values = requireValue(
        snapshots.get(row.id),
        "Required snapshots.get(row.id) is unavailable.",
      );
      if (variables.includes("submission.title"))
        values["submission.title"] = row.title;
      if (variables.includes("decision.outcome"))
        values["decision.outcome"] = requireValue(
          row.decisionOutcome,
          "Required row.decisionOutcome is unavailable.",
        );
      if (variables.includes("decision.rationale"))
        values["decision.rationale"] = row.rationale ?? "";
      if (variables.includes("decision.feedback")) {
        if (row.notificationFeedbackJson === null) {
          throw new CommunicationStateError(
            "A decision required by this audience contains invalid feedback.",
          );
        }
        let feedback: unknown;
        try {
          feedback = JSON.parse(row.notificationFeedbackJson);
        } catch {
          throw new CommunicationStateError(
            "A decision required by this audience contains invalid feedback.",
          );
        }
        if (
          !Array.isArray(feedback) ||
          feedback.some((item) => typeof item !== "string")
        )
          throw new CommunicationStateError(
            "A decision required by this audience contains invalid feedback.",
          );
        values["decision.feedback"] = feedback.join("\n\n");
      }
    }
  }

  if (variables.includes("task.title") || variables.includes("task.dueDate")) {
    const rows = await env.DB.prepare(
      `SELECT task.id, task.title, task.due_at AS dueAt,
              event.timezone AS eventTimezone
         FROM task_instances task
         JOIN events event ON event.id = task.event_id
        WHERE task.event_id = ?
          AND task.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(eventId, JSON.stringify(sourceIds))
      .all<{
        id: string;
        title: string;
        dueAt: number | null;
        eventTimezone: string;
      }>();
    if (rows.results.length !== sourceIds.length) {
      throw new CommunicationStateError(
        "A task required by this audience is no longer available. Preview again.",
      );
    }
    for (const row of rows.results) {
      const values = requireValue(
        snapshots.get(row.id),
        "Required snapshots.get(row.id) is unavailable.",
      );
      if (variables.includes("task.title")) values["task.title"] = row.title;
      if (variables.includes("task.dueDate")) {
        if (row.dueAt === null) {
          throw new CommunicationStateError(
            "A due date required by this task-reminder template is unavailable. Preview again after assigning one.",
          );
        }
        values["task.dueDate"] = formatTaskDueDate(
          row.dueAt,
          row.eventTimezone,
        );
      }
    }
  }
  return snapshots;
}

const communicationDeliveryIdempotencyNamespace =
  "programcue:communication-delivery:v1:";

export async function communicationDeliveryIdempotencyKey(
  baseKey: string,
  recipientAddress: string,
) {
  const identity = JSON.stringify([
    baseKey,
    recipientAddress.toLocaleLowerCase("en"),
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const fingerprint = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${communicationDeliveryIdempotencyNamespace}${fingerprint}`;
}

export async function recipientFingerprint(
  recipients: RecipientPreview["deliverable"],
  authority?: unknown,
) {
  const identities = recipients
    .map((recipient) =>
      JSON.stringify([
        recipient.address.toLocaleLowerCase("en"),
        recipient.name,
        recipient.personId,
        recipient.sourceId,
      ]),
    )
    .sort();
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          recipients: identities,
          ...(authority === undefined ? {} : { authority }),
        }),
      ),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function communicationRequestHash(
  input: ConfirmCommunicationInput & {
    scheduledAt?: number | null;
    mode?: "send" | "test";
  },
) {
  const identity = JSON.stringify({
    schemaVersion: 1,
    templateVersionId: input.templateVersionId,
    audienceType: input.audienceType,
    kind: input.kind,
    recipientFingerprint: input.recipientFingerprint,
    deliverableFingerprint: input.deliverableFingerprint,
    suppressedCount: input.suppressedCount,
    scheduledAt: input.scheduledAt ?? null,
    mode: input.mode ?? "send",
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export type ExistingCommunication = {
  id: string;
  operationId: string | null;
  status: string;
  operationStatus: string | null;
  requestHash: string | null;
};

export function communicationReplay(
  existing: ExistingCommunication,
  requestHash: string,
) {
  if (existing.requestHash !== requestHash) {
    throw new CommunicationStateError(
      "This idempotency key is already associated with a different communication request.",
    );
  }
  if (
    existing.status === "scheduled" &&
    !existing.operationId &&
    !existing.operationStatus
  ) {
    return {
      communicationId: existing.id,
      operationId: null,
      status: existing.status,
      operationStatus: null,
      duplicate: true as const,
    };
  }
  if (!existing.operationId || !existing.operationStatus) {
    throw new Error(
      "The communication idempotency record is missing its durable operation.",
    );
  }
  if (existing.operationStatus === "queue_failed") {
    throw new CommunicationQueueUnavailableError(existing.operationId);
  }
  return {
    communicationId: existing.id,
    operationId: existing.operationId,
    status: existing.status,
    operationStatus: existing.operationStatus,
    duplicate: true as const,
  };
}

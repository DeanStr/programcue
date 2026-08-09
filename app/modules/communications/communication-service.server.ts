import { ZodError } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import {
  confirmCommunicationSchema,
  previewCommunicationSchema,
  resendWebhookEventSchema,
  saveTemplateSchema,
  templateContentSchema,
  type AudienceType,
  type CommunicationCategory,
  type ConfirmCommunicationInput,
  type PreviewCommunicationInput,
  type SaveTemplateInput,
  type TemplateContent,
} from "./communication-schema";
import { renderProgramCueEmail } from "./email-templates/render-email.server";
import {
  formatEventDateMarkers,
  mergeTemplateVariables,
  renderMergeTemplate,
  representativeMergeValues,
  type MergeValues,
} from "./merge-template";
import {
  RecipientQuery,
  type RecipientPreview,
} from "./recipient-query.server";

type TemplateVersionRow = {
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

type EventMergeRow = {
  eventName: string;
  startsAt: number;
  endsAt: number;
};

type SenderRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

const resendDeliveryEventStates = {
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

const resendDeliveryEventStatesJson = JSON.stringify(
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
  provider: {
    configured: boolean;
    sender: string | null;
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
      `The communication was saved, but operation ${operationId} could not be queued. Retry it from the Operation Centre.`,
      { cause },
    );
    this.name = "CommunicationQueueUnavailableError";
  }
}

function parseContent(row: TemplateVersionRow) {
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

function parseEmailSubject(row: Pick<TemplateVersionRow, "id" | "subject">) {
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

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

function mergeValues(
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
  "task.title": {
    audiences: new Set(["incomplete_speakers"]),
    categories: new Set(["task_reminder"]),
  },
};

function sourceVariables(
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

function assertMergeAudienceCompatible(
  template: Pick<
    CommunicationTemplateVersion,
    "subject" | "content" | "category"
  >,
  audienceType: AudienceType,
) {
  const incompatible = sourceVariables(template).filter((variable) => {
    const requirement = sourceVariableRequirements[variable]!;
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

async function snapshotSourceValues(
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

  if (variables.some((variable) => variable.startsWith("submission."))) {
    const rows = await env.DB.prepare(
      `SELECT id, title, status FROM submissions
        WHERE event_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(eventId, JSON.stringify(sourceIds))
      .all<{ id: string; title: string; status: string }>();
    if (rows.results.length !== sourceIds.length) {
      throw new CommunicationStateError(
        "A submission required by this audience is no longer available. Preview again.",
      );
    }
    for (const row of rows.results) {
      const values = snapshots.get(row.id)!;
      if (variables.includes("submission.title"))
        values["submission.title"] = row.title;
      if (variables.includes("decision.outcome"))
        values["decision.outcome"] = row.status;
    }
  }

  if (variables.includes("task.title")) {
    const rows = await env.DB.prepare(
      `SELECT id, title FROM task_instances
        WHERE event_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(eventId, JSON.stringify(sourceIds))
      .all<{ id: string; title: string }>();
    if (rows.results.length !== sourceIds.length) {
      throw new CommunicationStateError(
        "A task required by this audience is no longer available. Preview again.",
      );
    }
    for (const row of rows.results)
      snapshots.get(row.id)!["task.title"] = row.title;
  }
  return snapshots;
}

const communicationDeliveryIdempotencyNamespace =
  "programcue:communication-delivery:v1:";

async function communicationDeliveryIdempotencyKey(
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

async function recipientFingerprint(
  recipients: RecipientPreview["deliverable"],
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
      new TextEncoder().encode(JSON.stringify(identities)),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function communicationRequestHash(input: ConfirmCommunicationInput) {
  const identity = JSON.stringify({
    schemaVersion: 1,
    templateVersionId: input.templateVersionId,
    audienceType: input.audienceType,
    kind: input.kind,
    recipientFingerprint: input.recipientFingerprint,
    deliverableFingerprint: input.deliverableFingerprint,
    suppressedCount: input.suppressedCount,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

type ExistingCommunication = {
  id: string;
  operationId: string | null;
  status: string;
  operationStatus: string | null;
  requestHash: string | null;
};

function communicationReplay(
  existing: ExistingCommunication,
  requestHash: string,
) {
  if (existing.requestHash !== requestHash) {
    throw new CommunicationStateError(
      "This idempotency key is already associated with a different communication request.",
    );
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

export class CommunicationService {
  readonly recipients: RecipientQuery;

  constructor(private readonly env: CloudflareEnvironment) {
    this.recipients = new RecipientQuery(env);
  }

  async listCentre(viewer: Viewer, options: { filter?: "failed" } = {}) {
    const statusFilter = options.filter === "failed" ? "failed" : "";
    const [templateResult, communicationResult, sender] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT tv.id, tv.template_id AS templateId, tv.name, tv.category,
               t.status AS templateStatus, tv.version_number AS versionNumber,
               tv.subject_template AS subject, tv.content_json AS contentJson,
               tv.status AS versionStatus, tv.published_at AS publishedAt
          FROM communication_template_versions tv
          JOIN communication_templates t ON t.id = tv.template_id AND t.event_id = tv.event_id
          JOIN events e ON e.id = tv.event_id AND e.organisation_id = ?
         WHERE tv.event_id = ? AND t.status <> 'archived'
         ORDER BY t.updated_at DESC, tv.version_number DESC
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<TemplateVersionRow>(),
      this.env.DB.prepare(
        `
        SELECT c.id, c.status, c.channel, c.kind, c.recipient_count AS recipientCount,
               c.created_at AS createdAt, c.sent_at AS sentAt, c.operation_id AS operationId,
               COUNT(CASE WHEN d.status IN ('failed','bounced','suppressed') THEN 1 END) AS failedCount,
               COUNT(CASE WHEN d.status IN ('sent','delivered','opened','clicked') THEN 1 END) AS sentCount
          FROM communications c
          JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
          LEFT JOIN communication_deliveries d ON d.communication_id = c.id
         WHERE c.event_id = ?
           AND (? = '' OR c.status IN ('failed','partially_failed'))
         GROUP BY c.id
         ORDER BY c.created_at DESC
         LIMIT 30
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, statusFilter)
        .all<{
          id: string;
          status: string;
          channel: string;
          kind: string;
          recipientCount: number;
          createdAt: number;
          sentAt: number | null;
          operationId: string | null;
          failedCount: number;
          sentCount: number;
        }>(),
      this.getVerifiedSender(viewer),
    ]);
    return {
      templates: templateResult.results.map((row) => ({
        ...row,
        subject: parseEmailSubject(row),
        content: parseContent(row),
        contentJson: undefined,
      })) as CommunicationTemplateVersion[],
      communications: communicationResult.results,
      provider: {
        configured: Boolean(this.env.RESEND_API_KEY?.trim() && sender),
        sender: sender ? `${sender.fromName} <${sender.fromEmail}>` : null,
        queueConfigured: Boolean(this.env.OPERATIONS_QUEUE),
      },
    };
  }

  async saveTemplate(viewer: Viewer, input: SaveTemplateInput) {
    const parsed = saveTemplateSchema.parse(input);
    const templateId = parsed.templateId ?? crypto.randomUUID();
    if (parsed.templateId) {
      const existing = await this.env.DB.prepare(
        `
        SELECT t.id FROM communication_templates t
        JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
        WHERE t.id = ? AND t.event_id = ? AND t.status <> 'archived'
      `,
      )
        .bind(viewer.organisationId, templateId, viewer.eventId)
        .first();
      if (!existing) throw new CommunicationNotFoundError();
    }
    const event = await this.getEvent(viewer);
    const versionId = crypto.randomUUID();
    const values = mergeValues(event);
    const subject = renderMergeTemplate(parsed.subject, values);
    const body = renderMergeTemplate(parsed.content.body, values);
    const preview = await renderProgramCueEmail({
      preview: subject,
      heading: subject,
      body,
      eventName: event.eventName,
      physicalAddress: parsed.content.physicalAddress,
      buttonText: parsed.content.buttonText,
      buttonUrl: parsed.content.buttonUrl,
    });
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO communication_templates (
          id, event_id, name, category, status, created_by_person_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, unixepoch(), unixepoch())
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category,
          updated_at = unixepoch()
        WHERE communication_templates.event_id = excluded.event_id
      `,
      ).bind(
        templateId,
        viewer.eventId,
        parsed.name,
        parsed.category,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO communication_template_versions (
          id, event_id, template_id, version_number, name, category, channel, subject_template,
          content_json, rendered_preview_html, status, created_by_person_id, created_at
        ) SELECT ?, template.event_id, template.id,
                 COALESCE((
                   SELECT MAX(existing.version_number)
                     FROM communication_template_versions existing
                    WHERE existing.template_id = template.id AND existing.channel = 'email'
                 ), 0) + 1,
                 ?, ?, 'email', ?, ?, ?, 'draft', ?, unixepoch()
            FROM communication_templates template
            JOIN events event
              ON event.id = template.event_id AND event.organisation_id = ?
           WHERE template.id = ? AND template.event_id = ?
             AND template.status <> 'archived'
        RETURNING version_number AS versionNumber
      `,
      ).bind(
        versionId,
        parsed.name,
        parsed.category,
        parsed.subject,
        JSON.stringify(parsed.content),
        preview.html,
        viewer.personId,
        viewer.organisationId,
        templateId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, version.event_id, ?, 'communication.template.version.created',
                 'communication_template', version.template_id,
                 json_object(
                   'versionId', version.id,
                   'versionNumber', version.version_number,
                   'category', version.category
                 ),
                 unixepoch()
            FROM communication_template_versions version
           WHERE version.id = ? AND version.event_id = ? AND version.template_id = ?
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        versionId,
        viewer.eventId,
        templateId,
      ),
    ]);
    const allocated = results[1]?.results?.[0] as
      { versionNumber?: number } | undefined;
    const versionNumber = Number(allocated?.versionNumber);
    if (
      (results[1].meta.changes ?? 0) !== 1 ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1
    )
      throw new CommunicationNotFoundError(
        "The authorised event no longer exists.",
      );
    return { templateId, versionId, versionNumber };
  }

  async publishTemplate(viewer: Viewer, versionId: string) {
    const version = await this.getTemplateVersion(viewer, versionId);
    if (version.versionStatus === "published") return version;
    if (version.versionStatus !== "draft")
      throw new CommunicationStateError(
        "Only a draft template version can be published.",
      );
    const publishOperationId = crypto.randomUUID();
    const [claimed, , published] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE communication_templates
           SET status = 'active', last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ?
           AND EXISTS (
             SELECT 1 FROM communication_template_versions publish_version
              WHERE publish_version.id = ? AND publish_version.event_id = ?
                AND publish_version.template_id = communication_templates.id
                AND publish_version.channel = 'email' AND publish_version.status = 'draft'
           )
      `,
      ).bind(
        publishOperationId,
        version.templateId,
        viewer.eventId,
        versionId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        UPDATE communication_template_versions
           SET status = 'retired'
         WHERE event_id = ? AND template_id = ? AND channel = 'email' AND status = 'published'
           AND EXISTS (
             SELECT 1 FROM communication_templates
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        version.templateId,
        version.templateId,
        viewer.eventId,
        publishOperationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE communication_template_versions
           SET status = 'published', published_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM communication_templates
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        versionId,
        viewer.eventId,
        version.templateId,
        viewer.eventId,
        publishOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'communication.template.published', 'communication_template_version', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1
               FROM communication_templates publish_template
               JOIN communication_template_versions publish_version
                 ON publish_version.template_id = publish_template.id
                AND publish_version.event_id = publish_template.event_id
              WHERE publish_template.id = ? AND publish_template.event_id = ?
                AND publish_template.last_operation_id = ?
                AND publish_version.id = ? AND publish_version.status = 'published'
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        versionId,
        JSON.stringify({
          templateId: version.templateId,
          versionNumber: version.versionNumber,
        }),
        version.templateId,
        viewer.eventId,
        publishOperationId,
        versionId,
      ),
    ]);
    if (
      (claimed.meta.changes ?? 0) !== 1 ||
      (published.meta.changes ?? 0) !== 1
    ) {
      throw new CommunicationStateError(
        "The template changed before it could be published.",
      );
    }
    return { ...version, versionStatus: "published" as const };
  }

  async preview(
    viewer: Viewer,
    input: PreviewCommunicationInput,
  ): Promise<CommunicationPreview> {
    const parsed = previewCommunicationSchema.parse(input);
    const [template, event, sender] = await Promise.all([
      this.getTemplateVersion(viewer, parsed.templateVersionId),
      this.getEvent(viewer),
      this.getVerifiedSender(viewer),
    ]);
    assertMergeAudienceCompatible(template, parsed.audienceType);
    const recipients = await this.recipients.preview(viewer, {
      audienceType: parsed.audienceType,
      manualRecipients: parsed.manualRecipients,
      category: template.category,
      kind: parsed.kind,
    });
    const requiredSourceVariables = sourceVariables(template);
    if (
      requiredSourceVariables.length &&
      recipients.deliverable.some((recipient) => !recipient.sourceId)
    ) {
      throw new CommunicationStateError(
        "The selected audience contains a recipient without the source record required by this template.",
      );
    }
    const sourceSnapshots = await snapshotSourceValues(
      this.env,
      viewer.eventId,
      requiredSourceVariables,
      recipients.deliverable,
    );
    const representativeRecipient = recipients.deliverable[0];
    const values = {
      ...mergeValues(event, representativeRecipient),
      ...(representativeRecipient?.sourceId
        ? sourceSnapshots.get(representativeRecipient.sourceId)
        : {}),
    };
    const subject = renderMergeTemplate(template.subject, values);
    const body = renderMergeTemplate(template.content.body, values);
    const rendered = await renderProgramCueEmail({
      preview: subject,
      heading: subject,
      body,
      eventName: event.eventName,
      physicalAddress: template.content.physicalAddress,
      buttonText: template.content.buttonText,
      buttonUrl: template.content.buttonUrl,
    });
    const confirmation = {
      recipientFingerprint: await recipientFingerprint([
        ...recipients.deliverable,
        ...recipients.suppressed,
      ]),
      deliverableFingerprint: await recipientFingerprint(
        recipients.deliverable,
      ),
      suppressedCount: recipients.suppressed.length,
    };
    return {
      template,
      recipients,
      confirmation,
      rendered: { subject, ...rendered },
      provider: {
        configured: Boolean(this.env.RESEND_API_KEY?.trim() && sender),
        sender: sender ? `${sender.fromName} <${sender.fromEmail}>` : null,
        queueConfigured: Boolean(this.env.OPERATIONS_QUEUE),
      },
    };
  }

  async confirm(viewer: Viewer, input: ConfirmCommunicationInput) {
    const parsed = confirmCommunicationSchema.parse(input);
    const requestHash = await communicationRequestHash(parsed);
    const existing = await this.env.DB.prepare(
      `
      SELECT c.id, c.operation_id AS operationId, c.status,
             json_extract(c.audience_json, '$.requestHash') AS requestHash,
             operation.status AS operationStatus
        FROM communications c
        JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
        LEFT JOIN operation_jobs operation
          ON operation.id = c.operation_id AND operation.event_id = c.event_id
       WHERE c.event_id = ? AND c.idempotency_key = ?
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.idempotencyKey)
      .first<ExistingCommunication>();
    if (existing) return communicationReplay(existing, requestHash);

    const preview = await this.preview(viewer, parsed);
    if (
      preview.confirmation.recipientFingerprint !== parsed.recipientFingerprint
    ) {
      throw new CommunicationStateError(
        "The audience changed after it was previewed. Preview the recipients again before confirming.",
      );
    }
    if (
      preview.confirmation.deliverableFingerprint !==
        parsed.deliverableFingerprint &&
      preview.confirmation.suppressedCount <= parsed.suppressedCount
    ) {
      throw new CommunicationStateError(
        "The deliverable audience changed after it was previewed. Preview the recipients again before confirming.",
      );
    }
    if (preview.template.versionStatus !== "published")
      throw new CommunicationStateError(
        "Publish this template version before sending it.",
      );
    if (!preview.recipients.deliverable.length)
      throw new CommunicationStateError(
        "The audience contains no deliverable recipients.",
      );
    const sender = await this.getVerifiedSender(viewer);
    if (!sender)
      throw new CommunicationStateError(
        "A verified Resend sender profile is required before sending.",
      );
    if (!this.env.RESEND_API_KEY?.trim())
      throw new CommunicationStateError(
        "RESEND_API_KEY is required before sending.",
      );

    const communicationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const requiredSourceVariables = sourceVariables(preview.template);
    const sourceSnapshots = await snapshotSourceValues(
      this.env,
      viewer.eventId,
      requiredSourceVariables,
      preview.recipients.deliverable,
    );
    const deliveries = await Promise.all(
      preview.recipients.deliverable.map(async (recipient) => ({
        id: crypto.randomUUID(),
        personId: recipient.personId,
        address: recipient.address,
        name: recipient.name,
        sourceId: recipient.sourceId,
        sourceValues: recipient.sourceId
          ? (sourceSnapshots.get(recipient.sourceId) ?? {})
          : {},
        idempotencyKey: await communicationDeliveryIdempotencyKey(
          parsed.idempotencyKey,
          recipient.address,
        ),
      })),
    );
    const contentSnapshot = {
      schemaVersion: 1,
      category: preview.template.category,
      subjectTemplate: preview.template.subject,
      content: preview.template.content,
      event: await this.getEvent(viewer),
    };
    const audienceSnapshot = {
      type: parsed.audienceType,
      kind: parsed.kind,
      selected: preview.recipients.selected,
      invalid: preview.recipients.invalid.length,
      suppressed: preview.recipients.suppressed.length,
      requestHash,
    };
    const queueMessage = {
      type: "communication.send",
      operationId,
      communicationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: parsed.idempotencyKey,
    };
    const deliveriesJson = JSON.stringify(deliveries);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id, idempotency_key,
          kind, channel, status, audience_json, content_snapshot_json, recipient_count,
          queued_at, created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, ?, ?, 'email', 'queued', ?, ?, ?, unixepoch(), ?, unixepoch(), unixepoch()
            FROM events e
           WHERE e.id = ? AND e.organisation_id = ?
      `,
      ).bind(
        communicationId,
        preview.template.id,
        sender.id,
        operationId,
        parsed.idempotencyKey,
        parsed.kind,
        JSON.stringify(audienceSnapshot),
        JSON.stringify(contentSnapshot),
        deliveries.length,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address, recipient_name,
          source_id, source_values_json, channel, provider, idempotency_key, status, created_at, updated_at
        )
        SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.personId'),
               json_extract(value, '$.address'), json_extract(value, '$.name'),
               json_extract(value, '$.sourceId'), json_extract(value, '$.sourceValues'),
               'email', 'resend', json_extract(value, '$.idempotencyKey'), 'queued', unixepoch(), unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        viewer.eventId,
        communicationId,
        deliveriesJson,
        communicationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, ?, 0, 0, 1, unixepoch(), unixepoch()
           WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        correlationId,
        JSON.stringify(queueMessage),
        deliveries.length,
        communicationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_items (id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at)
        SELECT lower(hex(randomblob(16))), ?, json_extract(value, '$.idempotencyKey'),
               'communication_delivery', json_extract(value, '$.id'), 'pending',
               json_object('sourceId', json_extract(value, '$.sourceId')), unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(operationId, deliveriesJson, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'communication.queued', 'communication', ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM communications WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        communicationId,
        JSON.stringify({
          operationId,
          recipientCount: deliveries.length,
          category: preview.template.category,
        }),
        communicationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
        SELECT ?, 'communication', ?, 'created', ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ?)
      `,
      ).bind(viewer.eventId, communicationId, correlationId, communicationId),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      const race = await this.env.DB.prepare(
        `
        SELECT communication.id, communication.operation_id AS operationId,
               communication.status,
               json_extract(communication.audience_json, '$.requestHash') AS requestHash,
               operation.status AS operationStatus
          FROM communications communication
          LEFT JOIN operation_jobs operation
            ON operation.id = communication.operation_id
           AND operation.event_id = communication.event_id
         WHERE communication.event_id = ? AND communication.idempotency_key = ?
      `,
      )
        .bind(viewer.eventId, parsed.idempotencyKey)
        .first<ExistingCommunication>();
      if (race) return communicationReplay(race, requestHash);
      throw new CommunicationStateError(
        "The communication could not be recorded in the authorised event.",
      );
    }

    try {
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(queueMessage);
    } catch (error) {
      console.error("Communication Queue dispatch failed", {
        operationId,
        cause: error instanceof Error ? error.message : String(error),
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'queued'",
        ).bind(
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000),
          operationId,
        ),
        this.env.DB.prepare(
          "UPDATE communications SET status = 'failed', updated_at = unixepoch() WHERE id = ? AND status = 'queued'",
        ).bind(communicationId),
      ]);
      throw new CommunicationQueueUnavailableError(operationId, error);
    }
    return {
      communicationId,
      operationId,
      status: "queued",
      operationStatus: "queued",
      duplicate: false as const,
    };
  }

  async cancel(viewer: Viewer, communicationId: string) {
    // This status claim competes atomically with the worker's queued -> sending
    // claim; only the winner may update the linked deliveries and operation.
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE communications
           SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('draft','scheduled','queued','failed')
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)
           AND (
             operation_id IS NULL
             OR EXISTS (
               SELECT 1 FROM operation_jobs cancellable_operation
                WHERE cancellable_operation.id = communications.operation_id
                  AND cancellable_operation.event_id = communications.event_id
                  AND cancellable_operation.status IN (
                    'queued','queue_failed','received','retrying','failed','partially_failed'
                  )
             )
           )
      `,
      ).bind(
        communicationId,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE communication_deliveries
           SET status = 'cancelled', updated_at = unixepoch()
         WHERE communication_id = ? AND event_id = ? AND status IN ('queued','failed')
           AND EXISTS (
             SELECT 1 FROM communications cancelled_communication
              WHERE cancelled_communication.id = communication_deliveries.communication_id
                AND cancelled_communication.event_id = communication_deliveries.event_id
                AND cancelled_communication.status = 'cancelled'
           )
      `,
      ).bind(communicationId, viewer.eventId),
      this.env.DB.prepare(
        `
        UPDATE operation_items
           SET status = 'skipped', error_code = 'COMMUNICATION_CANCELLED',
               error_message = 'The communication was cancelled before delivery.',
               completed_at = unixepoch(), updated_at = unixepoch()
         WHERE operation_id = (
           SELECT operation_id FROM communications
            WHERE id = ? AND event_id = ? AND status = 'cancelled'
         )
           AND status IN ('pending','failed')
      `,
      ).bind(communicationId, viewer.eventId),
      this.env.DB.prepare(
        `
        UPDATE operation_jobs
           SET status = 'cancelled', last_error = NULL,
               completed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = (
           SELECT operation_id FROM communications
            WHERE id = ? AND event_id = ? AND status = 'cancelled'
         )
           AND event_id = ?
           AND status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
      `,
      ).bind(communicationId, viewer.eventId, viewer.eventId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at)
        SELECT ?, ?, ?, ?, 'communication.cancelled', 'communication', ?, '{}', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communications cancelled_communication
            WHERE cancelled_communication.id = ? AND cancelled_communication.event_id = ?
              AND cancelled_communication.status = 'cancelled'
         )
           AND NOT EXISTS (
             SELECT 1 FROM audit_events cancellation_audit
              WHERE cancellation_audit.event_id = ?
                AND cancellation_audit.action = 'communication.cancelled'
                AND cancellation_audit.entity_type = 'communication'
                AND cancellation_audit.entity_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        communicationId,
        communicationId,
        viewer.eventId,
        viewer.eventId,
        communicationId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new CommunicationStateError(
        "Only an unsent communication can be cancelled.",
      );
    }
  }

  async reconcileResendEvent(
    input: unknown,
    rawPayload: string,
    providerEventId: string,
  ) {
    const event = resendWebhookEventSchema.parse(input);
    const delivery = await this.env.DB.prepare(
      `
      SELECT d.id, d.event_id AS eventId, d.communication_id AS communicationId,
             d.person_id AS personId, lower(d.recipient_address) AS address,
             e.organisation_id AS organisationId
        FROM communication_deliveries d
        JOIN events e ON e.id = d.event_id
       WHERE d.provider = 'resend' AND d.provider_message_id = ?
    `,
    )
      .bind(event.data.email_id)
      .first<{
        id: string;
        eventId: string;
        communicationId: string;
        personId: string | null;
        address: string;
        organisationId: string;
      }>();
    if (!delivery) return { matched: false, duplicate: false };
    const occurredAt = event.created_at
      ? Math.floor(Date.parse(event.created_at) / 1_000)
      : Math.floor(Date.now() / 1_000);
    const inserted = await this.env.DB.prepare(
      `
      INSERT OR IGNORE INTO communication_delivery_events (
        id, delivery_id, provider_event_id, event_type, payload_json, occurred_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `,
    )
      .bind(
        crypto.randomUUID(),
        delivery.id,
        providerEventId,
        event.type,
        rawPayload,
        occurredAt,
      )
      .run();
    const duplicate = (inserted.meta.changes ?? 0) !== 1;
    if (
      event.type === "email.complained" ||
      event.type === "email.suppressed"
    ) {
      await this.env.DB.prepare(
        `
        INSERT INTO communication_unsubscribes (
          id, event_id, person_id, address, category, reason, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, '*', ?, unixepoch(), NULL)
        ON CONFLICT(event_id, address, category) DO UPDATE SET
          person_id = COALESCE(excluded.person_id, communication_unsubscribes.person_id),
          reason = excluded.reason, revoked_at = NULL
      `,
      )
        .bind(
          crypto.randomUUID(),
          delivery.eventId,
          delivery.personId,
          delivery.address,
          event.type,
        )
        .run();
    }
    if (Object.hasOwn(resendDeliveryEventStates, event.type)) {
      await this.env.DB.prepare(
        `
        WITH event_states AS (
          SELECT json_extract(value, '$.eventType') AS event_type,
                 json_extract(value, '$.status') AS status,
                 json_extract(value, '$.precedenceRank') AS precedence_rank,
                 json_extract(value, '$.statusRank') AS status_rank
            FROM json_each(?)
        ),
        derived AS (
          SELECT delivery_event.event_type, event_state.status,
                 event_state.precedence_rank, event_state.status_rank
            FROM communication_delivery_events delivery_event
            JOIN event_states event_state ON event_state.event_type = delivery_event.event_type
           WHERE delivery_event.delivery_id = ?
           ORDER BY event_state.precedence_rank DESC,
                    CASE WHEN event_state.precedence_rank = 2 THEN delivery_event.occurred_at END DESC,
                    CASE WHEN event_state.precedence_rank = 1 THEN event_state.status_rank END DESC,
                    CASE WHEN event_state.precedence_rank = 2 THEN event_state.status_rank END DESC,
                    delivery_event.occurred_at DESC,
                    delivery_event.event_type DESC,
                    COALESCE(delivery_event.provider_event_id, '') DESC,
                    delivery_event.id DESC
           LIMIT 1
        )
        UPDATE communication_deliveries
           SET status = (SELECT status FROM derived),
               failure_code = CASE
                 WHEN (SELECT precedence_rank FROM derived) = 2
                   THEN (SELECT event_type FROM derived)
                 ELSE failure_code
               END,
               updated_at = unixepoch()
         WHERE id = ? AND EXISTS (SELECT 1 FROM derived)
      `,
      )
        .bind(resendDeliveryEventStatesJson, delivery.id, delivery.id)
        .run();
      await this.refreshCommunicationStatus(delivery.communicationId);
    }
    if (!duplicate) {
      await new EventRealtimeService(this.env).recordChange(
        {
          organisationId: delivery.organisationId,
          eventId: delivery.eventId,
        },
        {
          entityType: "communication_delivery",
          entityId: delivery.id,
          changeType: "progress",
          correlationId: providerEventId,
        },
      );
    }
    return { matched: true, duplicate };
  }

  private async refreshCommunicationStatus(communicationId: string) {
    const counts = await this.env.DB.prepare(
      `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status IN ('bounced','suppressed','failed') THEN 1 ELSE 0 END) AS failed
        FROM communication_deliveries WHERE communication_id = ?
    `,
    )
      .bind(communicationId)
      .first<{ total: number; succeeded: number; failed: number }>();
    if (!counts?.total) return;
    const terminal = counts.succeeded + counts.failed;
    if (terminal < counts.total) return;
    const status =
      counts.failed === 0
        ? "sent"
        : counts.succeeded
          ? "partially_failed"
          : "failed";
    await this.env.DB.prepare(
      `
      UPDATE communications SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END,
        updated_at = unixepoch() WHERE id = ?
    `,
    )
      .bind(status, status, communicationId)
      .run();
  }

  private async getTemplateVersion(
    viewer: Viewer,
    versionId: string,
  ): Promise<CommunicationTemplateVersion> {
    const row = await this.env.DB.prepare(
      `
      SELECT tv.id, tv.template_id AS templateId, tv.name, tv.category,
             t.status AS templateStatus, tv.version_number AS versionNumber,
             tv.subject_template AS subject, tv.content_json AS contentJson,
             tv.status AS versionStatus, tv.published_at AS publishedAt
        FROM communication_template_versions tv
        JOIN communication_templates t ON t.id = tv.template_id AND t.event_id = tv.event_id
        JOIN events e ON e.id = tv.event_id AND e.organisation_id = ?
       WHERE tv.id = ? AND tv.event_id = ? AND t.status <> 'archived'
    `,
    )
      .bind(viewer.organisationId, versionId, viewer.eventId)
      .first<TemplateVersionRow>();
    if (!row) throw new CommunicationNotFoundError();
    return {
      ...row,
      subject: parseEmailSubject(row),
      content: parseContent(row),
      contentJson: undefined,
    } as CommunicationTemplateVersion;
  }

  private async getEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `
      SELECT e.name AS eventName, e.starts_at AS startsAt, e.ends_at AS endsAt
        FROM events e WHERE e.id = ? AND e.organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventMergeRow>();
    if (!event)
      throw new CommunicationNotFoundError(
        "The event was not found in the authorised organisation.",
      );
    return event;
  }

  private async getVerifiedSender(viewer: Viewer) {
    return this.env.DB.prepare(
      `
      SELECT sp.id, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail
        FROM sender_profiles sp
        JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
       WHERE sp.event_id = ? AND sp.status = 'verified' AND sp.provider = 'resend'
       ORDER BY sp.updated_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<SenderRow>();
  }
}

export function communicationErrorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Communication input is invalid.";
  return error instanceof Error
    ? error.message
    : "Communication operation failed.";
}

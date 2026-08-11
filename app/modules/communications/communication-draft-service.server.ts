import type { Viewer } from "~/platform/auth/authorize.server";
import {
  communicationDraftFieldsSchema,
  confirmCommunicationDraftSchema,
  discardCommunicationDraftSchema,
  updateCommunicationDraftSchema,
  type CommunicationDraftFields,
  type ConfirmCommunicationDraftInput,
  type DiscardCommunicationDraftInput,
  type UpdateCommunicationDraftInput,
} from "./communication-schema";
import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import {
  CommunicationNotFoundError,
  CommunicationStateError,
} from "./communication-service-shared";

type DraftRow = {
  id: string;
  revision: number;
  templateVersionId: string | null;
  idempotencyKey: string;
  kind: "transactional" | "optional";
  audienceJson: string;
  createdAt: number;
  updatedAt: number;
};

export type CommunicationDraft = CommunicationDraftFields & {
  id: string;
  revision: number;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
};

function invalidDraftConfiguration(row: DraftRow) {
  return new CommunicationStateError(
    `Communication draft ${row.id} contains invalid configuration data.`,
  );
}

function parseDraft(row: DraftRow): CommunicationDraft {
  let audience: unknown;
  try {
    audience = JSON.parse(row.audienceJson);
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidDraftConfiguration(row);
    throw error;
  }
  const parsed = communicationDraftFieldsSchema.safeParse({
    ...(typeof audience === "object" && audience ? audience : {}),
    templateVersionId: row.templateVersionId,
    kind: row.kind,
  });
  if (!parsed.success) throw invalidDraftConfiguration(row);
  return {
    id: row.id,
    revision: row.revision,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...parsed.data,
  };
}

export class CommunicationDraftService {
  private readonly delivery: CommunicationDeliveryService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.delivery = new CommunicationDeliveryService(env);
  }

  async create(viewer: Viewer, input: CommunicationDraftFields) {
    const fields = communicationDraftFieldsSchema.parse(input);
    await this.assertPublishedTemplate(viewer, fields.templateVersionId);
    const id = crypto.randomUUID();
    const idempotencyKey = `communication:draft:${id}`;
    const result = await this.env.DB.prepare(
      `INSERT INTO communications (
         id, event_id, template_version_id, idempotency_key, kind, channel,
         status, revision, audience_json, content_snapshot_json,
         recipient_count, scheduled_at, created_by_person_id, created_at, updated_at
       )
       SELECT ?, event.id, version.id, ?, ?, 'email', 'draft', 1, ?, ?, 0, ?, ?,
              unixepoch(), unixepoch()
         FROM events event
         JOIN communication_template_versions version
           ON version.event_id = event.id AND version.id = ?
          AND version.status = 'published'
        WHERE event.id = ? AND event.organisation_id = ?`,
    )
      .bind(
        id,
        idempotencyKey,
        fields.kind,
        JSON.stringify({
          schemaVersion: 1,
          type: fields.audienceType,
          audienceType: fields.audienceType,
          manualRecipients: fields.manualRecipients,
          scheduledAt: fields.scheduledAt,
        }),
        JSON.stringify({ schemaVersion: 1, draft: true }),
        fields.scheduledAt,
        viewer.personId,
        fields.templateVersionId,
        viewer.eventId,
        viewer.organisationId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new CommunicationStateError(
        "The communication draft could not be created in the authorised event.",
      );
    }
    return this.get(viewer, id);
  }

  async get(viewer: Viewer, draftId: string) {
    const row = await this.env.DB.prepare(
      `SELECT communication.id, communication.revision,
              communication.template_version_id AS templateVersionId,
              communication.idempotency_key AS idempotencyKey,
              communication.kind, communication.audience_json AS audienceJson,
              communication.created_at AS createdAt,
              communication.updated_at AS updatedAt
         FROM communications communication
         JOIN events event
           ON event.id = communication.event_id AND event.organisation_id = ?
        WHERE communication.id = ? AND communication.event_id = ?
          AND communication.status = 'draft'`,
    )
      .bind(viewer.organisationId, draftId, viewer.eventId)
      .first<DraftRow>();
    if (!row) {
      throw new CommunicationNotFoundError(
        "The communication draft was not found in this event.",
      );
    }
    return parseDraft(row);
  }

  async update(viewer: Viewer, input: UpdateCommunicationDraftInput) {
    const parsed = updateCommunicationDraftSchema.parse(input);
    await this.assertPublishedTemplate(viewer, parsed.templateVersionId);
    const result = await this.env.DB.prepare(
      `UPDATE communications
          SET template_version_id = ?, kind = ?, audience_json = ?,
              content_snapshot_json = ?, scheduled_at = ?,
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
          AND EXISTS (
            SELECT 1 FROM events
             WHERE id = communications.event_id AND organisation_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM communication_template_versions version
             WHERE version.id = ?
               AND version.event_id = communications.event_id
               AND version.status = 'published'
          )`,
    )
      .bind(
        parsed.templateVersionId,
        parsed.kind,
        JSON.stringify({
          schemaVersion: 1,
          type: parsed.audienceType,
          audienceType: parsed.audienceType,
          manualRecipients: parsed.manualRecipients,
          scheduledAt: parsed.scheduledAt,
        }),
        JSON.stringify({ schemaVersion: 1, draft: true }),
        parsed.scheduledAt,
        parsed.draftId,
        viewer.eventId,
        parsed.revision,
        viewer.organisationId,
        parsed.templateVersionId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new CommunicationStateError(
        "This communication draft changed after the page loaded. Reload before saving again.",
      );
    }
    return this.get(viewer, parsed.draftId);
  }

  async preview(viewer: Viewer, draftId: string) {
    const draft = await this.get(viewer, draftId);
    const preview = await this.delivery.preview(viewer, draft);
    return { draft, preview };
  }

  async confirm(viewer: Viewer, input: ConfirmCommunicationDraftInput) {
    const parsed = confirmCommunicationDraftSchema.parse(input);
    let draft: CommunicationDraft;
    try {
      draft = await this.get(viewer, parsed.draftId);
    } catch (error) {
      if (error instanceof CommunicationNotFoundError) {
        return this.delivery.replayDraftConfirmation(viewer, {
          draftId: parsed.draftId,
          draftRevision: parsed.revision,
          recipientFingerprint: parsed.recipientFingerprint,
          deliverableFingerprint: parsed.deliverableFingerprint,
          suppressedCount: parsed.suppressedCount,
        });
      }
      throw error;
    }
    if (draft.revision !== parsed.revision) {
      throw new CommunicationStateError(
        "This communication draft changed after it was previewed. Preview it again before confirming.",
      );
    }
    return this.delivery.confirmDraft(viewer, {
      draftId: draft.id,
      draftRevision: draft.revision,
      templateVersionId: draft.templateVersionId,
      audienceType: draft.audienceType,
      manualRecipients: draft.manualRecipients,
      kind: draft.kind,
      scheduledAt: draft.scheduledAt,
      idempotencyKey: draft.idempotencyKey,
      recipientFingerprint: parsed.recipientFingerprint,
      deliverableFingerprint: parsed.deliverableFingerprint,
      suppressedCount: parsed.suppressedCount,
    });
  }

  async discard(viewer: Viewer, input: DiscardCommunicationDraftInput) {
    const parsed = discardCommunicationDraftSchema.parse(input);
    const result = await this.env.DB.prepare(
      `UPDATE communications
          SET status = 'cancelled', cancelled_at = unixepoch(),
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
          AND EXISTS (
            SELECT 1 FROM events
             WHERE id = communications.event_id AND organisation_id = ?
          )`,
    )
      .bind(
        parsed.draftId,
        viewer.eventId,
        parsed.revision,
        viewer.organisationId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new CommunicationStateError(
        "This communication draft changed after the page loaded. Reload before discarding it.",
      );
    }
  }

  private async assertPublishedTemplate(viewer: Viewer, versionId: string) {
    const template = await this.env.DB.prepare(
      `SELECT version.id
         FROM communication_template_versions version
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND version.status = 'published'`,
    )
      .bind(viewer.organisationId, versionId, viewer.eventId)
      .first();
    if (!template) {
      throw new CommunicationStateError(
        "Choose a published template version from this event.",
      );
    }
  }
}

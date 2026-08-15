import type { Viewer } from "~/platform/auth/authorize.server";
import {
  saveTemplateSchema,
  type SaveTemplateInput,
} from "./communication-schema";
import { renderProgramCueEmail } from "./email-templates/render-email.server";
import { renderMergeTemplate } from "./merge-template";
import {
  emailProviderConfigurationIssue,
  requireEmailProviderConfiguration,
} from "./email-provider.server";
import {
  CommunicationNotFoundError,
  CommunicationStateError,
  eventEmailLogoUrl,
  mergeValues,
  parseContent,
  parseEmailSubject,
  type CommunicationTemplateVersion,
  type EventMergeRow,
  type SenderRow,
  type TemplateVersionRow,
} from "./communication-service-shared";

const DELIVERY_PAGE_SIZE = 50;
const DELIVERY_HEALTH_DEFAULT_DAYS = 90;
const DELIVERY_HEALTH_DEFAULT_SECONDS =
  DELIVERY_HEALTH_DEFAULT_DAYS * 24 * 60 * 60;

type DeliveryHealthPeriod = "recent" | "lifetime";

export class CommunicationTemplateService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async listDeliveryHealth(
    viewer: Viewer,
    options: {
      communicationId?: string;
      offset?: number;
      period?: DeliveryHealthPeriod;
    } = {},
  ) {
    const communicationId = options.communicationId?.trim() ?? "";
    const offset = options.offset ?? 0;
    const period = options.period ?? "recent";
    if (communicationId.length > 200) {
      throw new Response("Communication selection is invalid.", {
        status: 400,
      });
    }
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % DELIVERY_PAGE_SIZE !== 0
    ) {
      throw new Response("Delivery page is invalid.", { status: 400 });
    }
    if (!communicationId && offset !== 0) {
      throw new Response(
        "Choose a communication before paging through its deliveries.",
        { status: 400 },
      );
    }
    if (period !== "recent" && period !== "lifetime") {
      throw new Response("Delivery health period is invalid.", { status: 400 });
    }
    const recentCutoff =
      Math.floor(Date.now() / 1_000) - DELIVERY_HEALTH_DEFAULT_SECONDS;
    const selectedCommunication = communicationId
      ? await this.env.DB.prepare(
          `SELECT communication.id, communication.status,
                  communication.operation_id AS operationId,
                  communication.recipient_count AS recipientCount,
                  communication.created_at AS createdAt
             FROM communications communication
             JOIN events event
               ON event.id = communication.event_id
              AND event.organisation_id = ?
            WHERE communication.id = ? AND communication.event_id = ?`,
        )
          .bind(viewer.organisationId, communicationId, viewer.eventId)
          .first<{
            id: string;
            status: string;
            operationId: string | null;
            recipientCount: number;
            createdAt: number;
          }>()
      : null;
    if (communicationId && !selectedCommunication) {
      throw new Response("Communication not found in this event.", {
        status: 404,
      });
    }
    if (
      selectedCommunication &&
      offset > 0 &&
      offset >= selectedCommunication.recipientCount
    ) {
      throw new Response("Delivery page not found.", { status: 404 });
    }
    const [
      summary,
      recentProblems,
      recipientSuppressions,
      providerSuppressions,
      deliveryPage,
    ] = await Promise.all([
      (selectedCommunication
        ? this.env.DB.prepare(
            `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN delivery.status IN ('queued','sending') THEN 1 ELSE 0 END), 0) AS pending,
                  COALESCE(SUM(CASE WHEN delivery.status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
                  COALESCE(SUM(CASE WHEN delivery.status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END), 0) AS delivered,
                  COALESCE(SUM(CASE WHEN delivery.status IN ('bounced','suppressed','failed') THEN 1 ELSE 0 END), 0) AS problems,
                  COALESCE(SUM(CASE WHEN delivery.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
              FROM communication_deliveries delivery
              JOIN events event
                ON event.id = delivery.event_id
               AND event.organisation_id = ?
             WHERE delivery.event_id = ? AND delivery.communication_id = ?`,
          ).bind(
            viewer.organisationId,
            viewer.eventId,
            selectedCommunication.id,
          )
        : this.env.DB.prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN delivery.status IN ('queued','sending') THEN 1 ELSE 0 END), 0) AS pending,
                    COALESCE(SUM(CASE WHEN delivery.status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
                    COALESCE(SUM(CASE WHEN delivery.status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END), 0) AS delivered,
                    COALESCE(SUM(CASE WHEN delivery.status IN ('bounced','suppressed','failed') THEN 1 ELSE 0 END), 0) AS problems,
                    COALESCE(SUM(CASE WHEN delivery.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
               FROM communication_deliveries delivery
               JOIN events event
                 ON event.id = delivery.event_id
                AND event.organisation_id = ?
              WHERE delivery.event_id = ?
                ${period === "recent" ? "AND delivery.created_at >= ?" : ""}`,
          ).bind(
            viewer.organisationId,
            viewer.eventId,
            ...(period === "recent" ? [recentCutoff] : []),
          )
      ).first<{
        total: number;
        pending: number;
        sent: number;
        delivered: number;
        problems: number;
        cancelled: number;
      }>(),
      this.env.DB.prepare(
        `SELECT delivery.id, delivery.communication_id AS communicationId,
                  delivery.recipient_address AS recipientAddress,
                  delivery.recipient_name AS recipientName,
                  delivery.status, delivery.failure_code AS failureCode,
                  delivery.failure_message AS failureMessage,
                  delivery.updated_at AS updatedAt,
                  communication.operation_id AS operationId
             FROM communication_deliveries delivery
             JOIN communications communication
               ON communication.id = delivery.communication_id
              AND communication.event_id = delivery.event_id
             JOIN events event
               ON event.id = delivery.event_id
              AND event.organisation_id = ?
            WHERE delivery.event_id = ?
              AND delivery.status IN ('bounced','suppressed','failed')
              ${selectedCommunication ? "AND communication.id = ?" : ""}
              ${!selectedCommunication && period === "recent" ? "AND delivery.created_at >= ?" : ""}
            ORDER BY delivery.updated_at DESC, delivery.id DESC
            LIMIT 30`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          ...(selectedCommunication ? [selectedCommunication.id] : []),
          ...(!selectedCommunication && period === "recent"
            ? [recentCutoff]
            : []),
        )
        .all<{
          id: string;
          communicationId: string;
          recipientAddress: string;
          recipientName: string | null;
          status: string;
          failureCode: string | null;
          failureMessage: string | null;
          updatedAt: number;
          operationId: string | null;
        }>(),
      this.env.DB.prepare(
        `SELECT unsubscribe.id, unsubscribe.address, unsubscribe.category,
                  unsubscribe.reason, unsubscribe.created_at AS createdAt
             FROM communication_unsubscribes unsubscribe
             JOIN events event
               ON event.id = unsubscribe.event_id
              AND event.organisation_id = ?
            WHERE unsubscribe.event_id = ? AND unsubscribe.revoked_at IS NULL
              AND unsubscribe.reason = 'recipient_unsubscribe'
            ORDER BY unsubscribe.created_at DESC, unsubscribe.id DESC
            LIMIT 30`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          id: string;
          address: string;
          category: string;
          reason: string | null;
          createdAt: number;
        }>(),
      this.env.DB.prepare(
        `SELECT unsubscribe.id, unsubscribe.address, unsubscribe.category,
                  unsubscribe.reason, unsubscribe.created_at AS createdAt
             FROM communication_unsubscribes unsubscribe
             JOIN events event
               ON event.id = unsubscribe.event_id
              AND event.organisation_id = ?
            WHERE unsubscribe.event_id = ? AND unsubscribe.revoked_at IS NULL
              AND unsubscribe.reason IN ('email.complained','email.suppressed')
            ORDER BY unsubscribe.created_at DESC, unsubscribe.id DESC
            LIMIT 30`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          id: string;
          address: string;
          category: string;
          reason: string | null;
          createdAt: number;
        }>(),
      selectedCommunication
        ? this.env.DB.prepare(
            `SELECT delivery.id,
                      delivery.recipient_address AS recipientAddress,
                      delivery.recipient_name AS recipientName,
                      delivery.status, delivery.failure_code AS failureCode,
                      delivery.failure_message AS failureMessage,
                      delivery.attempt_count AS attemptCount,
                      delivery.updated_at AS updatedAt
                 FROM communication_deliveries delivery
                 JOIN communications communication
                   ON communication.id = delivery.communication_id
                  AND communication.event_id = delivery.event_id
                 JOIN events event
                   ON event.id = delivery.event_id
                  AND event.organisation_id = ?
                WHERE delivery.event_id = ? AND delivery.communication_id = ?
                ORDER BY delivery.created_at, delivery.id
                LIMIT ? OFFSET ?`,
          )
            .bind(
              viewer.organisationId,
              viewer.eventId,
              selectedCommunication.id,
              DELIVERY_PAGE_SIZE + 1,
              offset,
            )
            .all<{
              id: string;
              recipientAddress: string;
              recipientName: string | null;
              status: string;
              failureCode: string | null;
              failureMessage: string | null;
              attemptCount: number;
              updatedAt: number;
            }>()
        : Promise.resolve({ results: [] }),
    ]);
    if (!summary) {
      throw new Error("The delivery health aggregate query returned no row.");
    }
    const pageRows = deliveryPage.results;
    return {
      scope: selectedCommunication
        ? ({
            kind: "communication",
            communication: selectedCommunication,
          } as const)
        : ({
            kind: "event",
            period,
            days: period === "recent" ? DELIVERY_HEALTH_DEFAULT_DAYS : null,
          } as const),
      summary,
      recentProblems: recentProblems.results,
      suppressions: {
        recipient: recipientSuppressions.results,
        provider: providerSuppressions.results,
      },
      deliveryPage: {
        rows: pageRows.slice(0, DELIVERY_PAGE_SIZE),
        offset,
        hasPrevious: offset > 0,
        hasNext: pageRows.length > DELIVERY_PAGE_SIZE,
      },
    };
  }

  async listCentre(viewer: Viewer, options: { filter?: "failed" } = {}) {
    const statusFilter = options.filter === "failed" ? "failed" : "";
    const providerIssue = emailProviderConfigurationIssue(this.env);
    const providerName = providerIssue
      ? null
      : requireEmailProviderConfiguration(this.env).provider;
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
               c.scheduled_at AS scheduledAt,
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
          scheduledAt: number | null;
          failedCount: number;
          sentCount: number;
        }>(),
      this.getVerifiedSender(viewer, providerName),
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
        name: providerName,
        configured: Boolean(!providerIssue && sender),
        sender: sender ? `${sender.fromName} <${sender.fromEmail}>` : null,
        queueConfigured: Boolean(this.env.OPERATIONS_QUEUE),
      },
    };
  }

  async saveTemplate(
    viewer: Viewer,
    input: SaveTemplateInput,
    operation?: {
      operationId: string;
      templateId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    const parsed = saveTemplateSchema.parse(input);
    const recover = operation
      ? () =>
          this.env.DB.prepare(
            `SELECT template.id AS templateId, version.id AS versionId,
                    version.version_number AS versionNumber
               FROM communication_templates template
               JOIN events event
                 ON event.id = template.event_id AND event.organisation_id = ?
               JOIN communication_template_versions version
                 ON version.template_id = template.id
                AND version.event_id = template.event_id
              WHERE template.id = ? AND template.event_id = ?
                AND template.last_operation_id = ? AND version.id = ?`,
          )
            .bind(
              viewer.organisationId,
              operation.templateId,
              viewer.eventId,
              operation.operationId,
              operation.versionId,
            )
            .first<{
              templateId: string;
              versionId: string;
              versionNumber: number;
            }>()
      : null;
    const replay = await recover?.();
    if (replay) return replay;
    const templateId =
      parsed.templateId ?? operation?.templateId ?? crypto.randomUUID();
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
    const versionId = operation?.versionId ?? crypto.randomUUID();
    const saveOperationId = operation?.operationId ?? crypto.randomUUID();
    const values = mergeValues(event);
    const subject = renderMergeTemplate(parsed.subject, values);
    const body = renderMergeTemplate(parsed.content.body, values);
    const preview = await renderProgramCueEmail({
      preview: subject,
      heading: subject,
      body,
      eventName: event.eventName,
      accent: event.brandAccent,
      logoUrl: eventEmailLogoUrl(this.env, event),
      physicalAddress: parsed.content.physicalAddress,
      buttonText: parsed.content.buttonText,
      buttonUrl: parsed.content.buttonUrl,
    });
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `
        INSERT INTO communication_templates (
          id, event_id, name, category, status, last_operation_id,
          created_by_person_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, unixepoch(), unixepoch())
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category,
          last_operation_id = excluded.last_operation_id, updated_at = unixepoch()
        WHERE communication_templates.event_id = excluded.event_id
      `,
        ).bind(
          templateId,
          viewer.eventId,
          parsed.name,
          parsed.category,
          saveOperationId,
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
          operation?.auditId ?? crypto.randomUUID(),
          viewer.organisationId,
          viewer.personId,
          versionId,
          viewer.eventId,
          templateId,
        ),
      ]);
    } catch (error) {
      const recovered = await recover?.();
      if (recovered) return recovered;
      throw error;
    }
    const allocated = results[1]?.results?.[0] as
      { versionNumber?: number } | undefined;
    const versionNumber = Number(allocated?.versionNumber);
    if (
      (results[1].meta.changes ?? 0) !== 1 ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1
    ) {
      const recovered = await recover?.();
      if (recovered) return recovered;
      throw new CommunicationNotFoundError(
        "The authorised event no longer exists.",
      );
    }
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
  async getTemplateVersion(
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
      SELECT e.name AS eventName, e.brand_accent AS brandAccent,
             CASE WHEN e.brand_logo_asset_id IS NOT NULL
               THEN '/public/brand/' || e.slug || '/logo'
               ELSE e.participant_logo_url
             END AS logoUrl,
             e.starts_at AS startsAt, e.ends_at AS endsAt
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

  private async getVerifiedSender(
    viewer: Viewer,
    provider: "resend" | "mailpit" | null,
  ) {
    if (!provider) return null;
    return this.env.DB.prepare(
      `
      SELECT sp.id, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail
        FROM sender_profiles sp
        JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
       WHERE sp.event_id = ? AND sp.status = 'verified' AND sp.provider = ?
       ORDER BY sp.updated_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, provider)
      .first<SenderRow>();
  }
}

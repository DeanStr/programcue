import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  parseResourceDocument,
  type TiptapNode,
  validateResourceDocumentEmbedStructure,
} from "./resource-content";
import { resourceEmbedConfiguration } from "./resource-embed-policy";
import { ResourceServiceBase } from "./resource-service-base.server";
import {
  participantAudienceSql,
  participantSpeakerAccessSql,
  ResourceInvariantError,
  ResourceRevisionConflictError,
} from "./resource-service-shared";

const participantResourceAudienceSql = participantAudienceSql(
  "participant.person_id",
  "rv",
  participantSpeakerAccessSql("participant.person_id", "participant.role"),
);

export class ResourceParticipantService extends ResourceServiceBase {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    super(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async getParticipantWorkspace(viewer: Viewer, selectedSlug?: string | null) {
    await this.airtable.assertReadable(viewer);
    const pages = await this.env.DB.prepare(
      `
      SELECT rp.id, rv.title, rv.slug, rv.category, rv.acknowledgement_required AS acknowledgementRequired,
             rv.id AS versionId, rv.version_number AS versionNumber,
             rv.published_at AS publishedAt,
             CASE WHEN ack.id IS NULL THEN 0 ELSE 1 END AS acknowledged
        FROM resource_pages rp
        CROSS JOIN (SELECT ? AS person_id, ? AS role) participant
        JOIN resource_page_versions rv ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id AND rv.status = 'published'
        LEFT JOIN resource_acknowledgements ack ON ack.resource_page_version_id = rv.id AND ack.person_id = participant.person_id
       WHERE rp.event_id = ? AND rp.status = 'published' AND ${participantResourceAudienceSql}
       ORDER BY rv.category, rv.title
    `,
    )
      .bind(viewer.personId, viewer.role, viewer.eventId)
      .all<{
        id: string;
        title: string;
        slug: string;
        category: string | null;
        acknowledgementRequired: number;
        versionId: string;
        versionNumber: number;
        publishedAt: number;
        acknowledged: number;
      }>();
    const requestedPage = selectedSlug !== null && selectedSlug !== undefined;
    const selected = requestedPage
      ? (pages.results.find((page) => page.slug === selectedSlug) ?? null)
      : (pages.results[0] ?? null);
    if (requestedPage && !selected) {
      throw new Response("Published resource not found", { status: 404 });
    }
    let selectedPage = null;
    if (selected) {
      const content = await this.env.DB.prepare(
        `SELECT document_json AS documentJson
           FROM resource_page_versions
          WHERE id = ? AND event_id = ? AND resource_page_id = ?
            AND status = 'published'`,
      )
        .bind(selected.versionId, viewer.eventId, selected.id)
        .first<{ documentJson: string }>();
      if (!content) {
        throw new ResourceInvariantError(
          selected.id,
          "the published version content is missing",
        );
      }
      let document: TiptapNode;
      try {
        document = parseResourceDocument(JSON.parse(content.documentJson));
        validateResourceDocumentEmbedStructure(document);
      } catch {
        throw new ResourceInvariantError(
          selected.id,
          "the published version contains invalid content",
        );
      }
      const rows = await this.env.DB.prepare(
        `
        SELECT fa.id, fv.original_filename AS filename, fv.size_bytes AS sizeBytes
          FROM resource_attachments ra
          JOIN file_assets fa ON fa.id = ra.file_asset_id AND fa.event_id = ra.event_id AND fa.status = 'active'
          JOIN file_versions fv ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
         WHERE ra.resource_page_version_id = ? AND fv.scan_status = 'clean' AND fv.signature_status = 'valid' AND fv.released_at IS NOT NULL
         ORDER BY ra.position
      `,
      )
        .bind(selected.versionId)
        .all<{ id: string; filename: string; sizeBytes: number }>();
      selectedPage = {
        ...selected,
        acknowledgementRequired: Boolean(selected.acknowledgementRequired),
        acknowledged: Boolean(selected.acknowledged),
        document,
        attachments: rows.results,
      };
    }
    return {
      embedConfiguration: resourceEmbedConfiguration(this.env),
      pages: pages.results,
      selected: selectedPage,
    };
  }

  async acknowledge(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    userAgent: string | null,
  ) {
    const operation = "resource.acknowledge";
    const idempotencyKey = await airtableCommandKey(operation, viewer, {
      pageId,
      versionId,
    });
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation },
      () => this.acknowledgeD1(viewer, pageId, versionId, userAgent),
    );
  }

  private async acknowledgeD1(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    userAgent: string | null,
  ) {
    const available = await this.env.DB.prepare(
      `
      SELECT rp.id, rv.acknowledgement_required AS required
        FROM resource_pages rp
        CROSS JOIN (SELECT ? AS person_id, ? AS role) participant
        JOIN resource_page_versions rv ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
       WHERE rp.id = ? AND rp.event_id = ? AND rp.status = 'published' AND rv.id = ? AND rv.status = 'published'
         AND ${participantResourceAudienceSql}
    `,
    )
      .bind(viewer.personId, viewer.role, pageId, viewer.eventId, versionId)
      .first<{ id: string; required: number }>();
    if (!available) throw new Response("Resource not found.", { status: 404 });
    if (!available.required)
      throw new ResourceRevisionConflictError(
        "This published resource does not require acknowledgement.",
      );
    const existing = await this.env.DB.prepare(
      `SELECT 1 FROM resource_acknowledgements WHERE resource_page_version_id = ? AND person_id = ?`,
    )
      .bind(versionId, viewer.personId)
      .first();
    if (existing) return false;
    const acknowledgementId = crypto.randomUUID();
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO resource_acknowledgements (
          id, event_id, resource_page_id, resource_page_version_id, person_id, acknowledged_at, user_agent
        )
        SELECT ?, rp.event_id, rp.id, rv.id, participant.person_id, unixepoch(), ?
          FROM resource_pages rp
          CROSS JOIN (SELECT ? AS person_id, ? AS role) participant
          JOIN resource_page_versions rv
            ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
         WHERE rp.id = ? AND rp.event_id = ? AND rp.status = 'published'
           AND rv.id = ? AND rv.status = 'published'
           AND rv.acknowledgement_required = 1
           AND ${participantResourceAudienceSql}
      `,
      ).bind(
        acknowledgementId,
        userAgent?.slice(0, 500) ?? null,
        viewer.personId,
        viewer.role,
        pageId,
        viewer.eventId,
        versionId,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_instances SET status = 'completed', readiness_state = 'on_track', readiness_percent = 100,
          evidence_json = ?, completed_at = unixepoch(), completed_by_person_id = ?, revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND target_type = 'speaker' AND target_id = ?
           AND template_id IN (
             SELECT id FROM task_templates
              WHERE event_id = ? AND json_extract(configuration_json, '$.resourcePageId') = ?
           )
           AND status NOT IN ('completed','waived')
           AND EXISTS (
             SELECT 1 FROM resource_acknowledgements
              WHERE id = ? AND event_id = ? AND resource_page_id = ?
                AND resource_page_version_id = ? AND person_id = ?
           )
      `,
      ).bind(
        JSON.stringify({
          resourcePageId: pageId,
          resourcePageVersionId: versionId,
        }),
        viewer.personId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        pageId,
        acknowledgementId,
        viewer.eventId,
        pageId,
        versionId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?, 'resource.acknowledged', 'resource_page', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM resource_acknowledgements
            WHERE id = ? AND event_id = ? AND resource_page_id = ?
              AND resource_page_version_id = ? AND person_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        pageId,
        JSON.stringify({ versionId }),
        acknowledgementId,
        viewer.eventId,
        pageId,
        versionId,
        viewer.personId,
      ),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return true;
    const acknowledged = await this.env.DB.prepare(
      `SELECT 1 FROM resource_acknowledgements WHERE resource_page_version_id = ? AND person_id = ?`,
    )
      .bind(versionId, viewer.personId)
      .first();
    if (acknowledged) return false;
    throw new ResourceRevisionConflictError();
  }
}

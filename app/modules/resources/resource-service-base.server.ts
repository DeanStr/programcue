import type { Viewer } from "~/platform/auth/authorize.server";

export abstract class ResourceServiceBase {
  constructor(protected readonly env: CloudflareEnvironment) {}

  protected async assertEvent(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!row) throw new Response("This event could not be found.", { status: 404 });
  }

  protected pageSelect() {
    return `
      SELECT rp.id, rp.status,
             rv.title AS title,
             rv.slug AS slug,
             rv.category AS category,
             rv.audience_scope AS audienceScope,
             rv.acknowledgement_required AS acknowledgementRequired,
             rp.revision, rp.updated_at AS updatedAt,
             rv.id AS versionId, rv.version_number AS versionNumber, rv.status AS versionStatus,
             rv.document_json AS documentJson, rv.rendered_html AS renderedHtml, rv.published_at AS publishedAt
        FROM resource_pages rp
        LEFT JOIN resource_page_versions rv ON rv.id = (
          SELECT candidate.id FROM resource_page_versions candidate
           WHERE candidate.resource_page_id = rp.id
           ORDER BY CASE candidate.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
                    candidate.version_number DESC LIMIT 1
        )
    `;
  }
}

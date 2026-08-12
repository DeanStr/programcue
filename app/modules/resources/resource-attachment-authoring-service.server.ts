import type { Viewer } from "~/platform/auth/authorize.server";
import { ResourceServiceBase } from "./resource-service-base.server";
import { ResourceRevisionConflictError } from "./resource-service-shared";

export class ResourceAttachmentAuthoringService extends ResourceServiceBase {
  async attachToDraft(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
    fileVersionId: string,
  ) {
    await this.assertEvent(viewer);
    const inserted = await this.insertDraftAttachment(
      viewer,
      pageId,
      versionId,
      revision,
      assetId,
      fileVersionId,
    );
    if ((inserted.meta.changes ?? 0) === 1) return;

    // The asset/version pair is a natural idempotency boundary. A client may
    // lose the response after the attachment commits and safely retry, but it
    // must never attach to a different or stale resource version.
    const alreadyAttached = await this.env.DB.prepare(
      `
      SELECT 1
        FROM resource_page_versions rv
        JOIN resource_pages rp
          ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id
        JOIN resource_attachments attachment
          ON attachment.resource_page_version_id = rv.id
         AND attachment.event_id = rv.event_id
        JOIN file_assets asset
          ON asset.id = attachment.file_asset_id
         AND asset.event_id = attachment.event_id
        JOIN file_versions file_version
          ON file_version.id = ? AND file_version.asset_id = asset.id
         AND file_version.event_id = asset.event_id
       WHERE rp.id = ? AND rp.event_id = ? AND rp.revision = ?
         AND rv.id = ? AND rv.status = 'draft'
         AND asset.id = ? AND asset.target_type = 'resource'
         AND asset.target_id = rp.id AND asset.status <> 'deleted'
         AND file_version.upload_status = 'uploaded'
         AND file_version.signature_status = 'valid'
      LIMIT 1
    `,
    )
      .bind(fileVersionId, pageId, viewer.eventId, revision, versionId, assetId)
      .first();
    if (!alreadyAttached) throw new ResourceRevisionConflictError();
  }

  private insertDraftAttachment(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
    fileVersionId: string,
  ) {
    return this.env.DB.prepare(
      `
      INSERT OR IGNORE INTO resource_attachments (resource_page_version_id, event_id, file_asset_id, position, label)
      SELECT rv.id, rv.event_id, fa.id,
             (SELECT COUNT(*) FROM resource_attachments existing
               WHERE existing.resource_page_version_id = rv.id),
             NULL
        FROM resource_page_versions rv
        JOIN resource_pages rp
          ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id
        JOIN file_assets fa
          ON fa.event_id = rv.event_id AND fa.target_type = 'resource'
         AND fa.target_id = rp.id
        JOIN file_versions fv
          ON fv.id = ? AND fv.event_id = fa.event_id AND fv.asset_id = fa.id
       WHERE rp.id = ? AND rp.event_id = ? AND rp.revision = ?
         AND rv.id = ? AND rv.status = 'draft'
         AND fa.id = ? AND fa.status <> 'deleted'
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
    `,
    )
      .bind(fileVersionId, pageId, viewer.eventId, revision, versionId, assetId)
      .run();
  }
}

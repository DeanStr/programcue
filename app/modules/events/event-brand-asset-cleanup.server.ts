type RetiredBrandAssetRow = {
  id: string;
  eventId: string;
  organisationId: string;
  objectKey: string;
  objectEtag: string;
};

export type EventBrandAssetCleanupResult = {
  examined: number;
  deleted: number;
  failed: number;
};

export async function cleanupRetiredEventBrandAssets(
  env: CloudflareEnvironment,
  limit = 25,
): Promise<EventBrandAssetCleanupResult> {
  if (!env.DB) throw new Error("Required DB binding is unavailable.");
  if (!env.FILES) throw new Error("Required FILES binding is unavailable.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Brand asset cleanup limit must be between 1 and 100.");
  }

  const candidates = await env.DB.prepare(
    `SELECT id, event_id AS eventId, organisation_id AS organisationId,
            object_key AS objectKey, object_etag AS objectEtag
       FROM event_brand_assets
      WHERE deleted_at IS NOT NULL
        AND (
          cleanup_last_attempt_at IS NULL
          OR cleanup_last_attempt_at <= unixepoch() - CASE
            WHEN cleanup_attempts < 5 THEN 60 * (cleanup_attempts + 1)
            ELSE 3600
          END
        )
      ORDER BY cleanup_last_attempt_at IS NOT NULL,
               cleanup_last_attempt_at, deleted_at, id
      LIMIT ?`,
  )
    .bind(limit)
    .all<RetiredBrandAssetRow>();

  let deleted = 0;
  let failed = 0;
  for (const asset of candidates.results) {
    try {
      await env.FILES.delete(asset.objectKey);
      const result = await env.DB.prepare(
        `DELETE FROM event_brand_assets
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND object_key = ? AND object_etag = ? AND deleted_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = event_brand_assets.event_id
                 AND event.organisation_id = event_brand_assets.organisation_id
                 AND event_brand_assets.id IN (
                   event.brand_logo_asset_id,
                   event.brand_banner_asset_id,
                   event.brand_draft_logo_asset_id,
                   event.brand_draft_banner_asset_id
                 )
            )`,
      )
        .bind(
          asset.id,
          asset.eventId,
          asset.organisationId,
          asset.objectKey,
          asset.objectEtag,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) {
        const remains = await env.DB.prepare(
          "SELECT 1 FROM event_brand_assets WHERE id = ?",
        )
          .bind(asset.id)
          .first();
        if (remains) {
          throw new Error(
            "The retired brand asset changed while cleanup was running.",
          );
        }
      }
      deleted += 1;
    } catch (error) {
      failed += 1;
      await env.DB.prepare(
        `UPDATE event_brand_assets
            SET cleanup_attempts = cleanup_attempts + 1,
                cleanup_last_attempt_at = unixepoch(), cleanup_last_error = ?
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND deleted_at IS NOT NULL`,
      )
        .bind(
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
          ),
          asset.id,
          asset.eventId,
          asset.organisationId,
        )
        .run();
    }
  }

  return { examined: candidates.results.length, deleted, failed };
}

export async function requireRetiredEventBrandAssetCleanup(
  env: CloudflareEnvironment,
) {
  const result = await cleanupRetiredEventBrandAssets(env);
  if (result.failed > 0) {
    throw new Error(
      `${result.failed} retired branding asset${result.failed === 1 ? "" : "s"} could not be deleted from private storage.`,
    );
  }
  return result;
}

import { requireValue } from "~/lib/required-value";
import {
  AirtableEventDataRepository,
  type AirtableProjectionCommandToken,
} from "~/modules/airtable/airtable-event-data-repository.server";
import {
  detectContentType,
  FilePolicyError,
  safeDownloadName,
  validateFileSignature,
} from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EventBrandImageNormalizationError,
  type NormalizedEventBrandImage,
  normalizeEventBrandImage,
} from "./event-brand-image-normalizer.server";
import {
  adminEventBrandAssetPath,
  EVENT_BRAND_ASSET_MAXIMUM_BYTES,
  type EventBrandAssetKind,
  eventBrandAssetKindSchema,
  eventBrandDraftInputSchema,
  eventBrandPublishInputSchema,
  publicEventBrandAssetPath,
} from "./event-branding";

type BrandAssetRow = {
  id: string;
  kind: EventBrandAssetKind;
  objectKey: string;
  objectEtag: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  normalizedAt: number;
};

type BrandingRow = {
  name: string;
  slug: string;
  draftAccent: string;
  draftLogoAssetId: string | null;
  draftBannerAssetId: string | null;
  draftWelcomeText: string | null;
  draftSupportUrl: string | null;
  draftRevision: number;
  publishedAccent: string;
  publishedLegacyLogoUrl: string | null;
  publishedLegacyBannerUrl: string | null;
  publishedLogoAssetId: string | null;
  publishedBannerAssetId: string | null;
  publishedWelcomeText: string | null;
  publishedSupportUrl: string | null;
  publishedRevision: number;
  publishedAt: number | null;
  repositoryProvider: "d1" | "airtable";
};

export class EventBrandingNotFoundError extends Error {
  constructor(message = "Event branding was not found in this organisation.") {
    super(message);
    this.name = "EventBrandingNotFoundError";
  }
}

export class EventBrandingRevisionConflictError extends Error {
  constructor() {
    super(
      "Branding changed after this page loaded. Refresh and review the latest draft before continuing.",
    );
    this.name = "EventBrandingRevisionConflictError";
  }
}

export class EventBrandingAssetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventBrandingAssetError";
  }
}

export class EventBrandingCleanupIntegrityError extends Error {
  constructor(cause: unknown) {
    super(
      "Branding asset cleanup could not be completed or recorded. Retry only after the storage cleanup failure has been investigated.",
      { cause },
    );
    this.name = "EventBrandingCleanupIntegrityError";
  }
}

export class EventBrandingProjectionCommitError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super(
      `Branding was published in Program Cue, but Airtable is not reconciled: ${cause instanceof Error ? cause.message : String(cause)} Recover the recorded projection run before continuing.`,
    );
    this.name = "EventBrandingProjectionCommitError";
  }
}

export class EventBrandingChangeCommitError extends Error {
  readonly committed = true;

  constructor(operation: "saved" | "uploaded" | "published") {
    super(
      `Branding was ${operation}, but its required event change record is missing. Refresh before continuing and investigate the committed operation.`,
    );
    this.name = "EventBrandingChangeCommitError";
  }
}

export class EventBrandingAuditCommitError extends Error {
  readonly committed = true;

  constructor(operation: "saved" | "uploaded" | "published") {
    super(
      `Branding was ${operation}, but its required success audit is missing. Refresh before continuing and investigate the committed operation.`,
    );
    this.name = "EventBrandingAuditCommitError";
  }
}

export class EventBrandingAssetChangedError extends Error {
  constructor() {
    super(
      "Branding changed while its published asset was being read. Retry the request.",
    );
    this.name = "EventBrandingAssetChangedError";
  }
}

export class EventBrandingService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES)
      throw new EventBrandingAssetError(
        "Required private file storage is unavailable; branding assets were not saved.",
      );
    return this.env.FILES;
  }

  private requireImages() {
    if (!this.env.IMAGES)
      throw new EventBrandingAssetError(
        "Required image normalization is unavailable; the branding asset was not saved.",
      );
    return this.env.IMAGES;
  }

  private snapshotsMatch(row: BrandingRow) {
    return (
      row.draftAccent === row.publishedAccent &&
      row.publishedLegacyLogoUrl === null &&
      row.publishedLegacyBannerUrl === null &&
      row.draftLogoAssetId === row.publishedLogoAssetId &&
      row.draftBannerAssetId === row.publishedBannerAssetId &&
      row.draftWelcomeText === row.publishedWelcomeText &&
      row.draftSupportUrl === row.publishedSupportUrl
    );
  }

  private changeSequence(
    result: D1Result | undefined,
    operation: "saved" | "uploaded" | "published",
  ) {
    const sequence = Number(
      (result?.results[0] as { sequence?: number } | undefined)?.sequence,
    );
    if (
      (result?.meta.changes ?? 0) !== 1 ||
      !Number.isInteger(sequence) ||
      sequence < 1
    )
      throw new EventBrandingChangeCommitError(operation);
    return sequence;
  }

  private eventMutationApplied(result: D1Result | undefined, eventId: string) {
    const rows = result?.results as Array<{ id?: string }> | undefined;
    return rows?.length === 1 && rows[0]?.id === eventId;
  }

  private async loadRow(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT name, slug,
              brand_draft_accent AS draftAccent,
              brand_draft_logo_asset_id AS draftLogoAssetId,
              brand_draft_banner_asset_id AS draftBannerAssetId,
              brand_draft_welcome_text AS draftWelcomeText,
              brand_draft_support_url AS draftSupportUrl,
              brand_draft_revision AS draftRevision,
              brand_accent AS publishedAccent,
              participant_logo_url AS publishedLegacyLogoUrl,
              programme_hero_image_url AS publishedLegacyBannerUrl,
              brand_logo_asset_id AS publishedLogoAssetId,
              brand_banner_asset_id AS publishedBannerAssetId,
              participant_welcome_text AS publishedWelcomeText,
              participant_support_url AS publishedSupportUrl,
              brand_published_revision AS publishedRevision,
              brand_published_at AS publishedAt,
              repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ? AND activation_status = 'active'`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<BrandingRow>();
    if (!row) throw new EventBrandingNotFoundError();
    return row;
  }

  private assetSummary(
    asset: BrandAssetRow | null,
    exposure: "draft" | "published",
    slug: string,
  ) {
    if (!asset) return null;
    return {
      id: asset.id,
      kind: asset.kind,
      filename: asset.filename,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      url:
        exposure === "draft"
          ? adminEventBrandAssetPath(asset.id)
          : publicEventBrandAssetPath(slug, asset.kind),
    };
  }

  private async loadAsset(
    viewer: Viewer,
    assetId: string | null,
    expectedKind: EventBrandAssetKind,
  ) {
    if (!assetId) return null;
    const asset = await this.env.DB.prepare(
      `SELECT id, kind, object_key AS objectKey, object_etag AS objectEtag,
              original_filename AS filename, content_type AS contentType,
              size_bytes AS sizeBytes, width_px AS width,
              height_px AS height, normalized_at AS normalizedAt
         FROM event_brand_assets
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND kind = ? AND deleted_at IS NULL AND normalized_at IS NOT NULL`,
    )
      .bind(assetId, viewer.eventId, viewer.organisationId, expectedKind)
      .first<BrandAssetRow>();
    if (!asset)
      throw new EventBrandingAssetError(
        `The selected ${expectedKind} is unavailable or belongs to another event.`,
      );
    return asset;
  }

  async getWorkspace(viewer: Viewer) {
    const row = await this.loadRow(viewer);
    const [draftLogo, draftBanner, publishedLogo, publishedBanner] =
      await Promise.all([
        this.loadAsset(viewer, row.draftLogoAssetId, "logo"),
        this.loadAsset(viewer, row.draftBannerAssetId, "banner"),
        this.loadAsset(viewer, row.publishedLogoAssetId, "logo"),
        this.loadAsset(viewer, row.publishedBannerAssetId, "banner"),
      ]);
    const draft = {
      accent: row.draftAccent,
      logoAssetId: row.draftLogoAssetId,
      bannerAssetId: row.draftBannerAssetId,
      welcomeText: row.draftWelcomeText,
      supportUrl: row.draftSupportUrl,
      revision: row.draftRevision,
      logo: this.assetSummary(draftLogo, "draft", row.slug),
      banner: this.assetSummary(draftBanner, "draft", row.slug),
    };
    const published = {
      accent: row.publishedAccent,
      legacyLogoUrl: row.publishedLegacyLogoUrl,
      legacyBannerUrl: row.publishedLegacyBannerUrl,
      logoAssetId: row.publishedLogoAssetId,
      bannerAssetId: row.publishedBannerAssetId,
      welcomeText: row.publishedWelcomeText,
      supportUrl: row.publishedSupportUrl,
      revision: row.publishedRevision,
      publishedAt: row.publishedAt,
      logo: this.assetSummary(publishedLogo, "published", row.slug),
      banner: this.assetSummary(publishedBanner, "published", row.slug),
    };
    return {
      event: { name: row.name, slug: row.slug },
      draft,
      published,
      hasUnpublishedChanges: !this.snapshotsMatch(row),
    };
  }

  private async assertAssetSelections(
    viewer: Viewer,
    logoAssetId: string | null,
    bannerAssetId: string | null,
  ) {
    await Promise.all([
      this.loadAsset(viewer, logoAssetId, "logo"),
      this.loadAsset(viewer, bannerAssetId, "banner"),
    ]);
  }

  async saveDraft(viewer: Viewer, input: unknown) {
    const parsed = eventBrandDraftInputSchema.parse(input);
    await this.assertAssetSelections(
      viewer,
      parsed.logoAssetId,
      parsed.bannerAssetId,
    );
    const operationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events
            SET brand_draft_accent = ?, brand_draft_logo_asset_id = ?,
                brand_draft_banner_asset_id = ?, brand_draft_welcome_text = ?,
                brand_draft_support_url = ?, brand_draft_revision = brand_draft_revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND brand_draft_revision = ?
          RETURNING id`,
      ).bind(
        parsed.accent,
        parsed.logoAssetId,
        parsed.bannerAssetId,
        parsed.welcomeText,
        parsed.supportUrl,
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'event.branding.draft_saved', 'event', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              AND brand_draft_revision = ? AND last_operation_id = ?
              AND brand_draft_accent = ?
              AND brand_draft_logo_asset_id IS ?
              AND brand_draft_banner_asset_id IS ?
              AND brand_draft_welcome_text IS ?
              AND brand_draft_support_url IS ?
          )`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        operationId,
        JSON.stringify({ accent: parsed.accent }),
        viewer.eventId,
        viewer.organisationId,
        parsed.revision + 1,
        operationId,
        parsed.accent,
        parsed.logoAssetId,
        parsed.bannerAssetId,
        parsed.welcomeText,
        parsed.supportUrl,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, 'event_branding', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              AND brand_draft_revision = ? AND last_operation_id = ?
          )
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision + 1,
        operationId,
        operationId,
      ),
    ]);
    if (!this.eventMutationApplied(results[0], viewer.eventId))
      throw new EventBrandingRevisionConflictError();
    if ((results[1]?.meta.changes ?? 0) !== 1)
      throw new EventBrandingAuditCommitError("saved");
    return {
      revision: parsed.revision + 1,
      changeSequence: this.changeSequence(results[2], "saved"),
    };
  }

  async uploadDraftAsset(
    viewer: Viewer,
    input: { kind: unknown; revision: unknown; file: unknown },
  ) {
    const kind = eventBrandAssetKindSchema.parse(input.kind);
    const revision = Number(input.revision);
    if (!Number.isInteger(revision) || revision < 1)
      throw new EventBrandingRevisionConflictError();
    if (!(input.file instanceof File))
      throw new EventBrandingAssetError(`Choose a ${kind} image to upload.`);
    const current = await this.loadRow(viewer);
    if (current.draftRevision !== revision)
      throw new EventBrandingRevisionConflictError();
    const file = input.file;
    const maximum = EVENT_BRAND_ASSET_MAXIMUM_BYTES[kind];
    if (!file.name || file.name.length > 180 || file.size < 1)
      throw new EventBrandingAssetError("Choose a non-empty image filename.");
    if (file.size > maximum)
      throw new EventBrandingAssetError(
        `${kind === "logo" ? "Logo" : "Banner"} images must be ${maximum / 1_048_576} MB or smaller.`,
      );
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new EventBrandingAssetError(
        "Brand images must be JPEG, PNG or WebP files.",
      );
    const detected = await detectContentType(file);
    try {
      validateFileSignature("headshot", file, detected);
    } catch (error) {
      throw new EventBrandingAssetError(
        error instanceof FilePolicyError
          ? error.message
          : "The brand image signature could not be validated.",
      );
    }
    const images = this.requireImages();
    let normalized: NormalizedEventBrandImage;
    try {
      normalized = await normalizeEventBrandImage({
        images,
        kind,
        file,
        detectedContentType: requireValue(
          detected,
          "Required detected is unavailable.",
        ),
      });
    } catch (error) {
      throw new EventBrandingAssetError(
        error instanceof EventBrandImageNormalizationError
          ? error.message
          : "The brand image could not be normalized.",
      );
    }
    const bucket = this.requireBucket();
    const assetId = crypto.randomUUID();
    const objectKey = `private/events/${viewer.eventId}/branding/${kind}/${assetId}`;
    const filename = safeDownloadName(file.name);
    let stored: R2Object | null;
    try {
      stored = await bucket.put(objectKey, normalized.bytes, {
        httpMetadata: { contentType: normalized.contentType },
        customMetadata: {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          kind,
          normalized: normalized.normalizerVersion,
        },
      });
    } catch (error) {
      await this.discardUnattachedAsset(viewer, {
        assetId,
        kind,
        objectKey,
        objectEtag: "unknown-after-storage-error",
        filename,
        normalized,
      });
      throw new EventBrandingAssetError(
        "Private storage failed while saving the normalized brand image; the branding asset was not attached.",
        { cause: error },
      );
    }
    if (!stored?.httpEtag) {
      await this.discardUnattachedAsset(viewer, {
        assetId,
        kind,
        objectKey,
        objectEtag: "unknown-missing-storage-etag",
        filename,
        normalized,
      });
      throw new EventBrandingAssetError(
        "Private storage did not return an object ETag; the brand image was not saved.",
      );
    }
    const operationId = crypto.randomUUID();
    const draftColumn =
      kind === "logo"
        ? "brand_draft_logo_asset_id"
        : "brand_draft_banner_asset_id";
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO event_brand_assets (
             id, organisation_id, event_id, kind, object_key, object_etag,
             original_filename, content_type, size_bytes, width_px, height_px,
             normalizer_version, normalized_at, created_by_person_id, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
                AND brand_draft_revision = ?
            )`,
        ).bind(
          assetId,
          viewer.organisationId,
          viewer.eventId,
          kind,
          objectKey,
          stored.httpEtag,
          filename,
          normalized.contentType,
          normalized.bytes.byteLength,
          normalized.width,
          normalized.height,
          normalized.normalizerVersion,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          revision,
        ),
        this.env.DB.prepare(
          `UPDATE events SET ${draftColumn} = ?,
                  brand_draft_revision = brand_draft_revision + 1,
                  last_operation_id = ?, last_updated_by_person_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND brand_draft_revision = ?
              AND EXISTS (
                SELECT 1 FROM event_brand_assets asset
                 WHERE asset.id = ? AND asset.event_id = events.id
                   AND asset.organisation_id = events.organisation_id
                   AND asset.kind = ? AND asset.deleted_at IS NULL
                   AND asset.normalized_at IS NOT NULL
              )
          RETURNING id`,
        ).bind(
          assetId,
          operationId,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          revision,
          assetId,
          kind,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id,
             actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           )
           SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                  'event.branding.asset_uploaded',
                  'event_brand_asset', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events event
              JOIN event_brand_assets asset
                ON asset.id = event.${draftColumn}
               AND asset.event_id = event.id
               AND asset.organisation_id = event.organisation_id
               AND asset.kind = ? AND asset.deleted_at IS NULL
               AND asset.normalized_at IS NOT NULL
             WHERE event.id = ? AND event.organisation_id = ?
               AND event.brand_draft_revision = ?
               AND event.last_operation_id = ? AND asset.id = ?
            )`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          assetId,
          operationId,
          JSON.stringify({
            kind,
            originalContentType: detected,
            originalSizeBytes: file.size,
            contentType: normalized.contentType,
            sizeBytes: normalized.bytes.byteLength,
            width: normalized.width,
            height: normalized.height,
            normalizerVersion: normalized.normalizerVersion,
          }),
          kind,
          viewer.eventId,
          viewer.organisationId,
          revision + 1,
          operationId,
          assetId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id, created_at
           )
           SELECT ?, 'event_branding', ?, 'updated', ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events event
              JOIN event_brand_assets asset
                ON asset.id = event.${draftColumn}
               AND asset.event_id = event.id
               AND asset.organisation_id = event.organisation_id
               AND asset.kind = ? AND asset.deleted_at IS NULL
               AND asset.normalized_at IS NOT NULL
             WHERE event.id = ? AND event.organisation_id = ?
               AND event.brand_draft_revision = ?
               AND event.last_operation_id = ? AND asset.id = ?
            )
              AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
           RETURNING sequence`,
        ).bind(
          viewer.eventId,
          viewer.eventId,
          operationId,
          kind,
          viewer.eventId,
          viewer.organisationId,
          revision + 1,
          operationId,
          assetId,
          operationId,
        ),
      ]);
    } catch (error) {
      await this.discardUnattachedAsset(viewer, {
        assetId,
        kind,
        objectKey,
        objectEtag: stored.httpEtag,
        filename,
        normalized,
      });
      throw error;
    }
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      !this.eventMutationApplied(results[1], viewer.eventId)
    ) {
      await this.discardUnattachedAsset(viewer, {
        assetId,
        kind,
        objectKey,
        objectEtag: stored.httpEtag,
        filename,
        normalized,
      });
      throw new EventBrandingRevisionConflictError();
    }
    if ((results[2]?.meta.changes ?? 0) !== 1)
      throw new EventBrandingAuditCommitError("uploaded");
    return {
      assetId,
      revision: revision + 1,
      changeSequence: this.changeSequence(results[3], "uploaded"),
    };
  }

  private async discardUnattachedAsset(
    viewer: Viewer,
    asset: {
      assetId: string;
      kind: EventBrandAssetKind;
      objectKey: string;
      objectEtag: string;
      filename: string;
      normalized: NormalizedEventBrandImage;
    },
  ) {
    let evidenceState: "tombstoned" | "absent";
    try {
      evidenceState = await this.ensureDiscardEvidence(viewer, asset);
    } catch (error) {
      throw new EventBrandingCleanupIntegrityError(error);
    }

    try {
      await this.requireBucket().delete(asset.objectKey);
    } catch (error) {
      try {
        if (evidenceState === "absent") {
          evidenceState = await this.ensureDiscardEvidence(viewer, asset);
        }
        if (evidenceState !== "tombstoned") {
          throw new Error(
            "No durable tombstone exists for the branding object that storage could not delete.",
          );
        }
        const recorded = await this.env.DB.prepare(
          `UPDATE event_brand_assets
              SET cleanup_attempts = cleanup_attempts + 1,
                  cleanup_last_attempt_at = unixepoch(), cleanup_last_error = ?
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND object_key = ? AND deleted_at IS NOT NULL`,
        )
          .bind(
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              500,
            ),
            asset.assetId,
            viewer.eventId,
            viewer.organisationId,
            asset.objectKey,
          )
          .run();
        if ((recorded.meta.changes ?? 0) !== 1) {
          throw new Error(
            "The branding cleanup failure could not be attached to its tombstone.",
          );
        }
      } catch (evidenceError) {
        throw new EventBrandingCleanupIntegrityError(
          new AggregateError(
            [error, evidenceError],
            "R2 deletion and durable cleanup evidence both failed.",
          ),
        );
      }
      return;
    }

    if (evidenceState === "tombstoned") {
      try {
        await this.env.DB.prepare(
          `DELETE FROM event_brand_assets
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND object_key = ? AND deleted_at IS NOT NULL`,
        )
          .bind(
            asset.assetId,
            viewer.eventId,
            viewer.organisationId,
            asset.objectKey,
          )
          .run();
      } catch (error) {
        console.error(
          "The branding object was deleted, but its cleanup tombstone remains for an idempotent retry.",
          error,
        );
      }
    }
  }

  private async ensureDiscardEvidence(
    viewer: Viewer,
    asset: {
      assetId: string;
      kind: EventBrandAssetKind;
      objectKey: string;
      objectEtag: string;
      filename: string;
      normalized: NormalizedEventBrandImage;
    },
  ): Promise<"tombstoned" | "absent"> {
    let writeError: unknown = null;
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE event_brand_assets
              SET deleted_at = COALESCE(deleted_at, unixepoch())
            WHERE id = ? AND event_id = ? AND organisation_id = ?
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
        ).bind(asset.assetId, viewer.eventId, viewer.organisationId),
        this.env.DB.prepare(
          `INSERT INTO event_brand_assets (
             id, organisation_id, event_id, kind, object_key, object_etag,
             original_filename, content_type, size_bytes, width_px, height_px,
             normalizer_version, normalized_at, created_by_person_id, created_at,
             deleted_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?,
                  unixepoch(), unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
            )
              AND NOT EXISTS (
                SELECT 1 FROM event_brand_assets WHERE id = ?
              )`,
        ).bind(
          asset.assetId,
          viewer.organisationId,
          viewer.eventId,
          asset.kind,
          asset.objectKey,
          asset.objectEtag,
          asset.filename,
          asset.normalized.contentType,
          asset.normalized.bytes.byteLength,
          asset.normalized.width,
          asset.normalized.height,
          asset.normalized.normalizerVersion,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          asset.assetId,
        ),
      ]);
    } catch (error) {
      writeError = error;
    }

    let evidence: { objectKey: string; deletedAt: number | null } | null;
    try {
      evidence = await this.env.DB.prepare(
        `SELECT object_key AS objectKey, deleted_at AS deletedAt
           FROM event_brand_assets
          WHERE id = ? AND event_id = ? AND organisation_id = ?`,
      )
        .bind(asset.assetId, viewer.eventId, viewer.organisationId)
        .first<{ objectKey: string; deletedAt: number | null }>();
    } catch (readError) {
      throw new AggregateError(
        [writeError, readError].filter((error) => error !== null),
        "Branding cleanup evidence could not be persisted or verified.",
      );
    }
    if (!evidence) return "absent";
    if (evidence.objectKey !== asset.objectKey || evidence.deletedAt === null) {
      throw new AggregateError(
        [writeError].filter((error) => error !== null),
        "The branding asset is still live or its cleanup identity does not match.",
      );
    }
    return "tombstoned";
  }

  private async assertStoredAsset(asset: BrandAssetRow | null) {
    if (!asset) return;
    const stored = await this.requireBucket().head(asset.objectKey);
    if (
      !stored ||
      stored.httpEtag !== asset.objectEtag ||
      stored.size !== asset.sizeBytes
    )
      throw new EventBrandingAssetError(
        `The draft ${asset.kind} is missing from private storage or no longer matches its validated bytes. Upload a replacement before publishing.`,
      );
  }

  async publish(viewer: Viewer, input: unknown) {
    const parsed = eventBrandPublishInputSchema.parse(input);
    const row = await this.loadRow(viewer);
    if (row.draftRevision !== parsed.revision)
      throw new EventBrandingRevisionConflictError();
    const [logo, banner] = await Promise.all([
      this.loadAsset(viewer, row.draftLogoAssetId, "logo"),
      this.loadAsset(viewer, row.draftBannerAssetId, "banner"),
    ]);
    await Promise.all([
      this.assertStoredAsset(logo),
      this.assertStoredAsset(banner),
    ]);
    if (
      row.publishedAt !== null &&
      row.publishedRevision === row.draftRevision &&
      this.snapshotsMatch(row)
    ) {
      return { revision: parsed.revision, changeSequence: 0 };
    }
    let projectionToken: AirtableProjectionCommandToken | null = null;
    const airtable = new AirtableEventDataRepository(this.env);
    if (row.repositoryProvider === "airtable") {
      projectionToken = await airtable.beginCommand(viewer, {
        idempotencyKey: `event-branding:publish:${viewer.eventId}:${parsed.revision}`,
        operation: "event_branding.publish",
      });
    }
    const operationId = crypto.randomUUID();
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE events
            SET brand_accent = brand_draft_accent,
                brand_logo_asset_id = brand_draft_logo_asset_id,
                brand_banner_asset_id = brand_draft_banner_asset_id,
                participant_logo_url = NULL,
                programme_hero_image_url = NULL,
                participant_welcome_text = brand_draft_welcome_text,
                participant_support_url = brand_draft_support_url,
                brand_published_revision = brand_draft_revision,
                brand_published_at = unixepoch(),
                public_projection_revision = public_projection_revision + 1,
                revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND brand_draft_revision = ?
          RETURNING id`,
        ).bind(
          operationId,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'event.branding.published', 'event', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              AND brand_draft_revision = ?
              AND brand_published_revision = brand_draft_revision
              AND brand_logo_asset_id IS brand_draft_logo_asset_id
              AND brand_banner_asset_id IS brand_draft_banner_asset_id
              AND brand_accent = brand_draft_accent
              AND participant_welcome_text IS brand_draft_welcome_text
              AND participant_support_url IS brand_draft_support_url
              AND participant_logo_url IS NULL
              AND programme_hero_image_url IS NULL
              AND brand_published_at IS NOT NULL AND last_operation_id = ?
          )`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          viewer.eventId,
          operationId,
          JSON.stringify({
            revision: parsed.revision,
            surfaces: ["application", "participant", "programme", "email"],
          }),
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, 'event_branding', ?, 'published', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              AND brand_published_revision = ? AND last_operation_id = ?
              AND brand_logo_asset_id IS brand_draft_logo_asset_id
              AND brand_banner_asset_id IS brand_draft_banner_asset_id
          )
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         RETURNING sequence`,
        ).bind(
          viewer.eventId,
          viewer.eventId,
          operationId,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          operationId,
          operationId,
        ),
      ]);
    } catch (error) {
      if (projectionToken) await airtable.abortCommand(projectionToken, error);
      throw error;
    }
    if (!this.eventMutationApplied(results[0], viewer.eventId)) {
      if (projectionToken)
        await airtable.abortCommand(
          projectionToken,
          new EventBrandingRevisionConflictError(),
        );
      throw new EventBrandingRevisionConflictError();
    }
    const evidenceError =
      (results[1]?.meta.changes ?? 0) === 1
        ? null
        : new EventBrandingAuditCommitError("published");
    if (projectionToken) {
      try {
        await airtable.completeCommand(projectionToken);
      } catch (error) {
        throw new EventBrandingProjectionCommitError(error);
      }
    }
    if (evidenceError) throw evidenceError;
    return {
      revision: parsed.revision,
      changeSequence: this.changeSequence(results[2], "published"),
    };
  }

  async getAdminAsset(viewer: Viewer, assetId: string) {
    return this.loadAssetById(viewer.organisationId, viewer.eventId, assetId);
  }

  async getPublishedAsset(slug: string, kindInput: unknown) {
    const kind = eventBrandAssetKindSchema.parse(kindInput);
    const assetColumn =
      kind === "logo" ? "brand_logo_asset_id" : "brand_banner_asset_id";
    return this.env.DB.prepare(
      `SELECT asset.id, asset.kind, asset.object_key AS objectKey,
              asset.object_etag AS objectEtag,
              asset.original_filename AS filename,
              asset.content_type AS contentType, asset.size_bytes AS sizeBytes,
              asset.width_px AS width, asset.height_px AS height,
              asset.normalized_at AS normalizedAt
         FROM events event
         JOIN event_brand_assets asset
           ON asset.id = event.${assetColumn}
          AND asset.event_id = event.id
          AND asset.organisation_id = event.organisation_id
          AND asset.kind = ? AND asset.deleted_at IS NULL
          AND asset.normalized_at IS NOT NULL
        WHERE event.slug = ? AND event.activation_status = 'active'
          AND event.brand_published_at IS NOT NULL`,
    )
      .bind(kind, slug)
      .first<BrandAssetRow>();
  }

  private async loadAssetById(
    organisationId: string,
    eventId: string,
    assetId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT id, kind, object_key AS objectKey, object_etag AS objectEtag,
              original_filename AS filename, content_type AS contentType,
              size_bytes AS sizeBytes, width_px AS width,
              height_px AS height, normalized_at AS normalizedAt
         FROM event_brand_assets
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND deleted_at IS NULL AND normalized_at IS NOT NULL`,
    )
      .bind(assetId, eventId, organisationId)
      .first<BrandAssetRow>();
  }

  async assetResponse(asset: BrandAssetRow, visibility: "private" | "public") {
    const object = await this.requireBucket().get(asset.objectKey);
    if (
      !object ||
      object.httpEtag !== asset.objectEtag ||
      object.size !== asset.sizeBytes
    )
      throw new EventBrandingAssetError(
        "The validated branding asset is missing from private storage.",
      );
    return new Response(object.body, {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(object.size),
        "content-disposition": "inline",
        etag: asset.objectEtag,
        "cache-control":
          visibility === "public"
            ? "public, max-age=0, must-revalidate"
            : "private, no-store",
        ...(visibility === "public"
          ? {
              "access-control-allow-origin": "*",
              "cross-origin-resource-policy": "cross-origin",
              "referrer-policy": "no-referrer",
            }
          : {}),
        "x-content-type-options": "nosniff",
      },
    });
  }

  async publishedAssetResponse(
    slug: string,
    kindInput: unknown,
    request: Request,
  ) {
    const asset = await this.getPublishedAsset(slug, kindInput);
    if (!asset) return null;
    const candidate = request.headers.get("if-none-match");
    const notModified =
      candidate === "*" ||
      candidate?.split(",").some((value) => value.trim() === asset.objectEtag);
    const bucket = this.requireBucket();
    const object = notModified
      ? await bucket.head(asset.objectKey)
      : await bucket.get(asset.objectKey);
    if (
      !object ||
      object.httpEtag !== asset.objectEtag ||
      object.size !== asset.sizeBytes
    )
      throw new EventBrandingAssetError(
        "The validated branding asset is missing from private storage.",
      );
    const current = await this.getPublishedAsset(slug, asset.kind);
    if (
      !current ||
      current.id !== asset.id ||
      current.objectKey !== asset.objectKey ||
      current.objectEtag !== asset.objectEtag ||
      current.sizeBytes !== asset.sizeBytes
    ) {
      if ("body" in object) await (object as R2ObjectBody).body.cancel();
      throw new EventBrandingAssetChangedError();
    }
    const headers = {
      etag: asset.objectEtag,
      "cache-control": "public, max-age=0, must-revalidate",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    if (notModified) return new Response(null, { status: 304, headers });
    return new Response((object as R2ObjectBody).body, {
      headers: {
        ...headers,
        "content-type": asset.contentType,
        "content-length": String(asset.sizeBytes),
        "content-disposition": "inline",
      },
    });
  }
}

import type { Viewer } from "~/platform/auth/authorize.server";
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
import {
  adminEventBrandAssetPath,
  EVENT_BRAND_ASSET_MAXIMUM_BYTES,
  eventBrandAssetKindSchema,
  eventBrandDraftInputSchema,
  eventBrandPublishInputSchema,
  publicEventBrandAssetPath,
  type EventBrandAssetKind,
} from "./event-branding";

type BrandAssetRow = {
  id: string;
  kind: EventBrandAssetKind;
  objectKey: string;
  objectEtag: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
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
  constructor(message: string) {
    super(message);
    this.name = "EventBrandingAssetError";
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
              size_bytes AS sizeBytes
         FROM event_brand_assets
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND kind = ? AND deleted_at IS NULL`,
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
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'event.branding.draft_saved', 'event', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              AND brand_draft_revision = ?
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
        parsed.revision,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET brand_draft_accent = ?, brand_draft_logo_asset_id = ?,
                brand_draft_banner_asset_id = ?, brand_draft_welcome_text = ?,
                brand_draft_support_url = ?, brand_draft_revision = brand_draft_revision + 1,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND brand_draft_revision = ?
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(
        parsed.accent,
        parsed.logoAssetId,
        parsed.bannerAssetId,
        parsed.welcomeText,
        parsed.supportUrl,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, 'event_branding', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         RETURNING sequence`,
      ).bind(viewer.eventId, viewer.eventId, operationId, operationId),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    )
      throw new EventBrandingRevisionConflictError();
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
    const bucket = this.requireBucket();
    const assetId = crypto.randomUUID();
    const objectKey = `private/events/${viewer.eventId}/branding/${kind}/${assetId}`;
    const stored = await bucket.put(objectKey, file.stream(), {
      httpMetadata: { contentType: detected! },
      customMetadata: {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        kind,
      },
    });
    if (!stored?.httpEtag) {
      await bucket.delete(objectKey);
      throw new EventBrandingAssetError(
        "Private storage did not return an object ETag; the brand image was not saved.",
      );
    }
    const operationId = crypto.randomUUID();
    const draftColumn =
      kind === "logo"
        ? "brand_draft_logo_asset_id"
        : "brand_draft_banner_asset_id";
    try {
      const results = await this.env.DB.batch([
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
              SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
                AND brand_draft_revision = ?
            )`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          assetId,
          operationId,
          JSON.stringify({ kind, contentType: detected, sizeBytes: file.size }),
          viewer.eventId,
          viewer.organisationId,
          revision,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_brand_assets (
             id, organisation_id, event_id, kind, object_key, object_etag,
             original_filename, content_type, size_bytes, created_by_person_id,
             created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(
          assetId,
          viewer.organisationId,
          viewer.eventId,
          kind,
          objectKey,
          stored.httpEtag,
          safeDownloadName(file.name),
          detected,
          file.size,
          viewer.personId,
          operationId,
        ),
        this.env.DB.prepare(
          `UPDATE events SET ${draftColumn} = ?,
                  brand_draft_revision = brand_draft_revision + 1,
                  last_updated_by_person_id = ?, updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND brand_draft_revision = ?
              AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(
          assetId,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          revision,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id, created_at
           )
           SELECT ?, 'event_branding', ?, 'updated', ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
           RETURNING sequence`,
        ).bind(viewer.eventId, viewer.eventId, operationId, operationId),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1
      ) {
        await this.env.DB.prepare(
          "DELETE FROM event_brand_assets WHERE id = ? AND event_id = ?",
        )
          .bind(assetId, viewer.eventId)
          .run();
        await bucket.delete(objectKey);
        throw new EventBrandingRevisionConflictError();
      }
      return {
        assetId,
        revision: revision + 1,
        changeSequence: this.changeSequence(results[3], "uploaded"),
      };
    } catch (error) {
      if (
        !(error instanceof EventBrandingRevisionConflictError) &&
        !(error instanceof EventBrandingChangeCommitError)
      ) {
        await bucket.delete(objectKey);
      }
      throw error;
    }
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
        ),
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
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(
          operationId,
          viewer.personId,
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
          WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         RETURNING sequence`,
        ).bind(viewer.eventId, viewer.eventId, operationId, operationId),
      ]);
    } catch (error) {
      if (projectionToken) await airtable.abortCommand(projectionToken, error);
      throw error;
    }
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    ) {
      if (projectionToken)
        await airtable.abortCommand(
          projectionToken,
          new EventBrandingRevisionConflictError(),
        );
      throw new EventBrandingRevisionConflictError();
    }
    if (projectionToken) {
      try {
        await airtable.completeCommand(projectionToken);
      } catch (error) {
        throw new EventBrandingProjectionCommitError(error);
      }
    }
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
              asset.content_type AS contentType, asset.size_bytes AS sizeBytes
         FROM events event
         JOIN event_brand_assets asset
           ON asset.id = event.${assetColumn}
          AND asset.event_id = event.id
          AND asset.organisation_id = event.organisation_id
          AND asset.kind = ? AND asset.deleted_at IS NULL
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
              size_bytes AS sizeBytes
         FROM event_brand_assets
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND deleted_at IS NULL`,
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

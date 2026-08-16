import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { cleanupRetiredEventBrandAssets } from "./event-brand-asset-cleanup.server";
import {
  EventBrandingAssetChangedError,
  EventBrandingAssetError,
  EventBrandingAuditCommitError,
  EventBrandingChangeCommitError,
  EventBrandingCleanupIntegrityError,
  EventBrandingRevisionConflictError,
  EventBrandingService,
} from "./event-branding-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const truncatedPngHeader = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

const validPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

beforeEach(async () => {
  const testEnvironment = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnvironment);
  const assets = await testEnvironment.DB.prepare(
    "SELECT object_key AS objectKey FROM event_brand_assets WHERE event_id = ?",
  )
    .bind(admin.eventId)
    .all<{ objectKey: string }>();
  await testEnvironment.DB.batch([
    testEnvironment.DB.prepare(
      `UPDATE events
          SET brand_logo_asset_id = NULL, brand_banner_asset_id = NULL,
              brand_draft_logo_asset_id = NULL,
              brand_draft_banner_asset_id = NULL,
              brand_accent = '#4f46e5', brand_draft_accent = '#4f46e5',
              participant_logo_url = NULL, programme_hero_image_url = NULL,
              participant_welcome_text = NULL, participant_support_url = NULL,
              brand_draft_welcome_text = NULL, brand_draft_support_url = NULL,
              brand_draft_revision = 1, brand_published_revision = 1,
              brand_published_at = unixepoch(), last_operation_id = NULL
        WHERE id = ? AND organisation_id = ?`,
    ).bind(admin.eventId, admin.organisationId),
    testEnvironment.DB.prepare(
      "DELETE FROM event_brand_assets WHERE event_id = ?",
    ).bind(admin.eventId),
    testEnvironment.DB.prepare(
      "DELETE FROM event_changes WHERE event_id = ? AND entity_type = 'event_branding'",
    ).bind(admin.eventId),
  ]);
  if (assets.results.length) {
    await testEnvironment.FILES.delete(
      assets.results.map(({ objectKey }) => objectKey),
    );
  }
});

describe("event branding publication", () => {
  it("keeps drafts private, validates stored images and publishes one coherent snapshot", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);

    const saved = await service.saveDraft(admin, {
      revision: initial.draft.revision,
      accent: "#123abc",
      logoAssetId: "",
      bannerAssetId: "",
      welcomeText: "Welcome to the speaker community.",
      supportUrl: "https://support.example.test/event",
    });
    expect(saved.changeSequence).toBeGreaterThan(0);
    await expect(
      service.saveDraft(admin, {
        revision: initial.draft.revision,
        accent: "#000000",
        logoAssetId: "",
        bannerAssetId: "",
        welcomeText: "Stale overwrite",
        supportUrl: "",
      }),
    ).rejects.toBeInstanceOf(EventBrandingRevisionConflictError);

    const uploaded = await service.uploadDraftAsset(admin, {
      kind: "logo",
      revision: saved.revision,
      file: new File([validPng], "event-logo.png", { type: "image/png" }),
    });
    expect(uploaded.changeSequence).toBeGreaterThan(0);
    const draft = await service.getWorkspace(admin);
    expect(draft).toMatchObject({
      hasUnpublishedChanges: true,
      draft: {
        accent: "#123abc",
        revision: uploaded.revision,
        welcomeText: "Welcome to the speaker community.",
        supportUrl: "https://support.example.test/event",
        logo: {
          id: uploaded.assetId,
          contentType: "image/webp",
          width: 1,
          height: 1,
          url: `/admin/branding/assets/${uploaded.assetId}`,
        },
      },
    });
    await expect(
      service.getPublishedAsset(initial.event.slug, "logo"),
    ).resolves.toBeNull();

    const firstPublication = await service.publish(admin, {
      revision: uploaded.revision,
      confirmed: "true",
    });
    expect(firstPublication.changeSequence).toBeGreaterThan(0);
    const published = await service.getWorkspace(admin);
    expect(published).toMatchObject({
      hasUnpublishedChanges: false,
      published: {
        accent: "#123abc",
        revision: uploaded.revision,
        logoAssetId: uploaded.assetId,
        logo: {
          url: `/public/brand/${initial.event.slug}/logo`,
        },
      },
    });
    const publicAsset = await service.getPublishedAsset(
      initial.event.slug,
      "logo",
    );
    expect(publicAsset).not.toBeNull();
    const response = await service.publishedAssetResponse(
      initial.event.slug,
      "logo",
      new Request(
        `https://events.example.test/public/brand/${initial.event.slug}/logo`,
      ),
    );
    expect(response).not.toBeNull();
    expect(response!.headers.get("content-type")).toBe("image/webp");
    expect(response!.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response!.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    const normalizedBytes = await response!.arrayBuffer();
    expect(normalizedBytes.byteLength).toBeGreaterThan(
      truncatedPngHeader.length,
    );
    await expect(
      testEnvironment.IMAGES.info(new Blob([normalizedBytes]).stream()),
    ).resolves.toMatchObject({ format: "image/webp", width: 1, height: 1 });
    const conditional = await service.publishedAssetResponse(
      initial.event.slug,
      "logo",
      new Request(
        `https://events.example.test/public/brand/${initial.event.slug}/logo`,
        { headers: { "if-none-match": response!.headers.get("etag")! } },
      ),
    );
    expect(conditional?.status).toBe(304);

    const changingPublication = vi
      .spyOn(service, "getPublishedAsset")
      .mockResolvedValueOnce(publicAsset)
      .mockResolvedValueOnce(null);
    await expect(
      service.publishedAssetResponse(
        initial.event.slug,
        "logo",
        new Request(
          `https://events.example.test/public/brand/${initial.event.slug}/logo`,
          { headers: { "if-none-match": response!.headers.get("etag")! } },
        ),
      ),
    ).rejects.toBeInstanceOf(EventBrandingAssetChangedError);
    changingPublication.mockRestore();

    const revisionBeforeRetry = await testEnvironment.DB.prepare(
      `SELECT revision, public_projection_revision AS publicRevision
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(admin.eventId, admin.organisationId)
      .first<{ revision: number; publicRevision: number }>();
    const repeatedPublication = await service.publish(admin, {
      revision: uploaded.revision,
      confirmed: "true",
    });
    expect(repeatedPublication).toEqual({
      revision: uploaded.revision,
      changeSequence: 0,
    });
    const revisionAfterRetry = await testEnvironment.DB.prepare(
      `SELECT revision, public_projection_revision AS publicRevision
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(admin.eventId, admin.organisationId)
      .first<{ revision: number; publicRevision: number }>();
    expect(revisionAfterRetry).toEqual(revisionBeforeRetry);
    const publicationAudits = await testEnvironment.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND action = 'event.branding.published'`,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(publicationAudits?.count).toBe(1);

    const event = await testEnvironment.DB.prepare(
      `SELECT brand_accent AS accent,
              participant_logo_url AS legacyLogoUrl,
              participant_welcome_text AS welcomeText,
              participant_support_url AS supportUrl,
              brand_logo_asset_id AS logoAssetId
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(admin.eventId, admin.organisationId)
      .first<{
        accent: string;
        legacyLogoUrl: string | null;
        welcomeText: string | null;
        supportUrl: string | null;
        logoAssetId: string | null;
      }>();
    expect(event).toEqual({
      accent: "#123abc",
      legacyLogoUrl: null,
      welcomeText: "Welcome to the speaker community.",
      supportUrl: "https://support.example.test/event",
      logoAssetId: uploaded.assetId,
    });
  });

  it("refuses image declarations whose bytes do not match", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const workspace = await service.getWorkspace(admin);

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "banner",
        revision: workspace.draft.revision,
        file: new File(["not an image"], "banner.png", {
          type: "image/png",
        }),
      }),
    ).rejects.toBeInstanceOf(EventBrandingAssetError);
  });

  it("rejects a truncated PNG signature prefix without storing an asset", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const workspace = await service.getWorkspace(admin);

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: workspace.draft.revision,
        file: new File([truncatedPngHeader], "truncated.png", {
          type: "image/png",
        }),
      }),
    ).rejects.toThrow("malformed, truncated or could not be normalized");
    await expect(
      testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_brand_assets WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("fails before storage when required image normalization is unavailable", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService({
      ...testEnvironment,
      IMAGES: undefined,
    } as unknown as CloudflareEnvironment);
    const workspace = await service.getWorkspace(admin);

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: workspace.draft.revision,
        file: new File([validPng], "logo.png", { type: "image/png" }),
      }),
    ).rejects.toThrow("Required image normalization is unavailable");
    await expect(
      testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_brand_assets WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("retains durable cleanup evidence when an ambiguous R2 write cannot be compensated", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const failedStorageEnvironment = {
      ...testEnvironment,
      FILES: {
        put: vi.fn().mockRejectedValue(new Error("ambiguous R2 write")),
        delete: vi.fn().mockRejectedValue(new Error("R2 cleanup unavailable")),
      } as unknown as R2Bucket,
    } as CloudflareEnvironment;
    const service = new EventBrandingService(failedStorageEnvironment);
    const workspace = await service.getWorkspace(admin);

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: workspace.draft.revision,
        file: new File([validPng], "logo.png", { type: "image/png" }),
      }),
    ).rejects.toThrow("Private storage failed");
    const cleanup = await testEnvironment.DB.prepare(
      `SELECT deleted_at AS deletedAt, cleanup_attempts AS cleanupAttempts,
              cleanup_last_error AS cleanupError, object_etag AS objectEtag
         FROM event_brand_assets WHERE event_id = ?`,
    )
      .bind(admin.eventId)
      .first<{
        deletedAt: number | null;
        cleanupAttempts: number;
        cleanupError: string | null;
        objectEtag: string;
      }>();
    expect(cleanup).toMatchObject({
      cleanupAttempts: 1,
      cleanupError: "R2 cleanup unavailable",
      objectEtag: "unknown-after-storage-error",
    });
    expect(cleanup?.deletedAt).not.toBeNull();
  });

  it("fails explicitly when neither object deletion nor durable cleanup evidence can be proven", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_cleanup_evidence_suppressed
       BEFORE INSERT ON event_brand_assets
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    const failedStorageEnvironment = {
      ...testEnvironment,
      FILES: {
        put: vi.fn().mockRejectedValue(new Error("ambiguous R2 write")),
        delete: vi.fn().mockRejectedValue(new Error("R2 cleanup unavailable")),
      } as unknown as R2Bucket,
    } as CloudflareEnvironment;
    const service = new EventBrandingService(failedStorageEnvironment);
    const workspace = await service.getWorkspace(admin);

    try {
      await expect(
        service.uploadDraftAsset(admin, {
          kind: "logo",
          revision: workspace.draft.revision,
          file: new File([validPng], "logo.png", { type: "image/png" }),
        }),
      ).rejects.toBeInstanceOf(EventBrandingCleanupIntegrityError);
      await expect(
        testEnvironment.DB.prepare(
          "SELECT 1 FROM event_brand_assets WHERE event_id = ?",
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toBeNull();
    } finally {
      await testEnvironment.DB.prepare(
        "DROP TRIGGER test_brand_cleanup_evidence_suppressed",
      ).run();
    }
  });

  it("retains referenced assets and retires superseded assets for cleanup", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);
    const first = await service.uploadDraftAsset(admin, {
      kind: "logo",
      revision: initial.draft.revision,
      file: new File([validPng], "first.png", { type: "image/png" }),
    });
    await service.publish(admin, {
      revision: first.revision,
      confirmed: "true",
    });
    const second = await service.uploadDraftAsset(admin, {
      kind: "logo",
      revision: first.revision,
      file: new File([validPng], "second.png", { type: "image/png" }),
    });
    const whilePublished = await testEnvironment.DB.prepare(
      "SELECT deleted_at AS deletedAt FROM event_brand_assets WHERE id = ?",
    )
      .bind(first.assetId)
      .first<{ deletedAt: number | null }>();
    expect(whilePublished?.deletedAt).toBeNull();

    await service.publish(admin, {
      revision: second.revision,
      confirmed: "true",
    });
    const retired = await testEnvironment.DB.prepare(
      `SELECT object_key AS objectKey, deleted_at AS deletedAt
         FROM event_brand_assets WHERE id = ?`,
    )
      .bind(first.assetId)
      .first<{ objectKey: string; deletedAt: number | null }>();
    expect(retired?.deletedAt).not.toBeNull();
    expect(await testEnvironment.FILES.head(retired!.objectKey)).not.toBeNull();

    const failedCleanupEnvironment = {
      ...testEnvironment,
      FILES: {
        delete: vi.fn().mockRejectedValue(new Error("R2 unavailable")),
      } as unknown as R2Bucket,
    } as CloudflareEnvironment;
    await expect(
      cleanupRetiredEventBrandAssets(failedCleanupEnvironment),
    ).resolves.toEqual({ examined: 1, deleted: 0, failed: 1 });
    await expect(
      testEnvironment.DB.prepare(
        `SELECT cleanup_attempts AS attempts, cleanup_last_error AS error
           FROM event_brand_assets WHERE id = ?`,
      )
        .bind(first.assetId)
        .first<{ attempts: number; error: string }>(),
    ).resolves.toEqual({ attempts: 1, error: "R2 unavailable" });

    await testEnvironment.DB.prepare(
      `UPDATE event_brand_assets
          SET cleanup_last_attempt_at = unixepoch() - 3600
        WHERE id = ?`,
    )
      .bind(first.assetId)
      .run();

    await expect(
      cleanupRetiredEventBrandAssets(testEnvironment),
    ).resolves.toEqual({
      examined: 1,
      deleted: 1,
      failed: 0,
    });
    expect(await testEnvironment.FILES.head(retired!.objectKey)).toBeNull();
    expect(
      await testEnvironment.DB.prepare(
        "SELECT 1 FROM event_brand_assets WHERE id = ?",
      )
        .bind(first.assetId)
        .first(),
    ).toBeNull();
  });

  it("does not record success evidence when an asset insert or event update is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);
    const auditBaseline = Number(
      (
        await testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND action = 'event.branding.asset_uploaded'`,
        )
          .bind(admin.eventId)
          .first<{ count: number }>()
      )?.count ?? 0,
    );

    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_asset_insert_suppressed
       BEFORE INSERT ON event_brand_assets
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: initial.draft.revision,
        file: new File([validPng], "suppressed.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(EventBrandingRevisionConflictError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_asset_insert_suppressed",
    ).run();

    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_event_update_suppressed
       BEFORE UPDATE OF brand_draft_logo_asset_id ON events
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: initial.draft.revision,
        file: new File([validPng], "suppressed-update.png", {
          type: "image/png",
        }),
      }),
    ).rejects.toBeInstanceOf(EventBrandingRevisionConflictError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_event_update_suppressed",
    ).run();

    const evidence = await testEnvironment.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM event_brand_assets WHERE event_id = ?) AS assets,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.asset_uploaded') AS audits,
         (SELECT COUNT(*) FROM event_changes
           WHERE event_id = ? AND entity_type = 'event_branding') AS changes`,
    )
      .bind(admin.eventId, admin.eventId, admin.eventId)
      .first<{ assets: number; audits: number; changes: number }>();
    expect(evidence).toEqual({
      assets: 0,
      audits: auditBaseline,
      changes: 0,
    });
  });

  it("reports a committed warning when only event-change evidence is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);
    const auditBaseline = Number(
      (
        await testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND action = 'event.branding.asset_uploaded'`,
        )
          .bind(admin.eventId)
          .first<{ count: number }>()
      )?.count ?? 0,
    );
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_change_suppressed
       BEFORE INSERT ON event_changes
       WHEN NEW.entity_type = 'event_branding'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: initial.draft.revision,
        file: new File([validPng], "missing-change.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(EventBrandingChangeCommitError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_change_suppressed",
    ).run();

    const evidence = await testEnvironment.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM event_brand_assets WHERE event_id = ? AND deleted_at IS NULL) AS assets,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.asset_uploaded') AS audits,
         (SELECT COUNT(*) FROM event_changes
           WHERE event_id = ? AND entity_type = 'event_branding') AS changes`,
    )
      .bind(admin.eventId, admin.eventId, admin.eventId)
      .first<{ assets: number; audits: number; changes: number }>();
    expect(evidence).toEqual({
      assets: 1,
      audits: auditBaseline + 1,
      changes: 0,
    });
  });

  it("reports a committed warning when only audit evidence is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);
    const auditBaseline = Number(
      (
        await testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND action = 'event.branding.asset_uploaded'`,
        )
          .bind(admin.eventId)
          .first<{ count: number }>()
      )?.count ?? 0,
    );
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_audit_suppressed
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'event.branding.asset_uploaded'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();

    await expect(
      service.uploadDraftAsset(admin, {
        kind: "logo",
        revision: initial.draft.revision,
        file: new File([validPng], "missing-audit.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(EventBrandingAuditCommitError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_audit_suppressed",
    ).run();

    const evidence = await testEnvironment.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM event_brand_assets
           WHERE event_id = ? AND deleted_at IS NULL) AS assets,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.asset_uploaded') AS audits,
         (SELECT COUNT(*) FROM event_changes
           WHERE event_id = ? AND entity_type = 'event_branding') AS changes,
         (SELECT COUNT(*) FROM events
           WHERE id = ? AND brand_draft_logo_asset_id IS NOT NULL) AS attached`,
    )
      .bind(admin.eventId, admin.eventId, admin.eventId, admin.eventId)
      .first<{
        assets: number;
        audits: number;
        changes: number;
        attached: number;
      }>();
    expect(evidence).toEqual({
      assets: 1,
      audits: auditBaseline,
      changes: 0,
      attached: 1,
    });
  });

  it("does not record save or publication success when their event mutation is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    const service = new EventBrandingService(testEnvironment);
    const initial = await service.getWorkspace(admin);
    const baseline = await testEnvironment.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.draft_saved') AS saves,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.published') AS publications`,
    )
      .bind(admin.eventId, admin.eventId)
      .first<{ saves: number; publications: number }>();

    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_save_suppressed
       BEFORE UPDATE OF brand_draft_accent ON events
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(
      service.saveDraft(admin, {
        revision: initial.draft.revision,
        accent: "#111111",
        logoAssetId: "",
        bannerAssetId: "",
        welcomeText: "",
        supportUrl: "",
      }),
    ).rejects.toBeInstanceOf(EventBrandingRevisionConflictError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_save_suppressed",
    ).run();

    const uploaded = await service.uploadDraftAsset(admin, {
      kind: "logo",
      revision: initial.draft.revision,
      file: new File([validPng], "publish-suppressed.png", {
        type: "image/png",
      }),
    });
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER test_brand_publish_suppressed
       BEFORE UPDATE OF brand_accent ON events
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(
      service.publish(admin, {
        revision: uploaded.revision,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(EventBrandingRevisionConflictError);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER test_brand_publish_suppressed",
    ).run();

    const after = await testEnvironment.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.draft_saved') AS saves,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'event.branding.published') AS publications`,
    )
      .bind(admin.eventId, admin.eventId)
      .first<{ saves: number; publications: number }>();
    expect(after).toEqual(baseline);
  });

  it("keeps deployed external branding live until the first managed publication", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    const demoEnvironment = {
      ...testEnvironment,
      APP_ENV: "demo",
      DEMO_MODE: "true",
    } as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(demoEnvironment);
    const legacyLogoUrl = "https://cdn.example.test/existing-event-logo.png";
    const legacyBannerUrl =
      "https://cdn.example.test/existing-programme-hero.png";
    await testEnvironment.DB.prepare(
      `UPDATE events
          SET participant_logo_url = ?, programme_hero_image_url = ?,
              brand_logo_asset_id = NULL,
              brand_draft_logo_asset_id = NULL
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(legacyLogoUrl, legacyBannerUrl, admin.eventId, admin.organisationId)
      .run();
    const programme = new PublicProgrammeService(demoEnvironment);
    await expect(
      programme.getPublished("future-of-events-2027"),
    ).resolves.toMatchObject({
      event: { logoUrl: legacyLogoUrl, heroImageUrl: legacyBannerUrl },
    });

    const service = new EventBrandingService(demoEnvironment);
    const workspace = await service.getWorkspace(admin);
    expect(workspace).toMatchObject({
      hasUnpublishedChanges: true,
      published: { legacyLogoUrl, legacyBannerUrl },
    });
    await service.publish(admin, {
      revision: workspace.draft.revision,
      confirmed: "true",
    });
    await expect(
      programme.getPublished("future-of-events-2027"),
    ).resolves.toMatchObject({
      event: { logoUrl: null, heroImageUrl: null },
    });
  });
});

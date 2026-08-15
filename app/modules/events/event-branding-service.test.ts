import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import {
  EventBrandingAssetError,
  EventBrandingAssetChangedError,
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

const pngHeader = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

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
      file: new File([pngHeader], "event-logo.png", { type: "image/png" }),
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
          contentType: "image/png",
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
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(response!.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response!.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(pngHeader);
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

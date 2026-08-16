import { describe, expect, it } from "vitest";

import {
  EVENT_BRAND_ASSET_DIMENSION_POLICY,
  eventBrandDraftInputSchema,
} from "./event-branding";
import {
  EventBrandImageNormalizationError,
  assertEventBrandImageDimensions,
} from "./event-brand-image-normalizer.server";
import { optionalCredentialFreeHttpsUrlSchema } from "./https-url";

describe("event branding rules", () => {
  it("rejects credential-bearing support URLs without rejecting explicit ports", () => {
    const base = {
      revision: 1,
      accent: "#123abc",
      logoAssetId: "",
      bannerAssetId: "",
      welcomeText: "",
    };
    expect(
      eventBrandDraftInputSchema.safeParse({
        ...base,
        supportUrl: "https://username:password@example.test/support",
      }).success,
    ).toBe(false);
    expect(
      eventBrandDraftInputSchema.safeParse({
        ...base,
        supportUrl: "https://example.test:8443/support",
      }).success,
    ).toBe(true);
  });

  it("provides the same credential-free HTTPS rule to legacy event input", () => {
    const schema = optionalCredentialFreeHttpsUrlSchema({
      invalidMessage: "invalid",
      httpsMessage: "https",
      credentialsMessage: "credentials",
      tooLongMessage: "long",
    });
    expect(schema.safeParse("http://example.test").success).toBe(false);
    expect(schema.safeParse("https://user@example.test").success).toBe(false);
    expect(schema.safeParse("https://example.test:444/help").success).toBe(
      true,
    );
    expect(() => schema.safeParse("not a URL")).not.toThrow();
    expect(schema.safeParse("not a URL").success).toBe(false);
  });

  it("enforces per-surface dimensions and decoded pixel counts", () => {
    expect(() =>
      assertEventBrandImageDimensions("logo", 2_048, 2_048),
    ).not.toThrow();
    expect(() =>
      assertEventBrandImageDimensions("banner", 4_096, 2_160),
    ).not.toThrow();
    expect(() => assertEventBrandImageDimensions("logo", 2_049, 1)).toThrow(
      EventBrandImageNormalizationError,
    );
    expect(() =>
      assertEventBrandImageDimensions(
        "banner",
        EVENT_BRAND_ASSET_DIMENSION_POLICY.banner.maximumWidth,
        EVENT_BRAND_ASSET_DIMENSION_POLICY.banner.maximumHeight + 1,
      ),
    ).toThrow(EventBrandImageNormalizationError);
    expect(() =>
      assertEventBrandImageDimensions("banner", 3_500, 2_600),
    ).toThrow(EventBrandImageNormalizationError);
  });
});

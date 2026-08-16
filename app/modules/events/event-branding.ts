import { z } from "zod";

import { optionalCredentialFreeHttpsUrlSchema } from "./https-url";

export const eventBrandAssetKindSchema = z.enum(["logo", "banner"]);
export type EventBrandAssetKind = z.infer<typeof eventBrandAssetKindSchema>;

const optionalAssetIdSchema = z
  .union([z.literal(""), z.string().trim().min(1).max(160)])
  .transform((value) => value || null);

const optionalSupportUrlSchema = optionalCredentialFreeHttpsUrlSchema({
  invalidMessage: "Enter a valid support URL.",
  httpsMessage: "Support URLs must use HTTPS.",
  credentialsMessage: "Support URLs cannot contain a username or password.",
  tooLongMessage: "Support URL is too long.",
}).transform((value) => value || null);

export const eventBrandDraftInputSchema = z.object({
  revision: z.coerce.number().int().positive(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Choose a valid brand colour.")
    .transform((value) => value.toLowerCase()),
  logoAssetId: optionalAssetIdSchema,
  bannerAssetId: optionalAssetIdSchema,
  welcomeText: z
    .string()
    .trim()
    .max(500, "Welcome message must be 500 characters or fewer.")
    .transform((value) => value || null),
  supportUrl: optionalSupportUrlSchema,
});

export const eventBrandPublishInputSchema = z.object({
  revision: z.coerce.number().int().positive(),
  confirmed: z.literal("true", {
    error: "Confirm the affected public surfaces before publishing.",
  }),
});

export const EVENT_BRAND_ASSET_MAXIMUM_BYTES = {
  logo: 2 * 1_048_576,
  banner: 5 * 1_048_576,
} as const satisfies Record<EventBrandAssetKind, number>;

export const EVENT_BRAND_ASSET_DIMENSION_POLICY = {
  logo: { maximumWidth: 2_048, maximumHeight: 2_048, maximumPixels: 4_194_304 },
  banner: {
    maximumWidth: 4_096,
    maximumHeight: 2_160,
    maximumPixels: 9_000_000,
  },
} as const satisfies Record<
  EventBrandAssetKind,
  { maximumWidth: number; maximumHeight: number; maximumPixels: number }
>;

export const EVENT_BRAND_IMAGE_NORMALIZER_VERSION = "cloudflare-images-webp-v1";

export function publicEventBrandAssetPath(
  slug: string,
  kind: EventBrandAssetKind,
) {
  return `/public/brand/${encodeURIComponent(slug)}/${kind}`;
}

export function adminEventBrandAssetPath(assetId: string) {
  return `/admin/branding/assets/${encodeURIComponent(assetId)}`;
}

import {
  EVENT_BRAND_ASSET_DIMENSION_POLICY,
  EVENT_BRAND_ASSET_MAXIMUM_BYTES,
  EVENT_BRAND_IMAGE_NORMALIZER_VERSION,
  type EventBrandAssetKind,
} from "./event-branding";

const supportedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
type SupportedInputContentType = "image/jpeg" | "image/png" | "image/webp";

export class EventBrandImageNormalizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventBrandImageNormalizationError";
  }
}

export type NormalizedEventBrandImage = {
  bytes: ArrayBuffer;
  contentType: "image/webp";
  width: number;
  height: number;
  normalizerVersion: typeof EVENT_BRAND_IMAGE_NORMALIZER_VERSION;
};

export function assertEventBrandImageDimensions(
  kind: EventBrandAssetKind,
  width: number,
  height: number,
) {
  const policy = EVENT_BRAND_ASSET_DIMENSION_POLICY[kind];
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > policy.maximumWidth ||
    height > policy.maximumHeight ||
    width * height > policy.maximumPixels
  ) {
    const label = kind === "logo" ? "Logo" : "Banner";
    throw new EventBrandImageNormalizationError(
      `${label} images must be no larger than ${policy.maximumWidth} × ${policy.maximumHeight} pixels and ${policy.maximumPixels.toLocaleString("en-US")} total pixels.`,
    );
  }
}

function supportedContentType(
  value: string,
): value is SupportedInputContentType {
  return supportedContentTypes.has(value);
}

export async function normalizeEventBrandImage({
  images,
  kind,
  file,
  detectedContentType,
}: {
  images: ImagesBinding;
  kind: EventBrandAssetKind;
  file: File;
  detectedContentType: string;
}): Promise<NormalizedEventBrandImage> {
  if (!supportedContentType(detectedContentType)) {
    throw new EventBrandImageNormalizationError(
      "Brand images must decode as JPEG, PNG or WebP files.",
    );
  }

  try {
    const source = await images.info(file.stream());
    if (!("width" in source) || source.format !== detectedContentType) {
      throw new EventBrandImageNormalizationError(
        "The brand image contents do not match its detected file type.",
      );
    }
    assertEventBrandImageDimensions(kind, source.width, source.height);

    const transformed = await images
      .input(file.stream())
      .output({ format: "image/webp", quality: 90, anim: false });
    const contentType = transformed.contentType();
    if (contentType !== "image/webp") {
      throw new EventBrandImageNormalizationError(
        "Image normalization returned an unexpected file type.",
      );
    }
    const bytes = await new Response(transformed.image()).arrayBuffer();
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > EVENT_BRAND_ASSET_MAXIMUM_BYTES[kind]
    ) {
      throw new EventBrandImageNormalizationError(
        `The normalized ${kind} image exceeds the ${EVENT_BRAND_ASSET_MAXIMUM_BYTES[kind] / 1_048_576} MB limit.`,
      );
    }

    const normalized = await images.info(new Blob([bytes]).stream());
    if (!("width" in normalized) || normalized.format !== "image/webp") {
      throw new EventBrandImageNormalizationError(
        "The normalized brand image could not be verified.",
      );
    }
    assertEventBrandImageDimensions(kind, normalized.width, normalized.height);
    return {
      bytes,
      contentType,
      width: normalized.width,
      height: normalized.height,
      normalizerVersion: EVENT_BRAND_IMAGE_NORMALIZER_VERSION,
    };
  } catch (error) {
    if (error instanceof EventBrandImageNormalizationError) throw error;
    throw new EventBrandImageNormalizationError(
      "The brand image is malformed, truncated or could not be normalized.",
      { cause: error },
    );
  }
}

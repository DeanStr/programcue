import { z } from "zod";

import { optionalCredentialFreeHttpsUrlSchema } from "~/modules/events/https-url";

export const PUBLIC_SITE_SECTION_TYPES = [
  "introduction",
  "featured_speakers",
  "featured_sessions",
  "statistics",
  "venue",
  "faq",
] as const;

export const PUBLIC_SITE_PAGE_TYPES = [
  "about",
  "faq",
  "venue",
  "code-of-conduct",
  "sponsors",
] as const;

export const PUBLIC_EVENT_NAVIGATION_LABELS = {
  home: "Event home",
  sessions: "Programme",
  speakers: "Speakers",
  schedule: "Schedule",
  gallery: "Speaker Gallery",
  itinerary: "My itinerary",
  sharedItinerary: "Shared itinerary",
} as const;

export type PublicSiteSectionType = (typeof PUBLIC_SITE_SECTION_TYPES)[number];
export type PublicSitePageType = (typeof PUBLIC_SITE_PAGE_TYPES)[number];

const boundedText = (maximum: number, message: string) =>
  z.string().trim().max(maximum, message);

function credentialFreeHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

const restrictedMarkdown = (maximum: number, lengthMessage: string) =>
  boundedText(maximum, lengthMessage).superRefine((value, context) => {
    const markdownLink = /\[[^\]\r\n]+\]\(([^)]*)\)/gu;
    for (const match of value.matchAll(markdownLink)) {
      const rawTarget = match[1] ?? "";
      const target = rawTarget.trim();
      if (target !== rawTarget || !credentialFreeHttpsUrl(target)) {
        context.addIssue({
          code: "custom",
          message: "Markdown links must use a credential-free HTTPS URL.",
        });
      }
    }
  });

const recordIdSchema = z.string().trim().min(1).max(160);
const commandIdSchema = z.uuid(
  "Refresh before retrying this public-site action.",
);
const uniqueIdsSchema = z
  .array(recordIdSchema)
  .max(12)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Selections must be unique.",
  );

const sectionOrderSchema = z
  .array(z.enum(PUBLIC_SITE_SECTION_TYPES))
  .length(PUBLIC_SITE_SECTION_TYPES.length)
  .refine(
    (sections) => new Set(sections).size === PUBLIC_SITE_SECTION_TYPES.length,
    "Homepage sections must appear exactly once.",
  );

const sectionVisibilitySchema = z.object({
  introduction: z.boolean(),
  featured_speakers: z.boolean(),
  featured_sessions: z.boolean(),
  statistics: z.boolean(),
  venue: z.boolean(),
  faq: z.boolean(),
});

export const publicSiteFaqItemSchema = z.object({
  id: recordIdSchema,
  question: boundedText(
    180,
    "FAQ questions must be 180 characters or fewer.",
  ).pipe(z.string().min(1, "Enter an FAQ question.")),
  answer: restrictedMarkdown(
    2_000,
    "FAQ answers must be 2,000 characters or fewer.",
  ).pipe(z.string().min(1, "Enter an FAQ answer.")),
});

const publicSitePageSchema = z.object({
  enabled: z.boolean(),
  title: boundedText(100, "Page titles must be 100 characters or fewer.").pipe(
    z.string().min(1, "Enter a page title."),
  ),
  navigationLabel: boundedText(
    40,
    "Navigation labels must be 40 characters or fewer.",
  ).pipe(z.string().min(1, "Enter a navigation label.")),
  body: restrictedMarkdown(
    8_000,
    "Page content must be 8,000 characters or fewer.",
  ),
});

const reservedNavigationLabels = new Set(
  [
    ...Object.values(PUBLIC_EVENT_NAVIGATION_LABELS),
    "Timetable",
    "Day-by-day",
    "Day-by-day schedule",
  ].map((label) => label.toLocaleLowerCase("en-US")),
);

const publicSitePagesSchema = z
  .object({
    about: publicSitePageSchema,
    faq: publicSitePageSchema,
    venue: publicSitePageSchema,
    "code-of-conduct": publicSitePageSchema,
    sponsors: publicSitePageSchema,
  })
  .superRefine((pages, context) => {
    const labels = new Set(reservedNavigationLabels);
    for (const page of PUBLIC_SITE_PAGE_TYPES) {
      const configuration = pages[page];
      if (!configuration.enabled) continue;
      const label = configuration.navigationLabel.toLocaleLowerCase("en-US");
      if (labels.has(label)) {
        context.addIssue({
          code: "custom",
          path: [page, "navigationLabel"],
          message:
            "Enabled page navigation labels must be unique and cannot use an event navigation label.",
        });
      }
      labels.add(label);
    }
  });

export const publicSiteDraftSchema = z.object({
  schemaVersion: z.literal(1),
  tagline: boundedText(180, "Tagline must be 180 characters or fewer."),
  theme: z.enum(["light", "dark", "system"]),
  sectionOrder: sectionOrderSchema,
  sectionVisibility: sectionVisibilitySchema,
  introductionHeading: boundedText(
    100,
    "Introduction heading must be 100 characters or fewer.",
  ).pipe(z.string().min(1, "Enter an introduction heading.")),
  featuredSpeakerIds: uniqueIdsSchema,
  featuredSessionIds: uniqueIdsSchema,
  statisticVisibility: z.object({
    sessions: z.boolean(),
    speakers: z.boolean(),
    tracks: z.boolean(),
    days: z.boolean(),
  }),
  faqItems: z
    .array(publicSiteFaqItemSchema)
    .max(12, "A public event site can contain at most 12 FAQ entries."),
  pages: publicSitePagesSchema,
  postEvent: z.object({
    enabled: z.boolean(),
    heading: boundedText(
      120,
      "Post-event heading must be 120 characters or fewer.",
    ),
    body: restrictedMarkdown(
      2_000,
      "Post-event copy must be 2,000 characters or fewer.",
    ),
  }),
});

export type PublicSiteDraft = z.infer<typeof publicSiteDraftSchema>;

const sponsorWebsiteUrlSchema = optionalCredentialFreeHttpsUrlSchema({
  invalidMessage: "Enter a valid sponsor website URL.",
  httpsMessage: "Sponsor website URLs must use HTTPS.",
  credentialsMessage: "Sponsor website URLs cannot contain credentials.",
  tooLongMessage: "Sponsor website URL is too long.",
});

const sponsorLogoUrlSchema = optionalCredentialFreeHttpsUrlSchema({
  invalidMessage: "Enter a valid sponsor logo URL.",
  httpsMessage: "Sponsor logo URLs must use HTTPS.",
  credentialsMessage: "Sponsor logo URLs cannot contain credentials.",
  tooLongMessage: "Sponsor logo URL is too long.",
});

const sponsorNameSchema = boundedText(
  120,
  "Sponsor name must be 120 characters or fewer.",
).pipe(z.string().min(1, "Enter a sponsor name."));

const sponsorTierSchema = boundedText(
  80,
  "Sponsor tier must be 80 characters or fewer.",
).pipe(z.string().min(1, "Enter a sponsor tier."));

const sponsorDescriptionSchema = boundedText(
  1_000,
  "Sponsor descriptions must be 1,000 characters or fewer.",
);

export const publishedPublicSiteSponsorSchema = z
  .object({
    id: recordIdSchema,
    name: sponsorNameSchema,
    tier: sponsorTierSchema,
    websiteUrl: sponsorWebsiteUrlSchema.nullable(),
    logoUrl: sponsorLogoUrlSchema.nullable(),
    description: sponsorDescriptionSchema.nullable(),
    position: z.number().int().min(0).max(1_000),
  })
  .strict();

export const sponsorInputSchema = z.object({
  commandId: commandIdSchema,
  id: z
    .union([z.literal(""), recordIdSchema])
    .transform((value) => value || null),
  revision: z.coerce.number().int().nonnegative(),
  name: sponsorNameSchema,
  tier: sponsorTierSchema,
  websiteUrl: sponsorWebsiteUrlSchema.transform((value) => value || null),
  logoUrl: sponsorLogoUrlSchema.transform((value) => value || null),
  description: sponsorDescriptionSchema.transform((value) => value || null),
  position: z.coerce.number().int().min(0).max(1_000),
});

const externalRecordingUrlSchema = optionalCredentialFreeHttpsUrlSchema({
  invalidMessage: "Enter a valid HTTPS URL.",
  httpsMessage: "Recording URLs must use HTTPS.",
  credentialsMessage: "Recording URLs cannot contain credentials.",
  tooLongMessage: "Recording URL is too long.",
});

export const recordingDraftInputSchema = z.object({
  commandId: commandIdSchema,
  id: z
    .union([z.literal(""), recordIdSchema])
    .transform((value) => value || null),
  sessionId: recordIdSchema,
  revision: z.coerce.number().int().nonnegative(),
  title: boundedText(
    160,
    "Recording titles must be 160 characters or fewer.",
  ).pipe(z.string().min(1, "Enter a recording title.")),
  recordingUrl: externalRecordingUrlSchema.pipe(
    z.string().min(1, "Enter the external recording URL."),
  ),
  captionsUrl: externalRecordingUrlSchema.transform((value) => value || null),
  transcriptUrl: externalRecordingUrlSchema.transform((value) => value || null),
});

export const revisionInputSchema = z.object({
  commandId: commandIdSchema,
  id: recordIdSchema,
  revision: z.coerce.number().int().positive(),
  confirmed: z.literal("true", { error: "Confirm this publication." }),
});

export const sitePublishInputSchema = z.object({
  commandId: commandIdSchema,
  revision: z.coerce.number().int().positive(),
  confirmed: z.literal("true", { error: "Confirm the affected public pages." }),
});

// The closed draft schema permits roughly 75,000 string characters. JSON can
// encode one JavaScript character as six characters (for example, `\u0000`),
// so this guard allows every field-valid draft while still rejecting an
// unreasonably large request before JSON parsing.
export const PUBLIC_SITE_CONFIGURATION_JSON_MAX_LENGTH = 512_000;

export const siteSaveInputSchema = z.object({
  commandId: commandIdSchema,
  revision: z.coerce.number().int().nonnegative(),
  configurationJson: z
    .string()
    .max(
      PUBLIC_SITE_CONFIGURATION_JSON_MAX_LENGTH,
      "Site configuration exceeds the supported size.",
    )
    .transform((value, context) => {
      try {
        return publicSiteDraftSchema.parse(JSON.parse(value));
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "Site configuration is invalid.",
        });
        return z.NEVER;
      }
    }),
});

export type PublicSiteSponsor = {
  id: string;
  name: string;
  tier: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  position: number;
  revision: number;
};

export type PublicSiteRecording = {
  id: string;
  sessionId: string;
  title: string;
  recordingUrl: string;
  captionsUrl: string | null;
  transcriptUrl: string | null;
  revision: number;
  publishedRevision: number | null;
  publishedAt: number | null;
};

export const publishedPublicSiteSnapshotSchema = publicSiteDraftSchema
  .extend({
    sponsors: z.array(publishedPublicSiteSponsorSchema),
  })
  .strict();

export type PublishedPublicSiteSnapshot = z.infer<
  typeof publishedPublicSiteSnapshotSchema
>;

export function publicSiteUsesD1ProgrammeFeatures(
  configuration: PublicSiteDraft,
) {
  return (
    configuration.sectionVisibility.featured_sessions ||
    configuration.sectionVisibility.featured_speakers ||
    configuration.featuredSessionIds.length > 0 ||
    configuration.featuredSpeakerIds.length > 0 ||
    configuration.postEvent.enabled
  );
}

export function defaultPublicSiteDraft(): PublicSiteDraft {
  return {
    schemaVersion: 1,
    tagline: "",
    theme: "system",
    sectionOrder: [...PUBLIC_SITE_SECTION_TYPES],
    sectionVisibility: {
      introduction: true,
      featured_speakers: false,
      featured_sessions: false,
      statistics: true,
      venue: true,
      faq: false,
    },
    introductionHeading: "About the event",
    featuredSpeakerIds: [],
    featuredSessionIds: [],
    statisticVisibility: {
      sessions: true,
      speakers: true,
      tracks: true,
      days: true,
    },
    faqItems: [],
    pages: {
      about: {
        enabled: false,
        title: "About",
        navigationLabel: "About",
        body: "",
      },
      faq: {
        enabled: false,
        title: "Frequently asked questions",
        navigationLabel: "FAQ",
        body: "",
      },
      venue: {
        enabled: false,
        title: "Venue",
        navigationLabel: "Venue",
        body: "",
      },
      "code-of-conduct": {
        enabled: false,
        title: "Code of conduct",
        navigationLabel: "Code of conduct",
        body: "",
      },
      sponsors: {
        enabled: false,
        title: "Sponsors",
        navigationLabel: "Sponsors",
        body: "",
      },
    },
    postEvent: {
      enabled: false,
      heading: "Watch the event on demand",
      body: "Explore published recordings from the programme.",
    },
  };
}

export function parsePublicSiteDraft(value: string): PublicSiteDraft {
  return publicSiteDraftSchema.parse(JSON.parse(value));
}

export function parsePublishedPublicSiteSnapshot(
  value: string,
): PublishedPublicSiteSnapshot {
  return publishedPublicSiteSnapshotSchema.parse(JSON.parse(value));
}

import { defaultProgrammeEmbedConfiguration } from "~/modules/programme/programme-embed-configuration";
import {
  defaultPublicSiteDraft,
  type PublicSiteDraft,
  type PublishedPublicSiteSnapshot,
  publicSiteDraftSchema,
  publishedPublicSiteSnapshotSchema,
} from "~/modules/public-site/public-site";
import { DEMO_IDENTITIES } from "~/platform/demo/demo-identities";

export const DEMO_EVALUATION_RESET_CONFIRMATION = "clear-abstract-evaluation";

export const DEMO_REMINDER_TEMPLATE_ID = "4eb07b55-60fe-4fd4-aab5-56a171283335";
export const DEMO_REMINDER_VERSION_ID = "c4be71b7-cf55-4e8a-ac28-73f2c83bde42";
export const DEMO_REVIEWER_REMINDER_TEMPLATE_ID =
  "cf82ad49-991e-40dd-896d-7b45b288d16f";
export const DEMO_REVIEWER_REMINDER_VERSION_ID =
  "2a37e49b-95ca-4383-8c58-720c2e681bab";
export const DEMO_SPEAKER_WELCOME_TEMPLATE_ID =
  "b5fa9880-c53b-49a9-8d30-dd6585089c41";
export const DEMO_SPEAKER_WELCOME_VERSION_ID =
  "73e3200d-ec06-4d11-a87f-bce1543b7c21";
export const DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID =
  "353b1640-8e96-4f52-a657-9407ddf551fb";
export const DEMO_SUBMISSION_CONFIRMATION_VERSION_ID =
  "7d527639-cf8c-4886-a490-c09d8019310f";
export const DEMO_DECISION_TEMPLATE_ID = "572ae193-24e3-4746-b148-4757f54f83bd";
export const DEMO_DECISION_VERSION_ID = "95e1b191-434c-4be1-acb8-915f435f561f";
export const DEMO_DECISION_SENDER_ID = "sender-demo-decision-notifications";
export const DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP = Math.floor(
  Date.parse("2026-08-01T12:00:00Z") / 1_000,
);
export const DEMO_SHOWCASE_SUBMISSION_ID = "demo-evaluation-submission-calm";
export const DEMO_SHOWCASE_ROUND_ID = "demo-evaluation-round";
export const DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID =
  "demo-evaluation-assignment-1";
export const DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID =
  "demo-showcase-assignment-chair-calm";
export const DEMO_SHOWCASE_POSITIVE_REVIEW_ID = "demo-showcase-review-positive";
export const DEMO_SHOWCASE_CRITICAL_REVIEW_ID = "demo-showcase-review-critical";
export const DEMO_SHOWCASE_DISCUSSION_ID = "demo-showcase-discussion-1";
export const DEMO_SHOWCASE_DECISION_ID = "demo-showcase-decision-waitlist";
export const DEMO_SHOWCASE_PROFILE_REVISION_ID =
  "demo-showcase-profile-revision-1";
export const DEMO_SHOWCASE_EMBED_ID = "demo-showcase-embed-main-agenda";
export const DEMO_SHOWCASE_TIMESTAMP = Math.floor(
  Date.parse("2026-08-04T14:00:00Z") / 1_000,
);
export const DEMO_SHOWCASE_EMBED_CONFIGURATION = {
  ...defaultProgrammeEmbedConfiguration(),
  surface: "schedule" as const,
  density: "compact" as const,
  showSpeakerDirectory: false,
};
export const DEMO_SHOWCASE_FEATURED_SESSION_IDS = [
  "demo-session-1",
  "demo-session-2",
] as const;
export const DEMO_SHOWCASE_FEATURED_SPEAKER_IDS = [
  DEMO_IDENTITIES.speaker.personId,
  DEMO_IDENTITIES.submitter.personId,
] as const;
export const DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE =
  "One destination for the whole event.";
export const DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID =
  "demo-showcase:public-site-publish";
export const DEMO_SHOWCASE_FAQ_WHEN_ID = "demo-showcase-faq-when";
export const DEMO_SHOWCASE_FAQ_APPLY_ID = "demo-showcase-faq-apply";
export const DEMO_SHOWCASE_SPONSOR_PARTNER_ID = "demo-showcase-sponsor-partner";
export const DEMO_SHOWCASE_SPONSOR_COMMUNITY_ID =
  "demo-showcase-sponsor-community";
export const DEMO_SHOWCASE_SPONSOR_PARTNER_OPERATION_ID =
  "demo-showcase:sponsor-partner";
export const DEMO_SHOWCASE_SPONSOR_COMMUNITY_OPERATION_ID =
  "demo-showcase:sponsor-community";
export const DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID =
  "audit-demo-showcase-public-site-published";

export const DEMO_SHOWCASE_SITE_SPONSORS = [
  {
    id: DEMO_SHOWCASE_SPONSOR_PARTNER_ID,
    name: "Northstar Events",
    tier: "Partner",
    websiteUrl: null,
    logoUrl: null,
    description: null,
    position: 0,
    operationId: DEMO_SHOWCASE_SPONSOR_PARTNER_OPERATION_ID,
  },
  {
    id: DEMO_SHOWCASE_SPONSOR_COMMUNITY_ID,
    name: "EventLab",
    tier: "Community",
    websiteUrl: null,
    logoUrl: null,
    description: null,
    position: 1,
    operationId: DEMO_SHOWCASE_SPONSOR_COMMUNITY_OPERATION_ID,
  },
] as const;

export function demoShowcasePublicSiteDraft(): PublicSiteDraft {
  const draft = defaultPublicSiteDraft();
  return publicSiteDraftSchema.parse({
    ...draft,
    tagline: DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE,
    theme: "light",
    sectionVisibility: {
      ...draft.sectionVisibility,
      featured_speakers: true,
      featured_sessions: true,
      faq: true,
    },
    featuredSpeakerIds: [...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS],
    featuredSessionIds: [...DEMO_SHOWCASE_FEATURED_SESSION_IDS],
    faqItems: [
      {
        id: DEMO_SHOWCASE_FAQ_WHEN_ID,
        question: "When does the conference take place?",
        answer:
          "20–22 May 2027 at the Metro Toronto Convention Centre in Toronto.",
      },
      {
        id: DEMO_SHOWCASE_FAQ_APPLY_ID,
        question: "How do I apply to speak?",
        answer:
          "Use Apply to speak on this site while the call for speakers is open.",
      },
    ],
    pages: {
      ...draft.pages,
      about: {
        enabled: true,
        title: "About",
        navigationLabel: "About",
        body: "## Why attend\n\nMeet practitioners building calmer, more useful event operations.",
      },
      sponsors: {
        enabled: true,
        title: "Sponsors",
        navigationLabel: "Sponsors",
        body: "Thanks to the organisations supporting this event.",
      },
    },
  });
}

export function demoShowcasePublishedSponsors() {
  return [...DEMO_SHOWCASE_SITE_SPONSORS]
    .map(({ operationId: _operationId, ...sponsor }) => sponsor)
    .sort((left, right) => {
      const tier = left.tier.localeCompare(right.tier, "en", {
        sensitivity: "base",
      });
      if (tier !== 0) return tier;
      if (left.position !== right.position)
        return left.position - right.position;
      const name = left.name.localeCompare(right.name, "en", {
        sensitivity: "base",
      });
      if (name !== 0) return name;
      return left.id.localeCompare(right.id);
    });
}

export function demoShowcasePublishedPublicSite(): PublishedPublicSiteSnapshot {
  return publishedPublicSiteSnapshotSchema.parse({
    ...demoShowcasePublicSiteDraft(),
    sponsors: demoShowcasePublishedSponsors(),
  });
}

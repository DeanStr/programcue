import { publicSiteSectionLabels } from "~/components/admin-public-site-constants";
import { eventLocalExclusiveEndEpoch } from "~/modules/schedule/schedule-time";
import {
  defaultPublicSiteDraft,
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
  type PublicSiteSponsor,
  type PublishedPublicSiteSnapshot,
} from "./public-site";

const THEME_LABELS: Record<PublicSiteDraft["theme"], string> = {
  system: "Follow visitor system",
  light: "Light",
  dark: "Dark",
};

function changedList(label: string, before: string[], after: string[]) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((value) => !beforeSet.has(value));
  const removed = before.filter((value) => !afterSet.has(value));
  return [
    ...(added.length ? [`${label} added: ${added.join(", ")}`] : []),
    ...(removed.length ? [`${label} removed: ${removed.join(", ")}`] : []),
  ];
}

function enabledSections(configuration: PublicSiteDraft) {
  return configuration.sectionOrder
    .filter((section) => configuration.sectionVisibility[section])
    .map((section) => publicSiteSectionLabels[section]);
}

function enabledPages(configuration: PublicSiteDraft) {
  return PUBLIC_SITE_PAGE_TYPES.filter(
    (page) => configuration.pages[page].enabled,
  ).map((page) => configuration.pages[page].title);
}

function unpublishedComparisonSnapshot(
  draft: PublicSiteDraft,
): PublishedPublicSiteSnapshot {
  return {
    ...draft,
    sectionVisibility: {
      introduction: false,
      featured_speakers: false,
      featured_sessions: false,
      statistics: false,
      venue: false,
      faq: false,
    },
    featuredSpeakerIds: [],
    featuredSessionIds: [],
    pages: {
      about: { ...draft.pages.about, enabled: false },
      faq: { ...draft.pages.faq, enabled: false },
      venue: { ...draft.pages.venue, enabled: false },
      "code-of-conduct": { ...draft.pages["code-of-conduct"], enabled: false },
      sponsors: { ...draft.pages.sponsors, enabled: false },
    },
    sponsors: [],
  };
}

function faqIsPublic(draft: PublicSiteDraft) {
  return draft.sectionVisibility.faq || draft.pages.faq.enabled;
}

export function recordingsArePubliclyRenderable(input: {
  hasPublishedRecording: boolean;
  eventEndsAt: number;
  eventTimezone: string;
  now: number;
}) {
  return (
    input.hasPublishedRecording &&
    input.now >=
      eventLocalExclusiveEndEpoch(input.eventEndsAt, input.eventTimezone)
  );
}

function hasPublishableEditorial(
  draft: PublicSiteDraft,
  hasRenderableRecordings: boolean,
) {
  const defaults = defaultPublicSiteDraft();
  return Boolean(
    draft.tagline.trim() ||
      (draft.sectionVisibility.introduction &&
        draft.introductionHeading.trim() &&
        draft.introductionHeading !== defaults.introductionHeading) ||
      (draft.sectionVisibility.statistics &&
        JSON.stringify(draft.statisticVisibility) !==
          JSON.stringify(defaults.statisticVisibility)) ||
      (faqIsPublic(draft) && draft.faqItems.length) ||
      PUBLIC_SITE_PAGE_TYPES.some(
        (page) => draft.pages[page].enabled && draft.pages[page].body.trim(),
      ) ||
      (draft.postEvent.enabled &&
        hasRenderableRecordings &&
        (draft.postEvent.heading.trim() || draft.postEvent.body.trim())),
  );
}

export function publicationChangeSummary(input: {
  draft: PublicSiteDraft;
  sponsors: PublicSiteSponsor[];
  published: { configuration: PublishedPublicSiteSnapshot } | null;
  speakerNames: Map<string, string>;
  sessionNames: Map<string, string>;
  hasRenderableRecordings?: boolean;
}) {
  const firstPublish = input.published === null;
  const before =
    input.published?.configuration ??
    unpublishedComparisonSnapshot(input.draft);
  const names = (ids: string[], labels: Map<string, string>) =>
    ids.map((id) => labels.get(id) ?? id);
  const nextSponsors = input.sponsors.map((sponsor) => sponsor.name);
  const changes = [
    ...changedList(
      "Sections",
      enabledSections(before),
      enabledSections(input.draft),
    ),
    ...changedList("Pages", enabledPages(before), enabledPages(input.draft)),
    ...changedList(
      "Featured speakers",
      names(before.featuredSpeakerIds, input.speakerNames),
      names(input.draft.featuredSpeakerIds, input.speakerNames),
    ),
    ...changedList(
      "Featured sessions",
      names(before.featuredSessionIds, input.sessionNames),
      names(input.draft.featuredSessionIds, input.sessionNames),
    ),
    ...changedList(
      "Sponsors",
      before.sponsors.map((sponsor) => sponsor.name),
      nextSponsors,
    ),
  ];
  if (firstPublish) {
    changes.push(`Theme: ${THEME_LABELS[input.draft.theme]}`);
  } else if (before.theme !== input.draft.theme) {
    changes.push(
      `Theme: ${THEME_LABELS[before.theme]} → ${THEME_LABELS[input.draft.theme]}`,
    );
  }
  if (
    !firstPublish &&
    before.sectionOrder.join("\n") !== input.draft.sectionOrder.join("\n")
  ) {
    changes.push("Homepage section order changed.");
  }
  if (firstPublish) {
    if (
      hasPublishableEditorial(
        input.draft,
        input.hasRenderableRecordings === true,
      )
    ) {
      changes.push("Editorial homepage content will be published.");
    }
  } else {
    const { sponsors: _sponsors, ...beforeEditorial } = before;
    if (JSON.stringify(beforeEditorial) !== JSON.stringify(input.draft)) {
      changes.push("Homepage or fixed-page editorial content changed.");
    }
  }
  if (!firstPublish) {
    const beforeSponsors = new Map(
      before.sponsors.map((sponsor) => [sponsor.id, sponsor]),
    );
    const updatedSponsors = input.sponsors
      .filter((sponsor) => {
        const prior = beforeSponsors.get(sponsor.id);
        if (!prior) return false;
        const { revision: _revision, ...next } = sponsor;
        return JSON.stringify(prior) !== JSON.stringify(next);
      })
      .map((sponsor) => sponsor.name);
    if (updatedSponsors.length) {
      changes.push(`Sponsors updated: ${updatedSponsors.join(", ")}`);
    }
  }
  return changes.length ? changes : ["No public content changes detected."];
}

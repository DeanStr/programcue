import { defaultProgrammeEmbedConfiguration } from "~/modules/programme/programme-embed-configuration";
import {
  defaultPublicSiteDraft,
  PUBLIC_SITE_PAGE_TYPES,
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
/* One generation identity for the seeded public site, bumped together whenever
   the fixture's content changes. The seed inserts on OR IGNORE and guards the
   sponsor and reference rows on this operation id, so a database still holding
   the previous generation must not answer to the current one: without the
   bump, a stale site row passes the guard and collects the new sponsors beside
   its old ones. The audit id moves with it because audit history survives the
   reset and is append-only — the old row stays as a true record of what the
   previous fixture published, and the new generation writes its own. */
export const DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID =
  "demo-showcase:public-site-publish-3";
export const DEMO_SHOWCASE_FAQ_ITEMS = [
  {
    id: "demo-showcase-faq-when",
    question: "When and where does the conference take place?",
    answer:
      "Thursday 20 May to Saturday 22 May 2027 at the Metro Toronto Convention Centre, 255 Front Street West, Toronto. Doors open at 08:00 each day and the first sessions start from 09:00.",
  },
  {
    id: "demo-showcase-faq-included",
    question: "What does a ticket include?",
    answer:
      "Every session across all four tracks, lunch and refreshments on all three days, the Thursday evening reception, and access to the recording library as recorded sessions are published.",
  },
  {
    id: "demo-showcase-faq-apply",
    question: "How do I apply to speak?",
    answer:
      "Use **Apply to speak** on this site while the call for speakers is open. You will need a session title, a short description and a note on what an attendee should be able to do afterwards. You do not need slides or a finished outline to apply.",
  },
  {
    id: "demo-showcase-faq-selection",
    question: "How are sessions selected?",
    answer:
      "Every proposal is read by at least two reviewers who score it independently before any of them see each other's scores. The programme committee then meets on the proposals where reviewers disagreed. Decisions go out to everyone on the same day, accepted or not, with the reviewers' summary attached.",
  },
  {
    id: "demo-showcase-faq-accessibility",
    question: "What accessibility support is available?",
    answer:
      "Live captioning runs in every room and edited transcripts are published with each recording. The venue is step-free throughout, there is a quiet room on both floors, and reserved seating is held at the front of every room. Tell us what you need when you register and we will confirm the arrangement before you travel.",
  },
  {
    id: "demo-showcase-faq-recordings",
    question: "Are sessions recorded?",
    answer:
      "Main-stage and breakout sessions are recorded and published to the recording library within two weeks. Workshops are not recorded, because people say things in a workshop that they would not say to a camera.",
  },
  {
    id: "demo-showcase-faq-bursary",
    question: "Is there a bursary?",
    answer:
      "Yes. The speaker bursary covers travel and accommodation for accepted speakers without an employer paying their way, and fifty community places are held for independent and first-time organisers. Both open with the call for speakers and are decided separately from the programme review.",
  },
  {
    id: "demo-showcase-faq-timetable",
    question: "When is the timetable published?",
    answer:
      "The full timetable is published here as soon as rooms and times are confirmed, and it stays live: if a session moves, this site is the version that changed. You can save sessions to a personal itinerary and add it to your calendar.",
  },
] as const;
export const DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID =
  "demo-showcase-sponsor-eventlab";
export const DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID =
  "audit-demo-showcase-public-site-published-3";

/* The showcase sponsors are fictional organisations, so they carry no website
   or logo URL: a demo that links "Visit sponsor" at a domain nobody owns is a
   worse answer than one that sends the reader to this event's own sponsors
   page. Tier and description are the fields that make the page legible, and
   they are the ones a real organiser fills in first.

   The service groups sponsors by tier name in alphabetical order, so these
   three tiers are named to fall in their own hierarchy under that sort:
   Headline, Major, Supporting. A fourth tier added below Supporting — Bronze,
   say — would sort to the top of the page and read as the most important one.
   See docs/DECISIONS.md on why tier ranking is not modelled explicitly. */
export const DEMO_SHOWCASE_SITE_SPONSORS = [
  {
    id: "demo-showcase-sponsor-northstar",
    name: "Northstar Events",
    tier: "Headline partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Underwrites the main stage and the whole recording library, so every session stays available to people who could not travel.",
    position: 0,
    operationId: "demo-showcase:sponsor-northstar",
  },
  {
    id: DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID,
    name: "EventLab",
    tier: "Major partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Runs the Experience Design track and the hands-on workshop rooms on Friday.",
    position: 1,
    operationId: "demo-showcase:sponsor-eventlab",
  },
  {
    id: "demo-showcase-sponsor-venue",
    name: "Meridian Venue Group",
    tier: "Major partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Hosts the Thursday evening reception and covers the quiet room on both floors.",
    position: 2,
    operationId: "demo-showcase:sponsor-venue",
  },
  {
    id: "demo-showcase-sponsor-registration",
    name: "Atlas Registration",
    tier: "Supporting partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Funds the fifty community places reserved for independent and first-time organisers.",
    position: 3,
    operationId: "demo-showcase:sponsor-registration",
  },
  {
    id: "demo-showcase-sponsor-fund",
    name: "The Gathering Fund",
    tier: "Supporting partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Supports the speaker bursary that pays travel and accommodation for speakers without an employer behind them.",
    position: 4,
    operationId: "demo-showcase:sponsor-fund",
  },
  {
    id: "demo-showcase-sponsor-captions",
    name: "Caption Collective",
    tier: "Supporting partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Provides live captioning in every room and the edited transcripts published with each recording.",
    position: 5,
    operationId: "demo-showcase:sponsor-captions",
  },
  {
    id: "demo-showcase-sponsor-travel",
    name: "Rail & Route",
    tier: "Supporting partner",
    websiteUrl: null,
    logoUrl: null,
    description:
      "Covers regional travel for the bursary cohort and the Thursday morning shuttle from Union Station.",
    position: 6,
    operationId: "demo-showcase:sponsor-travel",
  },
] as const;

/* Every optional page is enabled in the showcase, because an organiser
   evaluating the product needs to see what each one does with real copy in it
   rather than infer it from a checkbox. The bodies are written in the
   restricted Markdown subset the editor accepts: `## ` subheadings, `- `
   lists, `**bold**` and credential-free HTTPS links, and nothing else. */
const DEMO_SHOWCASE_ABOUT_PAGE_BODY = `Future of Events is the annual working conference for the people who plan, produce and run events — three days in Toronto for programme leads, producers, experience designers and the operations teams who hold the whole thing together on the day.

It is deliberately a practitioner conference. Every session is chosen for what an attendee can do differently on the Monday after, and speakers are asked to bring the specifics: the running order that failed, the number that changed a decision, the process that finally stuck.

## Who comes
- **Programme and content leads** shaping a call for speakers, a review process or a track structure.
- **Producers and operations managers** running rooms, run sheets, suppliers and the schedule on the day.
- **Experience and service designers** working on wayfinding, accessibility and the parts of an event people actually remember.
- **Technology and data teams** joining registration, scheduling and reporting into something a team can run.

## The 2027 programme
Four tracks run across three days, with keynotes on the main stage and workshops in the afternoon.

- **Leadership** — the strategy, budget and stakeholder work that decides what an event is for.
- **AI & Innovation** — where automation genuinely helps event operations, and where it quietly costs more than it saves.
- **Experience Design** — inclusive, calm, legible experiences from the first touchpoint to the closing conversation.
- **Event Operations** — scheduling, logistics, suppliers and the unglamorous machinery that makes the rest possible.

## How the programme is built
Every session on this site came through an open call. Proposals are read by at least two reviewers who score independently before seeing each other's scores, and the programme committee meets only on the proposals reviewers disagreed about. Decisions go out on the same day to everyone who applied, accepted or not, with the reviewers' summary attached.

There are no paid speaking slots. Partners fund the event; they do not choose the programme.

## Access and care
Live captioning runs in every room and edited transcripts are published with each recording. The venue is step-free throughout, there is a quiet room on each floor, and reserved seating is held at the front of every room. A speaker bursary covers travel and accommodation for accepted speakers without an employer paying their way, and fifty community places are held each year for independent and first-time organisers.

## Staying up to date
The full programme is published on this site and stays live — if a session moves, this is the version that changed. Save the sessions you want to a personal itinerary and add it to your calendar. Applications to speak open through **Apply to speak** whenever the call is running.`;

const DEMO_SHOWCASE_SPONSORS_PAGE_BODY = `Future of Events is funded by organisations that pay for the parts of a conference most budgets cut first: captioning in every room, the quiet space, the travel bursary, and the recording library that keeps every session available to people who could not be there.

Partners fund the event. They do not choose the programme, and there are no paid speaking slots — every session on this site came through the open call and the same review.

## Partnering with us
The 2028 prospectus opens in September 2027. Access and bursary support can be sponsored separately from the main tiers, at any size.`;

const DEMO_SHOWCASE_FAQ_PAGE_BODY = `Everything below is what people ask us most often before they register. If your question is not here, the organising team answers mail within two working days.`;

const DEMO_SHOWCASE_VENUE_PAGE_BODY = `Future of Events 2027 runs across the north building of the Metro Toronto Convention Centre. Registration opens at 08:00 on level 300; the main stage, the four breakout rooms and the exhibition floor are all on the same level, so nothing needs a lift between sessions.

## Getting here
Start from [the venue on a map](https://www.google.com/maps/search/?api=1&query=Metro%20Toronto%20Convention%20Centre%2C%20255%20Front%20Street%20West%2C%20Toronto) and work back from whichever of these you are using.

- **By transit** — Union Station is a seven-minute walk through the PATH, which is indoors and step-free the whole way. The 509 and 510 streetcars stop at Front Street West.
- **By train or coach** — Union Station serves GO Transit, VIA Rail and UP Express from Pearson Airport, roughly 25 minutes from the terminal.
- **By car** — underground parking is available beneath the building on Lower Simcoe Street, with accessible bays on level P1. There is no reserved event parking, so allow extra time on Saturday.
- **By bike** — covered racks sit at the Front Street entrance, and there are two Bike Share stations within a block.

## Accessibility
- Step-free access throughout, including the main stage and every breakout room.
- Live captioning in all rooms, with edited transcripts published alongside each recording.
- Reserved seating held at the front of every room, and space for wheelchairs and mobility aids at the end of each row.
- Accessible toilets on every level, and a quiet room on level 300 and level 800 open all three days.
- Assistance dogs are welcome anywhere in the building.

Tell us what you need when you register and we will confirm the arrangement in writing before you travel.

## On site
Registration, cloakroom and the information desk are together at the level 300 entrance. Lunch and refreshments are served on the exhibition floor. Water stations sit outside every room, and there are quiet working tables along the south windows for people who need to step out and get something done.

## Where to stay
Several hotels connect to the building through the PATH, and the organising team publishes a short list with held rates when registration opens. Anywhere near Union Station or the entertainment district puts you within a fifteen-minute walk.`;

const DEMO_SHOWCASE_CODE_OF_CONDUCT_PAGE_BODY = `Future of Events is a working conference for people who spend their days making rooms feel safe for other people. We hold ourselves to the same standard. This code applies to everyone — attendees, speakers, partners, contractors and the organising team — in every session, in the corridors, at the evening reception and in any online space run for the event.

## What we expect
- Assume the people around you know things you do not, and ask before you assume otherwise.
- Give people room to disagree with an idea without it becoming a judgement about them.
- Respect the name and pronouns someone gives you, first time and every time.
- Ask before photographing or recording anyone, and stop if asked.
- Leave a conversation, a queue or a doorway when someone needs the space more than you do.

## What is not acceptable
- Harassment, intimidation or sustained disruption of a session or a conversation.
- Comments that demean someone for who they are — including race, ethnicity, nationality, gender, gender identity or expression, sexual orientation, disability, age, religion or appearance.
- Unwanted physical contact, or unwanted attention after someone has asked it to stop.
- Sharing someone's private information, or photographing or recording them after they have declined.
- Using a session, a stand or a sponsorship as cover for any of the above.

## Reporting a concern
Speak to any member of the organising team — they wear orange lanyards and there is always someone at the information desk on level 300. You can also mail the organising team, and you can report on behalf of someone else.

You will be listened to. You will not be asked to justify why something bothered you, and you will not be asked to confront the other person. If you would like someone with you for the rest of the day, or an escort to transport, we will arrange it.

## What happens next
The organising team decides what to do, not the person who reported. We can move someone between sessions, ask a person to stop a specific behaviour, withdraw a speaking slot or a partnership, or remove someone from the event without a refund. Serious incidents are reported to venue security or the police at the reporter's request, and never without telling them first.

We will tell you what we decided. We will not publish your name.`;

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
      // The complete FAQ has its own page; repeating all eight questions here
      // makes the event home unnecessarily long, especially on a phone.
      faq: false,
    },
    featuredSpeakerIds: [...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS],
    featuredSessionIds: [...DEMO_SHOWCASE_FEATURED_SESSION_IDS],
    faqItems: DEMO_SHOWCASE_FAQ_ITEMS.map((item) => ({ ...item })),
    pages: {
      about: {
        enabled: true,
        title: "About the conference",
        navigationLabel: "About",
        body: DEMO_SHOWCASE_ABOUT_PAGE_BODY,
      },
      faq: {
        enabled: true,
        title: "Frequently asked questions",
        navigationLabel: "FAQ",
        body: DEMO_SHOWCASE_FAQ_PAGE_BODY,
      },
      venue: {
        enabled: true,
        title: "Venue and travel",
        navigationLabel: "Venue",
        body: DEMO_SHOWCASE_VENUE_PAGE_BODY,
      },
      "code-of-conduct": {
        enabled: true,
        title: "Code of conduct",
        navigationLabel: "Code of conduct",
        body: DEMO_SHOWCASE_CODE_OF_CONDUCT_PAGE_BODY,
      },
      sponsors: {
        enabled: true,
        title: "Partners and sponsors",
        navigationLabel: "Sponsors",
        body: DEMO_SHOWCASE_SPONSORS_PAGE_BODY,
      },
    },
  });
}

/* Mirrors the service's tier-name, position, name and id ordering, so the
   fixture snapshot is exactly the one publication would have produced. */
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

/* Derived rather than listed, so the audit record and the reset's baseline
   evidence cannot drift from the pages the fixture actually enables. */
const showcasePages = demoShowcasePublicSiteDraft().pages;

export const DEMO_SHOWCASE_ENABLED_PAGES = PUBLIC_SITE_PAGE_TYPES.filter(
  (page) => showcasePages[page].enabled,
);

export function demoShowcasePublishedPublicSite(): PublishedPublicSiteSnapshot {
  return publishedPublicSiteSnapshotSchema.parse({
    ...demoShowcasePublicSiteDraft(),
    sponsors: demoShowcasePublishedSponsors(),
  });
}

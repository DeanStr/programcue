export const DEMO_EVENT_ID = "evt-foe-2025";
export const DEMO_ORGANISATION_ID = "org-future-events";
export const DEMO_RESET_CONFIRMATION = "Future of Events 2025";
export const DEMO_R2_PREFIX = `private/events/${DEMO_EVENT_ID}/`;
export const DEMO_ASSISTANT_FIXTURE_MODEL = "demo-fixture-no-provider-call";

export const DEMO_IDENTITY = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
} as const;

export const DEMO_IDENTITIES = {
  administrator: DEMO_IDENTITY,
  owner: {
    personId: "person-demo-owner",
    name: "Morgan Chen",
    email: "morgan.owner@example.com",
  },
  evaluator: {
    personId: "person-demo-evaluator",
    name: "Jordan Lee",
    email: "jordan.evaluator@example.com",
  },
  submitter: {
    personId: "person-demo-submitter",
    name: "Alex Morgan",
    email: "alex.submitter@example.com",
  },
  speaker: {
    personId: "person-demo-speaker",
    name: "Priya Shah",
    email: "priya.speaker@example.com",
  },
} as const;

export type DemoRole = keyof typeof DEMO_IDENTITIES;

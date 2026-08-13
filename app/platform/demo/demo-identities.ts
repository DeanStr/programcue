export const DEMO_EVENT_ID = "evt-foe-2025";
export const DEMO_ORGANISATION_ID = "org-future-events";
export const DEMO_RESET_CONFIRMATION = "Future of Events 2025";
export const DEMO_R2_PREFIX = `private/events/${DEMO_EVENT_ID}/`;
export const DEMO_ASSISTANT_FIXTURE_MODEL = "demo-fixture-no-provider-call";
export const DEMO_IDENTITY_COOKIE = "program_cue_demo_identity";

export const DEMO_IDENTITY = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  destination: "/admin/command",
  cohort: "sbek",
  profileStatus: "published",
} as const;

export const DEMO_IDENTITIES = {
  administrator: DEMO_IDENTITY,
  owner: {
    personId: "person-demo-owner",
    name: "Morgan Chen",
    email: "morgan.owner@example.com",
    role: "owner",
    destination: "/admin/files/retention",
    cohort: "showcase",
    profileStatus: "published",
  },
  evaluator: {
    personId: "person-demo-evaluator",
    name: "Jordan Lee",
    email: "jordan.evaluator@example.com",
    role: "evaluator",
    destination: "/review/workbench",
    cohort: "showcase",
    profileStatus: "published",
  },
  committee_chair: {
    personId: "person-demo-chair",
    name: "Taylor Brooks",
    email: "taylor.chair@example.com",
    role: "committee_chair",
    destination: "/admin/review",
    cohort: "showcase",
    profileStatus: "published",
  },
  submitter: {
    personId: "person-demo-submitter",
    name: "Alex Morgan",
    email: "alex.submitter@example.com",
    role: "submitter",
    destination: "/participant/dashboard",
    cohort: "showcase",
    profileStatus: "published",
  },
  speaker: {
    personId: "person-demo-speaker",
    name: "Priya Shah",
    email: "priya.speaker@example.com",
    role: "speaker",
    destination: "/participant/dashboard",
    cohort: "showcase",
    profileStatus: "published",
  },
  sbek_speaker: {
    personId: "person-sbek-speaker",
    name: "Priya Raman",
    email: "sbek-speaker@example.com",
    role: "submitter",
    destination: "/participant/dashboard",
    cohort: "sbek",
    profileStatus: "draft",
  },
  sbek_reviewer: {
    personId: "person-sbek-reviewer",
    name: "Sam Whitfield",
    email: "sbek-reviewer@example.com",
    role: "evaluator",
    destination: "/demo",
    cohort: "sbek",
    profileStatus: "published",
  },
} as const;

export const SBEK_SECOND_SPEAKER = {
  personId: "person-sbek-speaker2",
  name: "Marcus Okafor",
  email: "sbek-speaker2@example.com",
  profileStatus: "draft",
} as const;

export const SBEK_FIXTURE_PEOPLE = {
  organizer: DEMO_IDENTITIES.administrator,
  speaker: DEMO_IDENTITIES.sbek_speaker,
  speaker2: SBEK_SECOND_SPEAKER,
  reviewer: DEMO_IDENTITIES.sbek_reviewer,
} as const;

export type DemoIdentityKey = keyof typeof DEMO_IDENTITIES;
export type DemoIdentity = (typeof DEMO_IDENTITIES)[DemoIdentityKey];

export function isDemoIdentityKey(value: string): value is DemoIdentityKey {
  return Object.hasOwn(DEMO_IDENTITIES, value);
}

export function isSbekFixturePerson(personId: string) {
  return Object.values(SBEK_FIXTURE_PEOPLE).some(
    (identity) => identity.personId === personId,
  );
}

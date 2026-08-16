import { env } from "cloudflare:test";
import { expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { routingSchema, saveFormSchema } from "./submission-schema";
import { SubmissionService } from "./submission-service.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    DEMO_MODE: string;
    DEFAULT_EVENT_ID: string;
    BETTER_AUTH_URL: string;
  }
}

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

it("requires persisted event-track identity maps in form routing", () => {
  expect(() =>
    routingSchema.parse({
      categories: {},
      teamNames: {},
      directSessionDurationMinutes: null,
      passwordHash: null,
    }),
  ).toThrow();
});

it("reconciles protected draft tracks and formats with current event choices", async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const service = new SubmissionService(testEnv);
  const input = await service.getDefaultFormInput(viewer);
  const trackField = input.schema.fields.find(
    (field) => field.id === "category",
  )!;
  trackField.options = ["AI & Innovation", "Event Operations"];
  input.routing.categories = {
    "AI & Innovation": "team-ai",
    "Event Operations": "team-operations",
  };
  input.schema.fields.push({
    id: "track_details",
    label: "AI track details",
    type: "long_text",
    required: false,
    help: "",
    example: "",
    options: [],
    reviewVisibility: "reviewers",
    blindReviewVisibility: "content",
    condition: { fieldId: "category", equals: "AI & Innovation" },
  });

  const reconciled = SubmissionService.synchronizeFormEventChoices(
    input,
    [
      { id: "demo-track-ai", name: "Applied AI" },
      { id: "demo-track-experience", name: "Experience Design" },
      { id: "track-new", name: "New track" },
    ],
    [
      { key: "talk", label: "Talk" },
      { key: "workshop", label: "Hands-on lab" },
    ],
  );

  expect(
    reconciled.schema.fields.find((field) => field.id === "category")!.options,
  ).toEqual(["Applied AI", "Experience Design", "New track"]);
  expect(
    reconciled.schema.fields.find((field) => field.id === "format")!.options,
  ).toEqual(["Talk", "Hands-on lab"]);
  expect(
    reconciled.schema.fields.find((field) => field.id === "materials")
      ?.condition,
  ).toEqual({ fieldId: "format", equals: "Hands-on lab" });
  expect(
    reconciled.schema.fields.find((field) => field.id === "track_details")
      ?.condition,
  ).toEqual({ fieldId: "category", equals: "Applied AI" });
  expect(reconciled.routing).toMatchObject({
    categories: { "Applied AI": "team-ai" },
    trackIds: {
      "Applied AI": "demo-track-ai",
      "Experience Design": "demo-track-experience",
      "New track": "track-new",
    },
    trackNames: {
      "demo-track-ai": "Applied AI",
      "demo-track-experience": "Experience Design",
      "track-new": "New track",
    },
    formatKeys: { Talk: "talk", "Hands-on lab": "workshop" },
  });

  const corrupt = structuredClone(input);
  delete corrupt.routing.trackNames["demo-track-ai"];
  expect(() =>
    SubmissionService.synchronizeFormEventChoices(
      corrupt,
      [{ id: "demo-track-ai", name: "Applied AI" }],
      [{ key: "talk", label: "Talk" }],
    ),
  ).toThrow(/inconsistent saved event-track identity/i);

  const repairable = SubmissionService.synchronizeFormEventChoices(
    input,
    [
      { id: "demo-track-ai", name: "Applied AI" },
      { id: "demo-track-experience", name: "Experience Design" },
    ],
    [{ key: "talk", label: "Talk" }],
  );
  expect(
    repairable.schema.fields.find((field) => field.id === "materials")
      ?.condition,
  ).toEqual({ fieldId: "format", equals: "Workshop" });
  expect(saveFormSchema.safeParse(repairable).success).toBe(false);
  const repaired = structuredClone(repairable);
  repaired.schema.fields.find((field) => field.id === "materials")!.condition =
    null;
  expect(saveFormSchema.safeParse(repaired).success).toBe(true);
});

it("supports every protected Event Setup choice in a form", async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const service = new SubmissionService(testEnv);
  const input = await service.getDefaultFormInput(viewer);
  const formatKeys = input.routing.formatKeys;
  if (!formatKeys) throw new Error("Default form format routing is missing.");
  const existingTracks = input.schema.fields
    .find((field) => field.id === "category")!
    .options.map((name) => ({ id: input.routing.trackIds[name]!, name }));
  const existingFormats = input.schema.fields
    .find((field) => field.id === "format")!
    .options.map((label) => {
      const key = formatKeys[label];
      if (!key) throw new Error(`Default format ${label} has no routing key.`);
      return { key, label };
    });
  const tracks = [
    ...existingTracks,
    ...Array.from({ length: 100 - existingTracks.length }, (_, index) => ({
      id: `max-track-${index}`,
      name: `Maximum track ${index}`,
    })),
  ];
  const formats = [
    ...existingFormats,
    ...Array.from({ length: 50 - existingFormats.length }, (_, index) => ({
      key: `max-format-${index}`,
      label: `Maximum format ${index}`,
    })),
  ];

  const synchronized = SubmissionService.synchronizeFormEventChoices(
    input,
    tracks,
    formats,
  );

  expect(
    synchronized.schema.fields.find((field) => field.id === "category")
      ?.options,
  ).toHaveLength(100);
  expect(
    synchronized.schema.fields.find((field) => field.id === "format")?.options,
  ).toHaveLength(50);
  expect(saveFormSchema.safeParse(synchronized).success).toBe(true);
});

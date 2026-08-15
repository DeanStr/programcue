import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { MultipartUploadService } from "~/modules/files/multipart-upload.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { processSubmissionNotification } from "../../../workers/communications-queue";
import {
  ApplicantConfigurationError,
  ApplicantSessionService,
} from "./applicant-session.server";
import {
  D1SubmissionRepository,
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
} from "./submission-repository.server";
import {
  DEFAULT_FORM_SCHEMA,
  routingSchema,
  saveFormSchema,
} from "./submission-schema";
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

async function publishedForm(overrides: Record<string, unknown> = {}) {
  const queued: unknown[] = [];
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    RESEND_API_KEY: "submission-test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
    EVENT_CHANNEL: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return { fetch: async () => Response.json({ accepted: true }) };
      },
    },
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const service = new SubmissionService(testEnv);
  const token = crypto.randomUUID().slice(0, 8);
  const defaults = await service.getDefaultFormInput(viewer);
  const input = {
    ...defaults,
    publicSlug: `test-${token}`,
    name: `Test form ${token}`,
    ...overrides,
    routing: {
      ...defaults.routing,
      ...((overrides.routing as Record<string, unknown> | undefined) ?? {}),
    },
  };
  if (input.kind === "direct_session") {
    const trackField = input.schema.fields.find(
      (field) => field.id === "category",
    );
    if (trackField) trackField.type = "select";
  }
  const id = await service.saveForm(viewer, input);
  const workspace = await service.getAdminWorkspace(viewer, id);
  await service.publishForm(
    viewer,
    id,
    workspace!.revision,
    workspace!.draftVersion.revision,
  );
  return { service, id, slug: input.publicSlug, queued, testEnv };
}

async function verifiedApplicant(
  service: SubmissionService,
  slug: string,
  email = `applicant-${crypto.randomUUID()}@example.com`,
) {
  const form = await service.getPublicForm(slug);
  await expect(
    service.applicants.requestCode(form, email, ""),
  ).resolves.toEqual({ demoCode: "424242" });
  const verified = await service.applicants.verifyCode(form, email, "424242");
  const request = new Request(`https://example.com/apply/${slug}`, {
    headers: { cookie: verified.cookie.split(";")[0] },
  });
  const applicant = await service.applicants.get(request, form);
  expect(applicant?.email).toBe(email);
  return applicant!;
}

const validAnswers = {
  title: "Useful automation without the hype",
  description:
    "A practical session about reliable event operations and measurable outcomes.",
  category: ["AI & Innovation"],
  format: "Presentation",
  video: "https://example.com/pitch",
};

const directSessionAnswers = {
  ...validAnswers,
  category: "AI & Innovation",
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
  const existingTracks = input.schema.fields
    .find((field) => field.id === "category")!
    .options.map((name) => ({ id: input.routing.trackIds[name]!, name }));
  const existingFormats = input.schema.fields
    .find((field) => field.id === "format")!
    .options.map((label) => ({
      key: input.routing.formatKeys?.[label]!,
      label,
    }));
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

async function insertReadySubmissionVideo(
  testEnv: CloudflareEnvironment,
  input: {
    eventId: string;
    submissionId: string;
    ownerPersonId: string | null;
  },
) {
  const assetId = `video-asset-${crypto.randomUUID()}`;
  const versionId = `video-version-${crypto.randomUUID()}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, 'submission', ?, 'video', 'pending', unixepoch(), unixepoch())`,
    ).bind(assetId, input.eventId, input.ownerPersonId, input.submissionId),
    testEnv.DB.prepare(
      `INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key, original_filename,
         declared_content_type, detected_content_type, size_bytes, object_etag,
         upload_status, signature_status, scan_status, created_by_person_id,
         created_at, uploaded_at, scanned_at, released_at
       ) VALUES (?, ?, ?, 1, ?, 'pitch.mp4', 'video/mp4', 'video/mp4', 1024,
                 'test-etag', 'uploaded', 'valid', 'clean', ?,
                 unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      versionId,
      input.eventId,
      assetId,
      `private/test/${versionId}`,
      input.ownerPersonId,
    ),
    testEnv.DB.prepare(
      `UPDATE file_assets SET current_version_id = ?, status = 'active',
              updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    ).bind(versionId, assetId, input.eventId),
  ]);
  return { assetId, versionId };
}

function withNthBatchRace(
  testEnv: CloudflareEnvironment,
  batchNumber: number,
  race: () => Promise<void>,
) {
  let batches = 0;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          if (batches === batchNumber) await race();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

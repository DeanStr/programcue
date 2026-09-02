import { env } from "cloudflare:test";

import { expect } from "vitest";
import { requireValue } from "~/lib/required-value";

import type { Viewer } from "~/platform/auth/authorize.server";

import { ensureDemoData } from "~/platform/demo/seed.server";

import { SubmissionService } from "./submission-service.server";

export const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const EVALUATION_TEST_SECRET =
  "evaluation-session-secret-with-more-than-thirty-two-characters";

export const EVALUATION_AUTH_SECRET =
  "evaluation-applicant-auth-secret-with-more-than-thirty-two-characters";

export async function productionEvaluationEnvironment(
  testEnv: CloudflareEnvironment,
) {
  const environment = {
    ...testEnv,
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
    EVALUATION_SESSION_SECRET: EVALUATION_TEST_SECRET,
    BETTER_AUTH_SECRET: EVALUATION_AUTH_SECRET,
  } as CloudflareEnvironment;
  const fixtureGeneration = crypto.randomUUID();
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id,
       actor_id, action, entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, 'org-future-events',
               'evt-foe-2025', 'test-operator', 'evaluation.fixture.reset',
               'event', 'evt-foe-2025', '{}', unixepoch())`,
  )
    .bind(fixtureGeneration)
    .run();
  return environment;
}

export function cookiePair(setCookie: string) {
  const pair = setCookie.split(";", 1)[0];
  if (!pair) throw new Error("Expected a cookie pair.");
  return pair;
}

export async function publishedForm(overrides: Record<string, unknown> = {}) {
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
  let input = {
    ...defaults,
    publicSlug: `test-${token}`,
    name: `Test form ${token}`,
    ...overrides,
    routing: {
      ...defaults.routing,
      ...((overrides.routing as Record<string, unknown> | undefined) ?? {}),
    },
  };
  input = SubmissionService.synchronizeFormEventChoices(
    input,
    await service.listRoutingTracks(viewer),
    await service.getConfiguredSessionFormats(viewer),
  );
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
    workspace?.revision,
    workspace?.draftVersion.revision,
  );
  return { service, id, slug: input.publicSlug, queued, testEnv };
}

export async function verifiedApplicant(
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
  return requireValue(applicant, "Expected a verified applicant fixture.");
}

export const validAnswers = {
  title: "Useful automation without the hype",
  description:
    "A practical session about reliable event operations and measurable outcomes.",
  category: ["AI & Innovation"],
  format: "Presentation",
  video: "https://example.com/pitch",
};

export const directSessionAnswers = {
  ...validAnswers,
  category: "AI & Innovation",
};

export function withNthBatchRace(
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

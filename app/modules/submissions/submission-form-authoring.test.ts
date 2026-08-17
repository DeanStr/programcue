import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  activateEvaluationApplicantAccount,
  evaluationSessionCookie,
} from "~/platform/evaluation/evaluation-session.server";
import { ApplicantSessionService } from "./applicant-session.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "./submission-repository.server";
import { DEFAULT_FORM_SCHEMA } from "./submission-schema";
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

describe("Submissions D1 vertical slice", () => {
  describe("form authoring workflows", () => {
    it("resolves the current event's latest published application entry", async () => {
      const { service, slug } = await publishedForm();
      await env.DB.prepare(
        `UPDATE form_definitions
            SET updated_at = unixepoch() + 10
          WHERE event_id = ? AND public_slug = ?`,
      )
        .bind(viewer.eventId, slug)
        .run();

      await expect(service.getLatestPublishedFormSlug(viewer)).resolves.toBe(
        slug,
      );
      await expect(
        service.getApplicationEventScope(viewer.eventId),
      ).resolves.toEqual({
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
      });
      await expect(
        service.getApplicationEventScope(`missing-${crypto.randomUUID()}`),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.getLatestPublishedFormSlug({
          ...viewer,
          organisationId: "org-outside-scope",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("re-reads a public form after an Airtable projection refresh", async () => {
      const { slug, testEnv } = await publishedForm();
      const boundary = {
        assertReadable: async () => {
          await testEnv.DB.prepare(
            "UPDATE form_definitions SET status = 'closed' WHERE public_slug = ?",
          )
            .bind(slug)
            .run();
          return { source: "airtable" };
        },
      } as unknown as AirtableProviderBoundary;

      await expect(
        new SubmissionService(testEnv, { airtable: boundary }).getPublicForm(
          slug,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("uses the event access policy for a new form", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const service = new SubmissionService(testEnv);
      await testEnv.DB.prepare(
        `UPDATE events SET submission_access_mode = 'account_required'
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
      try {
        await expect(
          service.getDefaultFormInput(viewer),
        ).resolves.toMatchObject({
          accessMode: "account_required",
        });
      } finally {
        await testEnv.DB.prepare(
          `UPDATE events SET submission_access_mode = 'email_verified'
            WHERE id = ? AND organisation_id = ?`,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .run();
      }
    });

    it("requires an explicit save before a legacy draft can be published as schema v2", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const service = new SubmissionService(testEnv);
      const defaults = await service.getDefaultFormInput(viewer);
      const formId = await service.saveForm(viewer, {
        ...defaults,
        name: `Legacy draft ${crypto.randomUUID()}`,
        publicSlug: `legacy-draft-${crypto.randomUUID()}`,
      });
      const initial = await service.getAdminWorkspace(viewer, formId);
      const legacySchema = {
        introduction: initial!.draftVersion.schema.introduction,
        presentation: initial!.draftVersion.schema.presentation,
        fields: initial!.draftVersion.schema.fields.map(
          ({ sectionId: _sectionId, ...field }) => field,
        ),
      };
      await testEnv.DB.prepare(
        "UPDATE form_versions SET schema_json = ? WHERE id = ? AND event_id = ?",
      )
        .bind(
          JSON.stringify(legacySchema),
          initial!.draftVersion.id,
          viewer.eventId,
        )
        .run();

      const legacyWorkspace = await service.getAdminWorkspace(viewer, formId);
      expect(legacyWorkspace!.draftVersion.schemaFormatVersion).toBe(1);
      expect(legacyWorkspace!.draftVersion.schema).toMatchObject({
        schemaVersion: 2,
        sections: [{ id: "proposal", title: "Application" }],
      });
      await expect(
        service.publishForm(
          viewer,
          formId,
          legacyWorkspace!.revision,
          legacyWorkspace!.draftVersion.revision,
        ),
      ).rejects.toThrow(/save this draft once to upgrade its sections/i);

      await service.saveForm(
        viewer,
        SubmissionService.workspaceToInput(legacyWorkspace!),
      );
      const upgraded = await service.getAdminWorkspace(viewer, formId);
      expect(upgraded!.draftVersion.schemaFormatVersion).toBe(2);
    });

    it("keeps immutable published schema v1 bytes unchanged while v2 drafts are edited", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const workspace = await service.getAdminWorkspace(viewer, id);
      const published = workspace!.publishedVersion!;
      if (!("schemaVersion" in published.schema)) {
        throw new Error("The newly published form did not use schema v2.");
      }
      const legacySchema = {
        introduction: published.schema.introduction,
        presentation: published.schema.presentation,
        fields: published.schema.fields.map(
          ({ sectionId: _sectionId, ...field }) => field,
        ),
      };
      const storedLegacy = JSON.stringify(legacySchema);
      await testEnv.DB.prepare(
        "UPDATE form_versions SET schema_json = ? WHERE id = ? AND event_id = ?",
      )
        .bind(storedLegacy, published.id, viewer.eventId)
        .run();

      await expect(service.getPublicForm(slug)).resolves.toMatchObject({
        version: { schemaFormatVersion: 1 },
      });
      const current = await service.getAdminWorkspace(viewer, id);
      expect(current!.publishedVersion!.schemaFormatVersion).toBe(1);
      await service.saveForm(
        viewer,
        SubmissionService.workspaceToInput(current!),
      );

      await expect(
        testEnv.DB.prepare(
          "SELECT schema_json AS schemaJson FROM form_versions WHERE id = ? AND event_id = ?",
        )
          .bind(published.id, viewer.eventId)
          .first(),
      ).resolves.toEqual({ schemaJson: storedLegacy });
    });

    it("requires a form draft to be resaved after an event track changes", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const service = new SubmissionService(testEnv);
      const defaults = await service.getDefaultFormInput(viewer);
      const formId = await service.saveForm(viewer, {
        ...defaults,
        name: `Track snapshot ${crypto.randomUUID()}`,
        publicSlug: `track-snapshot-${crypto.randomUUID()}`,
      });
      const workspace = await service.getAdminWorkspace(viewer, formId);
      const trackId =
        workspace!.draftVersion.routing.trackIds[
          workspace!.draftVersion.schema.fields.find(
            (field) => field.id === "category",
          )!.options[0]!
        ]!;
      const track = await testEnv.DB.prepare(
        "SELECT name FROM tracks WHERE id = ? AND event_id = ?",
      )
        .bind(trackId, viewer.eventId)
        .first<{ name: string }>();
      expect(track).not.toBeNull();
      try {
        await testEnv.DB.prepare(
          "UPDATE tracks SET name = name || ' renamed' WHERE id = ? AND event_id = ?",
        )
          .bind(trackId, viewer.eventId)
          .run();

        await expect(
          service.publishForm(
            viewer,
            formId,
            workspace!.revision,
            workspace!.draftVersion.revision,
          ),
        ).rejects.toThrow(/track changed.*save the form again/i);
      } finally {
        await testEnv.DB.prepare(
          "UPDATE tracks SET name = ? WHERE id = ? AND event_id = ?",
        )
          .bind(track!.name, trackId, viewer.eventId)
          .run();
      }
    });

    it("replays exact assistant form creation and publication intents", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const service = new SubmissionService(testEnv);
      const proposalId = crypto.randomUUID();
      const operationId = `assistant:${proposalId}`;
      const formId = proposalId;
      const createOperation = {
        operationId,
        formId,
        versionId: `assistant-form-version:${proposalId}`,
        auditId: `assistant-form-audit:${proposalId}`,
      };
      const input = {
        ...(await service.getDefaultFormInput(viewer)),
        name: `Assistant form ${proposalId}`,
        publicSlug: `assistant-form-${proposalId}`,
      };
      await expect(
        service.saveForm(viewer, input, createOperation),
      ).resolves.toBe(formId);
      await expect(
        service.saveForm(viewer, input, createOperation),
      ).resolves.toBe(formId);
      const workspace = await service.getAdminWorkspace(viewer, formId);
      const publishOperation = {
        operationId,
        nextVersionId: `assistant-next-form-version:${proposalId}`,
        auditId: `assistant-form-publication-audit:${proposalId}`,
      };
      await expect(
        service.publishForm(
          viewer,
          formId,
          workspace!.revision,
          workspace!.draftVersion.revision,
          publishOperation,
        ),
      ).resolves.toBeUndefined();
      await expect(
        service.publishForm(
          viewer,
          formId,
          workspace!.revision,
          workspace!.draftVersion.revision,
          publishOperation,
        ),
      ).resolves.toBeUndefined();
      const state = await testEnv.DB.prepare(
        `SELECT form.status,
                (SELECT COUNT(*) FROM form_versions version
                  WHERE version.form_id = form.id) AS versionCount
           FROM form_definitions form
          WHERE form.id = ? AND form.event_id = ?`,
      )
        .bind(formId, viewer.eventId)
        .first<{ status: string; versionCount: number }>();
      expect(state).toEqual({ status: "published", versionCount: 2 });
    });

    it("counts submitted applications only against their own form", async () => {
      const first = await publishedForm();
      const second = await publishedForm();
      const applicant = await verifiedApplicant(first.service, first.slug);
      const submissionId = await first.service.createDraft(
        first.slug,
        applicant,
      );
      const draft = (
        await first.service.repository.getApplicantDrafts(first.id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await first.service.submitDraft(first.slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [{ name: applicant.name, email: applicant.email }],
      });

      await expect(
        first.service.getAdminWorkspace(viewer, first.id),
      ).resolves.toMatchObject({ submittedCount: 1 });
      await expect(
        second.service.getAdminWorkspace(viewer, second.id),
      ).resolves.toMatchObject({ submittedCount: 0 });
    });
  });

  describe("form authoring workflows", () => {
    it("rejects short form passwords before persisting a draft", async () => {
      const { service, testEnv } = await publishedForm();
      const publicSlug = `short-password-${crypto.randomUUID().slice(0, 8)}`;

      await expect(
        service.saveForm(viewer, {
          ...(await service.getDefaultFormInput(viewer)),
          publicSlug,
          name: "Short password form",
          accessMode: "password_protected",
          accessPassword: "short",
        }),
      ).rejects.toThrow("Form passwords must contain at least 8 characters");

      await expect(
        testEnv.DB.prepare(
          "SELECT id FROM form_definitions WHERE event_id = ? AND public_slug = ?",
        )
          .bind(viewer.eventId, publicSlug)
          .first(),
      ).resolves.toBeNull();
    });

    it("resolves a globally unique public form outside the default event", async () => {
      const { service, testEnv } = await publishedForm();
      const token = crypto.randomUUID();
      const eventId = `form-event-${token}`;
      const publicSlug = `non-default-form-${token}`;
      const eventViewer = { ...viewer, eventId };
      await testEnv.DB.prepare(
        `
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'Non-default form event', ?, 'UTC',
                  unixepoch('2027-01-10T00:00:00Z'),
                  unixepoch('2027-01-11T23:59:59Z'),
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
      `,
      )
        .bind(eventId, viewer.organisationId, `non-default-event-${token}`)
        .run();
      await testEnv.DB.prepare(
        `INSERT INTO tracks (id, event_id, name, slug, position)
         VALUES (?, ?, 'General', 'general', 0)`,
      )
        .bind(`track-${token}`, eventId)
        .run();

      const formId = await service.saveForm(eventViewer, {
        ...(await service.getDefaultFormInput(eventViewer)),
        name: "Non-default event form",
        publicSlug,
      });
      const workspace = await service.getAdminWorkspace(eventViewer, formId);
      await service.publishForm(
        eventViewer,
        formId,
        workspace!.revision,
        workspace!.draftVersion.revision,
      );

      await expect(service.getPublicForm(publicSlug)).resolves.toMatchObject({
        id: formId,
        eventId,
        publicSlug,
      });
      await expect(
        service.saveForm(viewer, {
          ...(await service.getDefaultFormInput(viewer)),
          name: "Duplicate public URL",
          publicSlug,
        }),
      ).rejects.toThrow(/already in use/i);
    });

    it("isolates verification codes and applicant sessions by form", async () => {
      const first = await publishedForm();
      const second = await publishedForm();
      const firstForm = await first.service.getPublicForm(first.slug);
      const secondForm = await second.service.getPublicForm(second.slug);
      const email = `multi-form-${crypto.randomUUID()}@example.com`;

      await first.service.applicants.requestCode(firstForm, email, "");
      await second.service.applicants.requestCode(secondForm, email, "");
      const firstVerified = await first.service.applicants.verifyCode(
        firstForm,
        email,
        "424242",
      );
      const secondVerified = await second.service.applicants.verifyCode(
        secondForm,
        email,
        "424242",
      );
      const firstCookie = firstVerified.cookie.split(";")[0];
      const secondCookie = secondVerified.cookie.split(";")[0];
      expect(firstCookie.split("=")[0]).not.toBe(secondCookie.split("=")[0]);

      const request = new Request("https://example.com/apply", {
        headers: { cookie: `${firstCookie}; ${secondCookie}` },
      });
      await expect(
        first.service.applicants.get(request, firstForm),
      ).resolves.toMatchObject({ email });
      await expect(
        second.service.applicants.get(request, secondForm),
      ).resolves.toMatchObject({ email });
    });

    it("requires explicit activation before using the selected production evaluation identity as the clean verified applicant", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      await testEnv.DB.prepare(
        `UPDATE people SET email_verified = 0
          WHERE id = 'person-sbek-speaker'`,
      ).run();
      const evaluationEnvironment = {
        ...testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "true",
        EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
        EVALUATION_SESSION_SECRET:
          "evaluation-session-secret-with-more-than-thirty-two-characters",
      } as CloudflareEnvironment;
      const fixtureGeneration = crypto.randomUUID();
      await evaluationEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
                   'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                   unixepoch())`,
      )
        .bind(fixtureGeneration)
        .run();
      const cookie = await evaluationSessionCookie(
        evaluationEnvironment,
        "sbek_applicant",
      );
      const request = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: cookie.split(";", 1)[0]! },
      });

      const applicantSessions = new ApplicantSessionService(
        evaluationEnvironment,
      );
      const unavailable = await applicantSessions
        .get(request, form)
        .catch((error: unknown) => error);
      expect(unavailable).toBeInstanceOf(Response);
      expect((unavailable as Response).status).toBe(503);

      await expect(
        activateEvaluationApplicantAccount(
          evaluationEnvironment,
          fixtureGeneration,
        ),
      ).resolves.toMatchObject({
        personId: "person-sbek-speaker",
        replayed: false,
      });
      await expect(applicantSessions.get(request, form)).resolves.toMatchObject(
        {
          personId: "person-sbek-speaker",
          email: "sbek-speaker@example.com",
          verified: true,
        },
      );
    });

    it("does not grant applicant verification to another evaluation persona", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const evaluationEnvironment = {
        ...testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "true",
        EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
        EVALUATION_SESSION_SECRET:
          "evaluation-session-secret-with-more-than-thirty-two-characters",
      } as CloudflareEnvironment;
      await evaluationEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
                   'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                   unixepoch())`,
      )
        .bind(crypto.randomUUID())
        .run();
      const cookie = await evaluationSessionCookie(
        evaluationEnvironment,
        "sbek_reviewer",
      );
      const request = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: cookie.split(";", 1)[0]! },
      });

      await expect(
        new ApplicantSessionService(evaluationEnvironment).get(request, form),
      ).resolves.toBeNull();
    });

    it("does not use a selected evaluation identity outside the fixture event", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const evaluationEnvironment = {
        ...testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "true",
        EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
        EVALUATION_SESSION_SECRET:
          "evaluation-session-secret-with-more-than-thirty-two-characters",
      } as CloudflareEnvironment;
      await evaluationEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
                   'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                   unixepoch())`,
      )
        .bind(crypto.randomUUID())
        .run();
      const cookie = await evaluationSessionCookie(
        evaluationEnvironment,
        "sbek_applicant",
      );
      const request = new Request("https://example.com/apply/another-event", {
        headers: { cookie: cookie.split(";", 1)[0]! },
      });

      await expect(
        new ApplicantSessionService(evaluationEnvironment).get(request, {
          ...form,
          eventId: "another-tenant-event",
        }),
      ).resolves.toBeNull();
    });

    it("binds the showcase applicant as a verified fixture-org applicant and fails closed otherwise", async () => {
      const openForm = await publishedForm();
      const passwordForm = await publishedForm({
        accessMode: "password_protected",
        accessPassword: "fixture-password",
      });
      const evaluationEnvironment = {
        ...openForm.testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "true",
        EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
        EVALUATION_SESSION_SECRET:
          "evaluation-session-secret-with-more-than-thirty-two-characters",
      } as CloudflareEnvironment;
      await evaluationEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
                   'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
                   unixepoch())`,
      )
        .bind(crypto.randomUUID())
        .run();
      const cookie = await evaluationSessionCookie(
        evaluationEnvironment,
        "applicant",
      );
      const request = new Request(
        `https://example.com/apply/${openForm.slug}`,
        {
          headers: { cookie: cookie.split(";", 1)[0]! },
        },
      );
      const applicantSessions = new ApplicantSessionService(
        evaluationEnvironment,
      );
      const form = await openForm.service.getPublicForm(openForm.slug);
      const protectedForm = await passwordForm.service.getPublicForm(
        passwordForm.slug,
      );

      await expect(applicantSessions.get(request, form)).resolves.toMatchObject(
        {
          personId: "person-demo-submitter",
          email: "alex.submitter@example.com",
          verified: true,
          evaluation: true,
        },
      );
      await expect(
        applicantSessions.get(request, {
          ...form,
          eventId: "another-tenant-event",
        }),
      ).resolves.toBeNull();
      await expect(
        applicantSessions.get(request, protectedForm),
      ).resolves.toBeNull();

      await evaluationEnvironment.DB.prepare(
        `UPDATE memberships
            SET revoked_at = unixepoch()
          WHERE person_id = 'person-demo-submitter'
            AND organisation_id = 'org-future-events'
            AND event_id = 'evt-foe-2025'
            AND role = 'submitter'`,
      ).run();
      const unavailable = await applicantSessions
        .get(request, form)
        .catch((error: unknown) => error);
      expect(unavailable).toBeInstanceOf(Response);
      expect((unavailable as Response).status).toBe(503);
    });

    it("treats a malformed applicant cookie as an absent session", async () => {
      const { service, slug } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const email = `malformed-cookie-${crypto.randomUUID()}@example.com`;
      await service.applicants.requestCode(form, email, "");
      const verified = await service.applicants.verifyCode(
        form,
        email,
        "424242",
      );
      const cookieName = verified.cookie.split("=", 1)[0]!;
      const request = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: `${cookieName}=%` },
      });

      await expect(service.applicants.get(request, form)).resolves.toBeNull();
    });

    it("invalidates an applicant session when the published form password rotates", async () => {
      const { service, id, slug } = await publishedForm({
        accessMode: "password_protected",
        accessPassword: "initial-password",
      });
      const email = `password-rotation-${crypto.randomUUID()}@example.com`;
      const originalForm = await service.getPublicForm(slug);
      await service.applicants.requestCode(
        originalForm,
        email,
        "initial-password",
      );
      const verified = await service.applicants.verifyCode(
        originalForm,
        email,
        "424242",
      );
      const oldSessionRequest = new Request(
        `https://example.com/apply/${slug}`,
        {
          headers: { cookie: verified.cookie.split(";")[0] },
        },
      );
      await expect(
        service.applicants.get(oldSessionRequest, originalForm),
      ).resolves.toMatchObject({ email });

      const workspace = await service.getAdminWorkspace(viewer, id);
      await service.saveForm(viewer, {
        ...SubmissionService.workspaceToInput(workspace!),
        accessPassword: "rotated-password",
      });
      const updatedWorkspace = await service.getAdminWorkspace(viewer, id);
      await service.publishForm(
        viewer,
        id,
        updatedWorkspace!.revision,
        updatedWorkspace!.draftVersion.revision,
      );
      const rotatedForm = await service.getPublicForm(slug);

      await expect(
        service.applicants.get(oldSessionRequest, rotatedForm),
      ).resolves.toBeNull();
      await expect(
        service.applicants.requestCode(rotatedForm, email, "initial-password"),
      ).rejects.toThrow("password is incorrect");
      await expect(
        service.applicants.requestCode(rotatedForm, email, "rotated-password"),
      ).resolves.toEqual({ demoCode: "424242" });
    });
  });

  describe("form authoring workflows", () => {
    it("publishes immutable versions while old application drafts retain their original schema", async () => {
      const { service, id, slug } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const draftId = await service.createDraft(slug, applicant);

      const workspace = await service.getAdminWorkspace(viewer, id);
      expect(workspace?.publishedVersion?.versionNumber).toBe(1);
      expect(workspace?.draftVersion.versionNumber).toBe(2);
      const editedSchema = {
        ...workspace!.draftVersion.schema,
        fields: workspace!.draftVersion.schema.fields.map((field) =>
          field.id === "description"
            ? { ...field, label: "Detailed proposal" }
            : field,
        ),
      };
      await service.saveForm(viewer, {
        ...SubmissionService.workspaceToInput(workspace!),
        schema: editedSchema,
      });
      const savedWorkspace = await service.getAdminWorkspace(viewer, id);
      await service.publishForm(
        viewer,
        id,
        savedWorkspace!.revision,
        savedWorkspace!.draftVersion.revision,
      );

      const portal = await service.getApplicantPortal(
        slug,
        new Request("https://example.com"),
        draftId,
      );
      expect(portal.applicant).toBeNull();
      const historical = await service.repository.getApplicantDraftForm(
        await service.getPublicForm(slug),
        applicant,
        draftId,
      );
      expect(historical.version.versionNumber).toBe(1);
      expect(
        historical.version.schema.fields.find(
          (field) => field.id === "description",
        )?.label,
      ).toBe("Session description");
      expect(
        (await service.getPublicForm(slug)).version.schema.fields.find(
          (field) => field.id === "description",
        )?.label,
      ).toBe("Detailed proposal");
    });

    it("publishes a new form version with the current event tracks and formats", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const trackId = `track-form-sync-${crypto.randomUUID()}`;
      const event = await testEnv.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const originalFormats = JSON.parse(event!.sessionFormatsJson) as Array<{
        key: string;
        label: string;
        defaultDurationMinutes: number;
        position: number;
      }>;
      const newFormat = {
        key: "fireside",
        label: "Fireside chat",
        defaultDurationMinutes: 30,
        position: originalFormats.length,
      };
      const renamedFormats = originalFormats.map((format) =>
        format.key === "workshop"
          ? { ...format, label: "Hands-on lab" }
          : format,
      );

      try {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `INSERT INTO tracks (id, event_id, name, slug, position)
             VALUES (?, ?, 'Emerging technology', ?, 99)`,
          ).bind(trackId, viewer.eventId, `emerging-${trackId}`),
          testEnv.DB.prepare(
            `UPDATE events SET session_formats_json = ?
              WHERE id = ? AND organisation_id = ?`,
          ).bind(
            JSON.stringify([...renamedFormats, newFormat]),
            viewer.eventId,
            viewer.organisationId,
          ),
        ]);
        const workspace = await service.getAdminWorkspace(viewer, id);
        const synchronized = SubmissionService.synchronizeFormEventChoices(
          SubmissionService.workspaceToInput(workspace!),
          await service.listRoutingTracks(viewer),
          await service.getConfiguredSessionFormats(viewer),
        );
        expect(
          synchronized.schema.fields.find((field) => field.id === "category")
            ?.options,
        ).toContain("Emerging technology");
        expect(
          synchronized.schema.fields.find((field) => field.id === "format")
            ?.options,
        ).toContain("Fireside chat");
        expect(
          synchronized.schema.fields.find((field) => field.id === "materials")
            ?.condition,
        ).toEqual({ fieldId: "format", equals: "Hands-on lab" });

        await service.saveForm(viewer, synchronized);
        const saved = await service.getAdminWorkspace(viewer, id);
        await service.publishForm(
          viewer,
          id,
          saved!.revision,
          saved!.draftVersion.revision,
        );
        const published = await service.getPublicForm(slug);
        expect(
          published.version.schema.fields.find(
            (field) => field.id === "category",
          )?.options,
        ).toContain("Emerging technology");
        expect(
          published.version.schema.fields.find((field) => field.id === "format")
            ?.options,
        ).toContain("Fireside chat");
        expect(published.version.versionNumber).toBe(2);
      } finally {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            "DELETE FROM tracks WHERE id = ? AND event_id = ?",
          ).bind(trackId, viewer.eventId),
          testEnv.DB.prepare(
            `UPDATE events SET session_formats_json = ?
              WHERE id = ? AND organisation_id = ?`,
          ).bind(
            event!.sessionFormatsJson,
            viewer.eventId,
            viewer.organisationId,
          ),
        ]);
      }
    });

    it("rejects publication when its event formats changed", async () => {
      const { service, id, testEnv } = await publishedForm({
        kind: "direct_session",
      });
      const workspace = await service.getAdminWorkspace(viewer, id);
      const event = await testEnv.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ sessionFormatsJson: string }>();
      const formats = JSON.parse(event!.sessionFormatsJson) as Array<{
        key: string;
      }>;
      await testEnv.DB.prepare(
        "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
      )
        .bind(
          JSON.stringify(
            formats.filter((format) => format.key !== "presentation"),
          ),
          viewer.eventId,
          viewer.organisationId,
        )
        .run();

      try {
        await expect(
          service.publishForm(
            viewer,
            id,
            workspace!.revision,
            workspace!.draftVersion.revision,
          ),
        ).rejects.toThrow(/Presentation.*not configured/i);
        await expect(
          testEnv.DB.prepare(
            `SELECT
               (SELECT COUNT(*) FROM form_versions
                 WHERE form_id = ? AND status = 'published') AS publishedCount,
               (SELECT COUNT(*) FROM form_versions
                 WHERE form_id = ? AND status = 'draft') AS draftCount`,
          )
            .bind(id, id)
            .first(),
        ).resolves.toEqual({ publishedCount: 1, draftCount: 1 });
      } finally {
        await testEnv.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(
            event!.sessionFormatsJson,
            viewer.eventId,
            viewer.organisationId,
          )
          .run();
      }
    });

    it("rejects a stale Form Builder save instead of overwriting a newer tab", async () => {
      const { service, id } = await publishedForm();
      const workspace = await service.getAdminWorkspace(viewer, id);
      const staleInput = SubmissionService.workspaceToInput(workspace!);
      await service.saveForm(viewer, {
        ...staleInput,
        name: "Saved from the first tab",
      });

      await expect(
        service.saveForm(viewer, {
          ...staleInput,
          name: "Stale second-tab overwrite",
        }),
      ).rejects.toBeInstanceOf(SubmissionRevisionConflictError);
      const current = await service.getAdminWorkspace(viewer, id);
      expect(current?.name).toBe("Saved from the first tab");
      expect(current?.revision).toBe(workspace!.revision + 1);
      expect(current?.draftVersion.revision).toBe(
        workspace!.draftVersion.revision + 1,
      );
      const auditCount = await env.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM audit_events
         WHERE event_id = ? AND action = 'form.draft.saved' AND entity_id = ?
      `,
      )
        .bind(viewer.eventId, workspace!.draftVersion.id)
        .first<{ count: number }>();
      expect(auditCount?.count).toBe(1);
    });

    it("keeps the published application URL live until a renamed draft is published", async () => {
      const { service, id, slug } = await publishedForm();
      const workspace = await service.getAdminWorkspace(viewer, id);
      const nextSlug = `renamed-${crypto.randomUUID().slice(0, 8)}`;

      await service.saveForm(viewer, {
        ...SubmissionService.workspaceToInput(workspace!),
        name: "Renamed draft form",
        publicSlug: nextSlug,
      });

      await expect(service.getPublicForm(slug)).resolves.toMatchObject({
        publicSlug: slug,
      });
      await expect(service.getPublicForm(nextSlug)).rejects.toMatchObject({
        status: 404,
      });
      const draft = await service.getAdminWorkspace(viewer, id);
      expect(draft).toMatchObject({
        name: "Renamed draft form",
        publicSlug: nextSlug,
      });

      await service.publishForm(
        viewer,
        id,
        draft!.revision,
        draft!.draftVersion.revision,
      );
      await expect(service.getPublicForm(slug)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.getPublicForm(nextSlug)).resolves.toMatchObject({
        name: "Renamed draft form",
        publicSlug: nextSlug,
      });
    });

    it("keeps one live version when the same form draft is published concurrently", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const workspace = await service.getAdminWorkspace(viewer, id);
      const eventConfiguration = await testEnv.DB.prepare(
        `SELECT event.session_formats_json AS sessionFormatsJson,
                (SELECT json_group_array(
                          json_object('id', configured_track.id, 'name', configured_track.name)
                        )
                   FROM (
                     SELECT track.id, track.name, track.event_id
                       FROM tracks track
                      ORDER BY track.position, track.name, track.id
                   ) configured_track
                  WHERE configured_track.event_id = event.id) AS tracksJson
           FROM events event WHERE event.id = ? AND event.organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ sessionFormatsJson: string; tracksJson: string }>();
      expect(eventConfiguration).not.toBeNull();
      const attempts = await Promise.allSettled([
        service.repository.publishForm(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          workspace!.revision,
          workspace!.draftVersion.revision,
          undefined,
          eventConfiguration!.sessionFormatsJson,
          eventConfiguration!.tracksJson,
        ),
        service.repository.publishForm(
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          workspace!.revision,
          workspace!.draftVersion.revision,
          undefined,
          eventConfiguration!.sessionFormatsJson,
          eventConfiguration!.tracksJson,
        ),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);

      const versions = await env.DB.prepare(
        `
        SELECT status, COUNT(*) AS count
          FROM form_versions WHERE form_id = ? AND status IN ('published','draft')
         GROUP BY status ORDER BY status
      `,
      )
        .bind(id)
        .all<{ status: string; count: number }>();
      expect(versions.results).toEqual([
        { status: "draft", count: 1 },
        { status: "published", count: 1 },
      ]);
      await expect(service.getPublicForm(slug)).resolves.toMatchObject({
        publicSlug: slug,
        version: { status: "published" },
      });
    });

    it("rejects publication when event tracks are reordered at the write boundary", async () => {
      const { service, id, testEnv } = await publishedForm();
      const workspace = await service.getAdminWorkspace(viewer, id);
      const tracks = await testEnv.DB.prepare(
        `SELECT id, position FROM tracks
          WHERE event_id = ?
          ORDER BY position, name, id`,
      )
        .bind(viewer.eventId)
        .all<{ id: string; position: number }>();
      expect(tracks.results.length).toBeGreaterThan(1);
      const reordered = tracks.results.at(-1)!;
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.prepare(
          "UPDATE tracks SET position = -1 WHERE id = ? AND event_id = ?",
        )
          .bind(reordered.id, viewer.eventId)
          .run();
      });

      try {
        await expect(
          new SubmissionService(racingEnv).publishForm(
            viewer,
            id,
            workspace!.revision,
            workspace!.draftVersion.revision,
          ),
        ).rejects.toThrow(/configuration changed before publication/i);
        await expect(
          testEnv.DB.prepare(
            `SELECT form.status,
                    (SELECT COUNT(*) FROM form_versions version
                      WHERE version.form_id = form.id
                        AND version.status = 'published') AS publishedCount
               FROM form_definitions form
              WHERE form.id = ? AND form.event_id = ?`,
          )
            .bind(id, viewer.eventId)
            .first(),
        ).resolves.toEqual({ status: "published", publishedCount: 1 });
        await expect(
          testEnv.DB.prepare(
            `SELECT revision FROM form_versions
              WHERE id = ? AND form_id = ? AND status = 'draft'`,
          )
            .bind(workspace!.draftVersion.id, id)
            .first(),
        ).resolves.toEqual({ revision: workspace!.draftVersion.revision });
      } finally {
        await testEnv.DB.prepare(
          "UPDATE tracks SET position = ? WHERE id = ? AND event_id = ?",
        )
          .bind(reordered.position, reordered.id, viewer.eventId)
          .run();
      }
    });

    it("does not publish a required tracks field with no selectable tracks", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const service = new SubmissionService(testEnv);
      const input = await service.getDefaultFormInput(viewer);
      const formId = await service.saveForm(viewer, {
        ...input,
        publicSlug: `empty-tracks-${crypto.randomUUID()}`,
      });
      const workspace = await service.getAdminWorkspace(viewer, formId);
      const invalidSchema = structuredClone(workspace!.draftVersion.schema);
      invalidSchema.fields.find((field) => field.id === "category")!.options =
        [];
      await testEnv.DB.prepare(
        `UPDATE form_versions SET schema_json = ?
          WHERE id = ? AND event_id = ? AND status = 'draft'`,
      )
        .bind(
          JSON.stringify(invalidSchema),
          workspace!.draftVersion.id,
          viewer.eventId,
        )
        .run();

      await expect(
        service.publishForm(
          viewer,
          formId,
          workspace!.revision,
          workspace!.draftVersion.revision,
        ),
      ).rejects.toThrow(/at least one option/i);
      await expect(
        testEnv.DB.prepare(
          "SELECT status FROM form_definitions WHERE id = ? AND event_id = ?",
        )
          .bind(formId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ status: "draft" });
    });

    it("does not publish a routed form when its saved team changes during publication", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const token = crypto.randomUUID();
      const teamId = `publish-route-team-${token}`;
      const teamName = `Publication route ${token}`;
      await testEnv.DB.prepare(
        `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, ?, 'active')`,
      )
        .bind(teamId, viewer.eventId, teamName)
        .run();
      const service = new SubmissionService(testEnv);
      const defaultInput = await service.getDefaultFormInput(viewer);
      const formId = await service.saveForm(viewer, {
        ...defaultInput,
        publicSlug: `publish-route-${token}`,
        routing: {
          ...defaultInput.routing,
          categories: { "AI & Innovation": teamId },
          teamNames: { [teamId]: teamName },
          directSessionDurationMinutes: 30,
          passwordHash: null,
        },
      });
      const workspace = await service.getAdminWorkspace(viewer, formId);
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.prepare(
          `UPDATE evaluation_teams SET name = ?
            WHERE id = ? AND event_id = ?`,
        )
          .bind(`${teamName} changed`, teamId, viewer.eventId)
          .run();
      });

      await expect(
        new SubmissionService(racingEnv).publishForm(
          viewer,
          formId,
          workspace!.revision,
          workspace!.draftVersion.revision,
        ),
      ).rejects.toBeInstanceOf(SubmissionRevisionConflictError);
      await expect(
        testEnv.DB.prepare(
          `SELECT form.status,
                  (SELECT COUNT(*) FROM form_versions version
                    WHERE version.form_id = form.id
                      AND version.status = 'published') AS publishedCount
             FROM form_definitions form
            WHERE form.id = ? AND form.event_id = ?`,
        )
          .bind(formId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ status: "draft", publishedCount: 0 });
    });
  });

  describe("form authoring workflows", () => {
    it("rejects malformed answer shapes and overlong titles before changing the draft", async () => {
      const schema = {
        ...DEFAULT_FORM_SCHEMA,
        fields: [
          ...DEFAULT_FORM_SCHEMA.fields,
          {
            id: "topics",
            label: "Topics",
            type: "multi_select" as const,
            required: false,
            help: "",
            options: ["Operations", "Design"],
            condition: null,
            sectionId: DEFAULT_FORM_SCHEMA.sections[0]!.id,
          },
        ],
      };
      const { service, id, slug } = await publishedForm({ schema });
      const applicant = await verifiedApplicant(service, slug);
      const draftId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === draftId)!;
      const base = {
        submissionId: draftId,
        revision: draft.revision,
        speakers: [{ name: "Applicant", email: applicant.email }],
      };

      await expect(
        service.saveDraft(slug, applicant, {
          ...base,
          answers: { ...validAnswers, title: ["Array", "title"] },
        }),
      ).rejects.toThrow("Session title must contain a single value");
      await expect(
        service.saveDraft(slug, applicant, {
          ...base,
          answers: { ...validAnswers, title: "T".repeat(181) },
        }),
      ).rejects.toThrow("at most 180 characters");
      await expect(
        service.saveDraft(slug, applicant, {
          ...base,
          answers: { ...validAnswers, topics: "Operations" },
        }),
      ).rejects.toThrow("Topics must contain a list of choices");

      await expect(
        env.DB.prepare(
          "SELECT revision, answers_json AS answersJson FROM submissions WHERE id = ?",
        )
          .bind(draftId)
          .first(),
      ).resolves.toEqual({ revision: 1, answersJson: "{}" });
    });
  });

  describe("form authoring workflows", () => {
    it("rejects a stale direct-session format before changing the applicant draft", async () => {
      const { service, id, slug, testEnv } = await publishedForm({
        kind: "direct_session",
      });
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      )[0]!;
      const event = await testEnv.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ sessionFormatsJson: string }>();
      const formats = JSON.parse(event!.sessionFormatsJson) as Array<{
        key: string;
      }>;
      await testEnv.DB.prepare(
        "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
      )
        .bind(
          JSON.stringify(
            formats.filter((format) => format.key !== "presentation"),
          ),
          viewer.eventId,
          viewer.organisationId,
        )
        .run();

      try {
        await expect(
          service.submitDraft(slug, applicant, {
            submissionId,
            revision: draft.revision,
            answers: directSessionAnswers,
            speakers: [{ name: applicant.name, email: applicant.email }],
          }),
        ).rejects.toThrow(/Presentation.*not configured/i);
        await expect(
          testEnv.DB.prepare(
            "SELECT status, revision FROM submissions WHERE id = ? AND event_id = ?",
          )
            .bind(submissionId, viewer.eventId)
            .first(),
        ).resolves.toEqual({ status: "draft", revision: draft.revision });
      } finally {
        await testEnv.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(
            event!.sessionFormatsJson,
            viewer.eventId,
            viewer.organisationId,
          )
          .run();
      }
    });
  });

  describe("form authoring workflows", () => {
    it("uses configured direct-session formats and their default durations", async () => {
      const { service } = await publishedForm();
      const event = await env.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const configuredFormats = JSON.parse(event!.sessionFormatsJson) as Array<
        Record<string, unknown>
      >;
      configuredFormats.push({
        key: "roundtable",
        label: "Roundtable",
        defaultDurationMinutes: 75,
        position: configuredFormats.length,
      });
      await env.DB.prepare(
        "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
      )
        .bind(
          JSON.stringify(configuredFormats),
          viewer.eventId,
          viewer.organisationId,
        )
        .run();

      const suffix = crypto.randomUUID();
      const created = await service.createDirectSession(viewer, {
        idempotencyKey: `configured-format-${suffix}`,
        title: "Configured roundtable",
        description: "Uses the event-owned duration default.",
        format: "roundtable",
        trackId: "demo-track-ai",
        speakers: [
          {
            name: "Configured Speaker",
            email: `configured-${suffix}@example.com`,
            biography: "",
          },
        ],
      });
      await expect(
        env.DB.prepare(
          "SELECT format, duration_minutes AS durationMinutes FROM sessions WHERE id = ? AND event_id = ?",
        )
          .bind(created.sessionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ format: "roundtable", durationMinutes: 75 });

      const rejectedIdempotencyKey = `unconfigured-format-${suffix}`;
      await expect(
        service.createDirectSession(viewer, {
          idempotencyKey: rejectedIdempotencyKey,
          title: "Unknown format session",
          format: "not-configured",
          trackId: "demo-track-ai",
          speakers: [
            {
              name: "Unknown Format Speaker",
              email: `unknown-${suffix}@example.com`,
              biography: "",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(SubmissionStateError);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM idempotency_records
            WHERE event_id = ? AND idempotency_key = ?`,
        )
          .bind(viewer.eventId, rejectedIdempotencyKey)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });

    it("does not create a direct session from a stale event-format snapshot", async () => {
      const { testEnv } = await publishedForm();
      const event = await testEnv.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ sessionFormatsJson: string }>();
      const suffix = crypto.randomUUID();
      const title = `Stale configured session ${suffix}`;
      const idempotencyKey = `stale-format-${suffix}`;
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.prepare(
          "UPDATE events SET session_formats_json = '[]' WHERE id = ? AND organisation_id = ?",
        )
          .bind(viewer.eventId, viewer.organisationId)
          .run();
      }) as unknown as CloudflareEnvironment;

      try {
        await expect(
          new SubmissionService(racingEnv).createDirectSession(viewer, {
            idempotencyKey,
            title,
            format: "presentation",
            trackId: "demo-track-ai",
            speakers: [
              {
                name: "Stale Format Speaker",
                email: `stale-format-${suffix}@example.com`,
                biography: "",
              },
            ],
          }),
        ).rejects.toThrow(/event changed/i);
        await expect(
          testEnv.DB.prepare(
            `SELECT
               (SELECT COUNT(*) FROM sessions WHERE event_id = ? AND title = ?) AS sessionCount,
               (SELECT COUNT(*) FROM idempotency_records
                 WHERE event_id = ? AND idempotency_key = ?) AS commandCount`,
          )
            .bind(viewer.eventId, title, viewer.eventId, idempotencyKey)
            .first(),
        ).resolves.toEqual({ sessionCount: 0, commandCount: 0 });
      } finally {
        await testEnv.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(
            event!.sessionFormatsJson,
            viewer.eventId,
            viewer.organisationId,
          )
          .run();
      }
    });
  });
});

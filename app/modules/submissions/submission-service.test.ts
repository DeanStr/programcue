import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
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
  const input = {
    ...service.defaultFormInput("email_verified"),
    publicSlug: `test-${token}`,
    name: `Test form ${token}`,
    ...overrides,
  };
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
  category: "AI & Innovation",
  format: "Presentation",
  video: "https://example.com/pitch",
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
      await expect(service.getDefaultFormInput(viewer)).resolves.toMatchObject({
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

  it("counts submitted applications only against their own form", async () => {
    const first = await publishedForm();
    const second = await publishedForm();
    const applicant = await verifiedApplicant(first.service, first.slug);
    const submissionId = await first.service.createDraft(first.slug, applicant);
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

  it.each([
    {
      missing: "RESEND_API_KEY",
      RESEND_API_KEY: undefined,
      AUTH_EMAIL_FROM: "Program Cue <no-reply@example.com>",
    },
    {
      missing: "AUTH_EMAIL_FROM",
      RESEND_API_KEY: "submission-test-resend-key",
      AUTH_EMAIL_FROM: "   ",
    },
  ])(
    "does not create applicant verification state when production $missing is missing",
    async (configuration) => {
      const { service, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const email = `unconfigured-${crypto.randomUUID()}@example.com`;
      const productionEnv = {
        ...testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        BETTER_AUTH_SECRET:
          "applicant-session-production-secret-at-least-32-characters",
        RESEND_API_KEY: configuration.RESEND_API_KEY,
        AUTH_EMAIL_FROM: configuration.AUTH_EMAIL_FROM,
      } as unknown as CloudflareEnvironment;

      await expect(
        new ApplicantSessionService(productionEnv).requestCode(form, email, ""),
      ).rejects.toBeInstanceOf(ApplicantConfigurationError);
      const state = await testEnv.DB.prepare(
        `
      SELECT
        (SELECT COUNT(*) FROM people WHERE email = ? COLLATE NOCASE) AS personCount,
        (SELECT COUNT(*) FROM submission_email_verifications
          WHERE event_id = ? AND email = ? COLLATE NOCASE) AS verificationCount
    `,
      )
        .bind(email, form.eventId, email)
        .first<{ personCount: number; verificationCount: number }>();
      expect(state).toEqual({ personCount: 0, verificationCount: 0 });
    },
  );

  it("rejects an explicit unknown applicant draft instead of opening another draft", async () => {
    const { service, slug } = await publishedForm();
    const form = await service.getPublicForm(slug);
    const email = `selector-${crypto.randomUUID()}@example.com`;
    await service.applicants.requestCode(form, email, "");
    const verified = await service.applicants.verifyCode(form, email, "424242");
    const request = new Request(`https://example.com/apply/${slug}`, {
      headers: { cookie: verified.cookie },
    });
    const applicant = await service.applicants.get(request, form);
    expect(applicant).not.toBeNull();
    await service.createDraft(slug, applicant!);
    await service.createDraft(slug, applicant!);

    await expect(
      service.getApplicantPortal(
        slug,
        request,
        `missing-${crypto.randomUUID()}`,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getApplicantPortal(slug, request),
    ).resolves.toMatchObject({ selected: { status: "draft" } });
  });

  it("closes on the selected calendar date in the event timezone", async () => {
    const { service, id, slug } = await publishedForm({
      closeDate: "2030-06-01",
    });
    const form = await service.getPublicForm(slug);
    expect(form.eventTimezone).toBe("America/Toronto");
    expect(form.closesAt).toBe(Date.parse("2030-06-02T03:59:59Z") / 1_000);

    const workspace = await service.getAdminWorkspace(viewer, id);
    expect(SubmissionService.workspaceToInput(workspace!).closeDate).toBe(
      "2030-06-01",
    );
  });

  it("rechecks the live close boundary in the final submission commit", async () => {
    const { service, id, slug, testEnv } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const submissionId = await service.createDraft(slug, applicant);
    const draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((candidate) => candidate.id === submissionId)!;
    const form = await service.getPublicForm(slug);
    const racingEnv = withNthBatchRace(testEnv, 2, async () => {
      await testEnv.DB.prepare(
        `
        UPDATE form_definitions SET closes_at = unixepoch() - 1
         WHERE id = ? AND event_id = ?
      `,
      )
        .bind(form.id, form.eventId)
        .run();
    });

    let savedError: unknown;
    try {
      await new D1SubmissionRepository(racingEnv).submitDraft(form, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
    } catch (error) {
      savedError = error;
    }
    expect(savedError).toBeInstanceOf(SubmissionDraftSavedError);
    expect(savedError).toMatchObject({
      submissionId,
      draftRevision: draft.revision + 1,
    });

    const state = await testEnv.DB.prepare(
      `
      SELECT s.status, s.revision, s.answers_json AS answersJson,
             (SELECT COUNT(*) FROM communications c
               WHERE c.event_id = s.event_id
                 AND json_extract(c.content_snapshot_json, '$.submissionId') = s.id) AS communicationCount,
             (SELECT COUNT(*) FROM operation_jobs o
               WHERE o.event_id = s.event_id AND o.type = 'submission.notification'
                 AND json_extract(o.payload_json, '$.submissionId') = s.id) AS operationCount
        FROM submissions s WHERE s.id = ?
    `,
    )
      .bind(submissionId)
      .first<{
        status: string;
        revision: number;
        answersJson: string;
        communicationCount: number;
        operationCount: number;
      }>();
    expect(state).toEqual({
      status: "draft",
      revision: draft.revision + 1,
      answersJson: JSON.stringify(validAnswers),
      communicationCount: 0,
      operationCount: 0,
    });
  });

  it("never serializes password verifiers or private routing rules to the public portal", async () => {
    const { service, slug } = await publishedForm({
      accessMode: "password_protected",
      accessPassword: "private-form-password",
    });

    const portal = await service.getApplicantPortal(
      slug,
      new Request(`https://example.com/apply/${slug}`),
    );
    expect(portal.form).not.toHaveProperty("accessPasswordHash");
    expect(portal.form.version).not.toHaveProperty("routing");
    expect(portal.selectedForm).not.toHaveProperty("accessPasswordHash");
    expect(JSON.stringify(portal)).not.toContain("passwordHash");
  });

  it("rejects short form passwords before persisting a draft", async () => {
    const { service, testEnv } = await publishedForm();
    const publicSlug = `short-password-${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      service.saveForm(viewer, {
        ...service.defaultFormInput("email_verified"),
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
        id, organisation_id, name, slug, timezone, starts_at, ends_at
      ) VALUES (?, ?, 'Non-default form event', ?, 'UTC',
                unixepoch('2027-01-10T00:00:00Z'),
                unixepoch('2027-01-11T23:59:59Z'))
    `,
    )
      .bind(eventId, viewer.organisationId, `non-default-event-${token}`)
      .run();

    const formId = await service.saveForm(eventViewer, {
      ...service.defaultFormInput("email_verified"),
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
        ...service.defaultFormInput("email_verified"),
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
    const oldSessionRequest = new Request(`https://example.com/apply/${slug}`, {
      headers: { cookie: verified.cookie.split(";")[0] },
    });
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

  it("consumes a verification code exactly once under concurrent redemption", async () => {
    const { service, slug } = await publishedForm();
    const form = await service.getPublicForm(slug);
    const email = `concurrent-${crypto.randomUUID()}@example.com`;
    await service.applicants.requestCode(form, email, "");

    const attempts = await Promise.allSettled([
      service.applicants.verifyCode(form, email, "424242"),
      service.applicants.verifyCode(form, email, "424242"),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);

    const identifierPrefix = `application-session:${form.id}:`;
    const sessionCount = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM verification_tokens
       WHERE substr(identifier, 1, length(?)) = ?
    `,
    )
      .bind(identifierPrefix, identifierPrefix)
      .first<{ count: number }>();
    expect(sessionCount?.count).toBe(1);
    await expect(
      service.applicants.verifyCode(form, email, "424242"),
    ).rejects.toThrow("invalid or expired");
  });

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
    const { service, id, slug } = await publishedForm();
    const workspace = await service.getAdminWorkspace(viewer, id);
    const attempts = await Promise.allSettled([
      service.repository.publishForm(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        workspace!.revision,
        workspace!.draftVersion.revision,
      ),
      service.repository.publishForm(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        workspace!.revision,
        workspace!.draftVersion.revision,
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

  it("keeps a submission confirmation terminal when a stale duplicate resumes materialisation", async () => {
    const { service, id, slug, queued, testEnv } = await publishedForm();
    const communications = new CommunicationService(testEnv);
    const template = await communications.saveTemplate(viewer, {
      name: "Submission received",
      category: "submission_confirmation",
      subject: "We received {{submission.title}}",
      content: {
        body: "Hi {{recipient.firstName}}, your application {{submission.title}} is safely recorded.",
        physicalAddress: "100 Programme Way, Toronto",
      },
    });
    await communications.publishTemplate(viewer, template.versionId);
    await env.DB.prepare(
      `
      INSERT OR IGNORE INTO sender_profiles (
        id, event_id, name, from_name, from_email, provider, status, created_at, updated_at
      ) VALUES (?, ?, 'Submission confirmations', 'Program Cue', 'submissions@example.com',
                'resend', 'verified', unixepoch(), unixepoch())
    `,
    )
      .bind(`sender-submission-${crypto.randomUUID()}`, viewer.eventId)
      .run();
    const applicant = await verifiedApplicant(service, slug);
    const firstId = await service.createDraft(slug, applicant);
    const secondId = await service.createDraft(slug, applicant);
    expect(
      await service.repository.getApplicantDrafts(id, applicant),
    ).toHaveLength(2);

    const first = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((draft) => draft.id === firstId)!;
    const speakers = [
      { name: "Avery Applicant", email: applicant.email },
      { name: "Casey Co-speaker", email: "casey@example.com" },
    ];
    const submitted = await service.submitDraft(slug, applicant, {
      submissionId: firstId,
      revision: first.revision,
      answers: validAnswers,
      speakers,
    });
    expect(submitted.confirmation.status).toBe("queued");
    expect(
      await env.DB.prepare(
        `SELECT action, organisation_id AS organisationId
           FROM audit_events
          WHERE entity_id = ?
            AND action IN ('submission.draft.saved','submission.submitted')
          ORDER BY created_at, action`,
      )
        .bind(firstId)
        .all<{ action: string; organisationId: string | null }>(),
    ).toMatchObject({
      results: [
        {
          action: "submission.draft.saved",
          organisationId: viewer.organisationId,
        },
        {
          action: "submission.submitted",
          organisationId: viewer.organisationId,
        },
      ],
    });
    expect(queued).toHaveLength(1);
    const providerRequests: Array<Record<string, unknown>> = [];
    const provider = new ResendEmailProvider(
      "submission-provider-key",
      async (_input, init) => {
        providerRequests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return Response.json({ id: "resend-submission-confirmation-001" });
      },
    );
    let releaseStaleMaterialisation!: () => void;
    const staleMaterialisationReleased = new Promise<void>((resolve) => {
      releaseStaleMaterialisation = resolve;
    });
    let staleMaterialisationReachedResolve!: () => void;
    const staleMaterialisationReached = new Promise<void>((resolve) => {
      staleMaterialisationReachedResolve = resolve;
    });
    let interceptedMaterialisation = false;
    const delayedDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!interceptedMaterialisation) {
              interceptedMaterialisation = true;
              staleMaterialisationReachedResolve();
              await staleMaterialisationReleased;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const staleWorker = processSubmissionNotification(
      queued[0],
      { ...testEnv, DB: delayedDb },
      { resend: provider },
    );
    await staleMaterialisationReached;
    try {
      await processSubmissionNotification(queued[0], testEnv, {
        resend: provider,
      });
    } finally {
      releaseStaleMaterialisation();
    }
    await staleWorker;
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({
      to: [applicant.email],
      subject: `We received ${validAnswers.title}`,
    });

    const saved = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((draft) => draft.id === firstId)!;
    expect(saved.status).toBe("submitted");
    expect(saved.versionNumber).toBe(1);
    expect(saved.speakers).toMatchObject([
      { email: applicant.email, invitationStatus: "claimed", isPrimary: true },
      {
        email: "casey@example.com",
        invitationStatus: "pending",
        isPrimary: false,
      },
    ]);
    expect(
      (
        await service.listAdminSubmissions(viewer, { status: "submitted" })
      ).some((submission) => submission.id === firstId),
    ).toBe(true);
    const coSpeaker = await verifiedApplicant(
      service,
      slug,
      "casey@example.com",
    );
    const invitations = await service.repository.getCoSpeakerInvitations(
      id,
      coSpeaker,
    );
    expect(invitations).toMatchObject([
      { submissionId: firstId, submissionTitle: validAnswers.title },
    ]);
    await service.claimCoSpeaker(slug, coSpeaker, invitations[0].id);
    const claimed = await env.DB.prepare(
      "SELECT person_id AS personId, invitation_status AS status FROM submission_speakers WHERE id = ?",
    )
      .bind(invitations[0].id)
      .first<{ personId: string; status: string }>();
    expect(claimed).toEqual({
      personId: coSpeaker.personId,
      status: "claimed",
    });
    const confirmation = await env.DB.prepare(
      `
      SELECT c.status, c.idempotency_key AS idempotencyKey, d.provider_message_id AS providerMessageId,
             o.status AS operationStatus
        FROM communications c
        JOIN communication_deliveries d ON d.communication_id = c.id
        JOIN operation_jobs o ON o.id = c.operation_id
       WHERE c.idempotency_key = ?
    `,
    )
      .bind(`submission-confirmation:${firstId}`)
      .first<{
        status: string;
        idempotencyKey: string;
        providerMessageId: string;
        operationStatus: string;
      }>();
    expect(confirmation).toEqual({
      status: "sent",
      idempotencyKey: `submission-confirmation:${firstId}`,
      providerMessageId: "resend-submission-confirmation-001",
      operationStatus: "completed",
    });
    expect(secondId).not.toBe(firstId);
  });

  it("preserves a claimed co-speaker identity when the submitter saves the draft again", async () => {
    const { service, id, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const draftId = await service.createDraft(slug, applicant);
    let draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((item) => item.id === draftId)!;
    const speakers = [
      { name: applicant.name, email: applicant.email },
      { name: "Casey Claimed", email: "casey-claimed@example.com" },
    ];
    await service.saveDraft(slug, applicant, {
      submissionId: draftId,
      revision: draft.revision,
      answers: validAnswers,
      speakers,
    });
    const coSpeaker = await verifiedApplicant(
      service,
      slug,
      "casey-claimed@example.com",
    );
    const invitation = (
      await service.repository.getCoSpeakerInvitations(id, coSpeaker)
    )[0];
    await service.claimCoSpeaker(slug, coSpeaker, invitation.id);

    draft = (await service.repository.getApplicantDrafts(id, applicant)).find(
      (item) => item.id === draftId,
    )!;
    await service.saveDraft(slug, applicant, {
      submissionId: draftId,
      revision: draft.revision,
      answers: { ...validAnswers, title: "Updated after claim" },
      speakers: [speakers[0], { ...speakers[1], name: "Casey Updated" }],
    });
    const preserved = await env.DB.prepare(
      `
      SELECT person_id AS personId, invitation_status AS invitationStatus, display_name AS displayName
        FROM submission_speakers WHERE submission_id = ? AND email = ? COLLATE NOCASE
    `,
    )
      .bind(draftId, coSpeaker.email)
      .first<{
        personId: string | null;
        invitationStatus: string;
        displayName: string;
      }>();
    expect(preserved).toEqual({
      personId: coSpeaker.personId,
      invitationStatus: "claimed",
      displayName: "Casey Updated",
    });
  });

  it("adds a co-speaker who claims after acceptance to the generated session", async () => {
    const { service, id, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const coSpeakerEmail = `late-speaker-${crypto.randomUUID()}@example.com`;
    const submissionId = await service.createDraft(slug, applicant);
    const draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    )[0]!;
    await service.submitDraft(slug, applicant, {
      submissionId,
      revision: draft.revision,
      answers: validAnswers,
      speakers: [
        { name: "Applicant", email: applicant.email },
        { name: "Late Speaker", email: coSpeakerEmail },
      ],
    });

    const sessionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `
        UPDATE submissions SET status = 'accepted', updated_at = unixepoch()
         WHERE id = ? AND status = 'submitted'
      `,
      ).bind(submissionId),
      env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, source_submission_id, title, slug, description, format,
          duration_minutes, status, visibility, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'Accepted proposal', ?, '', 'presentation', 60,
                  'unscheduled', 'public', 1, unixepoch(), unixepoch())
      `,
      ).bind(sessionId, viewer.eventId, submissionId, `accepted-${sessionId}`),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        )
        SELECT ?, event_id, person_id, 0, 'Primary speaker', 'public'
          FROM submission_speakers
         WHERE submission_id = ? AND is_primary = 1 AND person_id IS NOT NULL
      `,
      ).bind(sessionId, submissionId),
    ]);

    const coSpeaker = await verifiedApplicant(service, slug, coSpeakerEmail);
    const invitation = (
      await service.repository.getCoSpeakerInvitations(id, coSpeaker)
    )[0]!;
    await service.claimCoSpeaker(slug, coSpeaker, invitation.id);

    const relationship = await env.DB.prepare(
      `
      SELECT position, role_label AS roleLabel, visibility
        FROM session_speakers
       WHERE session_id = ? AND person_id = ?
    `,
    )
      .bind(sessionId, coSpeaker.personId)
      .first<{
        position: number;
        roleLabel: string;
        visibility: string;
      }>();
    expect(relationship).toEqual({
      position: 1,
      roleLabel: "Co-speaker",
      visibility: "public",
    });

    const lockedSpeakerId = crypto.randomUUID();
    const lockedSpeakerEmail = `locked-speaker-${crypto.randomUUID()}@example.com`;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sessions SET status = 'published' WHERE id = ? AND event_id = ?",
      ).bind(sessionId, viewer.eventId),
      env.DB.prepare(
        `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, email, display_name, position,
          invitation_status, is_primary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'Locked Speaker', 2, 'pending', 0,
                  unixepoch(), unixepoch())
      `,
      ).bind(lockedSpeakerId, viewer.eventId, submissionId, lockedSpeakerEmail),
    ]);
    const lockedSpeaker = await verifiedApplicant(
      service,
      slug,
      lockedSpeakerEmail,
    );

    const resourceService = new ResourceService(
      env as unknown as CloudflareEnvironment,
    );
    const resourceId = await resourceService.save(viewer, {
      title: "Claim boundary briefing",
      slug: `claim-boundary-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "accepted_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Read before the event." }],
          },
        ],
      },
      embedUrls: [],
    });
    const resourceDraft = (
      await resourceService.getAdminWorkspace(viewer, resourceId)
    ).selected!;
    await resourceService.publish(viewer, resourceId, resourceDraft.revision);

    const unrelatedSessionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, description, format, duration_minutes,
          status, visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Unrelated session', ?, '', 'presentation', 30,
                  'unscheduled', 'public', 1, unixepoch(), unixepoch())
      `,
      ).bind(
        unrelatedSessionId,
        viewer.eventId,
        `unrelated-${unrelatedSessionId}`,
      ),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        ) VALUES (?, ?, ?, 0, 'Speaker', 'public')
      `,
      ).bind(unrelatedSessionId, viewer.eventId, lockedSpeaker.personId),
    ]);
    const acknowledgementTaskId = `resource-ack:${resourceId}:${lockedSpeaker.personId}`;
    await expect(
      env.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(acknowledgementTaskId)
        .first(),
    ).resolves.toBeNull();

    await expect(
      service.claimCoSpeaker(slug, lockedSpeaker, lockedSpeakerId),
    ).rejects.toThrow(/speaker list is locked/i);
    await expect(
      env.DB.prepare(
        `
        SELECT invitation_status AS status, person_id AS personId,
               (SELECT COUNT(*) FROM session_speakers relationship
                 WHERE relationship.session_id = ?
                   AND relationship.person_id = ?) AS relationshipCount
          FROM submission_speakers WHERE id = ?
      `,
      )
        .bind(sessionId, lockedSpeaker.personId, lockedSpeakerId)
        .first(),
    ).resolves.toEqual({
      status: "pending",
      personId: null,
      relationshipCount: 0,
    });
    await expect(
      env.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(acknowledgementTaskId)
        .first(),
    ).resolves.toBeNull();
  });

  it("requires visible conditional answers and rejects stale draft revisions", async () => {
    const { service, id, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const draftId = await service.createDraft(slug, applicant);
    const draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    )[0];
    const workshopAnswers = { ...validAnswers, format: "Workshop" };
    await expect(
      service.submitDraft(slug, applicant, {
        submissionId: draftId,
        revision: draft.revision,
        answers: workshopAnswers,
        speakers: [{ name: "Applicant", email: applicant.email }],
      }),
    ).rejects.toThrow("Materials and room setup is required");

    await service.saveDraft(slug, applicant, {
      submissionId: draftId,
      revision: draft.revision,
      answers: validAnswers,
      speakers: [{ name: "Applicant", email: applicant.email }],
    });
    await expect(
      service.saveDraft(slug, applicant, {
        submissionId: draftId,
        revision: draft.revision,
        answers: { ...validAnswers, title: "Stale title" },
        speakers: [{ name: "Applicant", email: applicant.email }],
      }),
    ).rejects.toBeInstanceOf(SubmissionRevisionConflictError);
  });

  it("rejects duplicate speaker emails before changing the draft", async () => {
    const { service, id, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const draftId = await service.createDraft(slug, applicant);
    const draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((candidate) => candidate.id === draftId)!;

    await expect(
      service.saveDraft(slug, applicant, {
        submissionId: draftId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          { name: "Primary", email: applicant.email },
          { name: "Duplicate", email: applicant.email.toUpperCase() },
        ],
      }),
    ).rejects.toThrow(/different email address/i);

    expect(
      await env.DB.prepare(
        `SELECT s.revision,
                (SELECT COUNT(*) FROM submission_speakers ss WHERE ss.submission_id = s.id) AS speakerCount
           FROM submissions s WHERE s.id = ?`,
      )
        .bind(draftId)
        .first(),
    ).toEqual({ revision: 1, speakerCount: 1 });
  });

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

  it("removes hidden and unknown answers from the submitted snapshot", async () => {
    const { service, id, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const draftId = await service.createDraft(slug, applicant);
    const draft = (
      await service.repository.getApplicantDrafts(id, applicant)
    ).find((candidate) => candidate.id === draftId)!;

    await service.submitDraft(slug, applicant, {
      submissionId: draftId,
      revision: draft.revision,
      answers: {
        ...validAnswers,
        materials: "Do not disclose this abandoned workshop setup.",
        unrecognised_field: "This was never part of the published form.",
      },
      speakers: [{ name: "Applicant", email: applicant.email }],
    });

    const stored = await env.DB.prepare(
      `SELECT answers_json AS answersJson, submitted_snapshot_json AS snapshotJson
         FROM submissions WHERE id = ?`,
    )
      .bind(draftId)
      .first<{ answersJson: string; snapshotJson: string }>();
    expect(JSON.parse(stored!.answersJson)).toEqual(validAnswers);
    expect(JSON.parse(stored!.snapshotJson).answers).toEqual(validAnswers);
  });

  it("keeps admin queues tenant scoped and creates audited direct sessions", async () => {
    const { service, slug } = await publishedForm();
    const applicant = await verifiedApplicant(service, slug);
    const draftId = await service.createDraft(slug, applicant);
    const current = (
      await service.repository.getApplicantDrafts(
        (await service.getPublicForm(slug)).id,
        applicant,
      )
    )[0];
    await service.submitDraft(slug, applicant, {
      submissionId: draftId,
      revision: current.revision,
      answers: validAnswers,
      speakers: [{ name: "Applicant", email: applicant.email }],
    });
    expect(
      await service.repository.listAdminSubmissions(
        "org-not-authorised",
        viewer.eventId,
        {},
      ),
    ).toEqual([]);

    const resourceService = new ResourceService(
      env as unknown as CloudflareEnvironment,
    );
    const resourceId = await resourceService.save(viewer, {
      title: "Late speaker briefing",
      slug: `late-speaker-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "accepted_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Read before the event." }],
          },
        ],
      },
      embedUrls: [],
    });
    const resourceDraft = (
      await resourceService.getAdminWorkspace(viewer, resourceId)
    ).selected!;
    await resourceService.publish(viewer, resourceId, resourceDraft.revision);

    const sessionId = await service.createDirectSession(viewer, {
      title: "Sponsor perspective",
      description: "Guaranteed programme contribution.",
      format: "presentation",
      durationMinutes: 30,
      speakerName: "Morgan Sponsor",
      speakerEmail: "morgan-sponsor@example.com",
    });
    const session = await env.DB.prepare(
      "SELECT status, source_submission_id AS sourceSubmissionId FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ status: string; sourceSubmissionId: string | null }>();
    expect(session).toEqual({
      status: "unscheduled",
      sourceSubmissionId: null,
    });
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE entity_id = ?",
    )
      .bind(sessionId)
      .first<{ action: string }>();
    expect(audit?.action).toBe("session.direct.created");
    const acknowledgementTask = await env.DB.prepare(
      `
      SELECT task.status
        FROM task_instances task
        JOIN people person ON person.id = task.target_id
       WHERE task.template_id = ? AND person.email = ? COLLATE NOCASE
    `,
    )
      .bind(`resource-ack:${resourceId}`, "morgan-sponsor@example.com")
      .first<{ status: string }>();
    expect(acknowledgementTask?.status).toBe("not_started");
  });
});

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
import { DEFAULT_FORM_SCHEMA, routingSchema } from "./submission-schema";
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

it("reconciles protected draft track choices by stable event-track identity", async () => {
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

  const reconciled = SubmissionService.synchronizeFormTrackChoices(input, [
    { id: "demo-track-ai", name: "Applied AI" },
    { id: "demo-track-experience", name: "Experience Design" },
    { id: "track-new", name: "New track" },
  ]);

  expect(
    reconciled.schema.fields.find((field) => field.id === "category")!.options,
  ).toEqual(["Applied AI"]);
  expect(reconciled.routing).toMatchObject({
    categories: { "Applied AI": "team-ai" },
    trackIds: { "Applied AI": "demo-track-ai" },
    trackNames: { "demo-track-ai": "Applied AI" },
  });

  const corrupt = structuredClone(input);
  delete corrupt.routing.trackNames["demo-track-ai"];
  expect(() =>
    SubmissionService.synchronizeFormTrackChoices(corrupt, [
      { id: "demo-track-ai", name: "Applied AI" },
    ]),
  ).toThrow(/inconsistent saved event-track identity/i);
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

describe("Submissions D1 vertical slice", () => {
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

  describe("form authoring workflows", () => {
    it("resolves the current event's latest published application entry", async () => {
      const { service, slug, testEnv } = await publishedForm();
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

  describe("applicant draft and submission workflows", () => {
    it("withdraws an owned submitted application with CAS and preserves its immutable snapshot", async () => {
      const { service, id, slug } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
      const submitted = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const result = await service.withdrawSubmission(slug, applicant, {
        submissionId,
        revision: submitted.revision,
      });
      expect(result).toMatchObject({
        submissionId,
        eventId: viewer.eventId,
        revision: submitted.revision + 1,
      });
      await expect(
        env.DB.prepare(
          `SELECT status, revision, submitted_snapshot_json AS snapshot,
                withdrawn_at AS withdrawnAt
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toMatchObject({
        status: "withdrawn",
        revision: submitted.revision + 1,
        snapshot: expect.stringContaining('"formVersionId"'),
        withdrawnAt: expect.any(Number),
      });
      await expect(
        env.DB.prepare(
          `SELECT save_kind AS saveKind FROM submission_revisions
          WHERE submission_id = ? AND revision_number = ?`,
        )
          .bind(submissionId, submitted.revision + 1)
          .first(),
      ).resolves.toEqual({ saveKind: "withdrawn" });
      await expect(
        service.withdrawSubmission(slug, applicant, {
          submissionId,
          revision: submitted.revision,
        }),
      ).resolves.toEqual(result);
    });

    it("rejects an explicit unknown applicant draft instead of opening another draft", async () => {
      const { service, slug } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const email = `selector-${crypto.randomUUID()}@example.com`;
      await service.applicants.requestCode(form, email, "");
      const verified = await service.applicants.verifyCode(
        form,
        email,
        "424242",
      );
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

    it("replays one authenticated draft for the same D1 intent", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const intentId = crypto.randomUUID();

      const first = await service.createDraft(slug, applicant, intentId);
      const replay = await service.createDraft(slug, applicant, intentId);

      expect(replay).toBe(first);
      expect(first).toMatch(/^draft-[a-f0-9]{64}$/u);
      expect(first).not.toContain(intentId);
      await expect(
        testEnv.DB.prepare(
          `SELECT
           (SELECT COUNT(*) FROM submissions submission
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE submission.id = ? AND submission.event_id = ?
              AND version.form_id = ?
              AND submission.submitter_person_id = ?) AS submissionCount,
           (SELECT COUNT(*) FROM submission_revisions
             WHERE submission_id = ? AND revision_number = 1) AS revisionCount,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND entity_id = ?
               AND action = 'submission.draft.created') AS auditCount`,
        )
          .bind(
            first,
            viewer.eventId,
            id,
            applicant.personId,
            first,
            viewer.eventId,
            first,
          )
          .first(),
      ).resolves.toEqual({
        submissionCount: 1,
        revisionCount: 1,
        auditCount: 1,
      });
    });

    it("converges concurrent authenticated D1 draft creation", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const intentId = crypto.randomUUID();

      const [first, second] = await Promise.all([
        service.createDraft(slug, applicant, intentId),
        service.createDraft(slug, applicant, intentId),
      ]);

      expect(second).toBe(first);
      await expect(
        testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM submissions WHERE id = ? AND event_id = ?",
        )
          .bind(first, viewer.eventId)
          .first(),
      ).resolves.toEqual({ count: 1 });
    });

    it("rejects an applicant draft whose latest speaker revision is missing", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      await testEnv.DB.prepare(
        "DELETE FROM submission_revisions WHERE submission_id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .run();

      await expect(
        service.repository.getApplicantDrafts(id, applicant),
      ).rejects.toThrow(
        `Submission ${submissionId} is missing its speaker revision snapshot.`,
      );
    });
  });

  describe("additional workflow coverage", () => {
    it("keeps the verified applicant as the primary speaker", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const payload = {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          {
            name: "Different primary speaker",
            email: `different-${crypto.randomUUID()}@example.com`,
          },
        ],
      };

      await expect(service.saveDraft(slug, applicant, payload)).rejects.toThrow(
        "The primary speaker email must match the verified applicant email.",
      );
      await expect(
        service.submitDraft(slug, applicant, payload),
      ).rejects.toThrow(
        "The primary speaker email must match the verified applicant email.",
      );

      await expect(
        testEnv.DB.prepare(
          `SELECT revision,
                (SELECT COUNT(*) FROM submission_speakers speaker
                  WHERE speaker.submission_id = submissions.id) AS speakerCount
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ revision: draft.revision, speakerCount: 1 });
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
        await new D1SubmissionRepository(racingEnv).submitDraft(
          form,
          applicant,
          {
            submissionId,
            revision: draft.revision,
            answers: validAnswers,
            speakers: [{ name: applicant.name, email: applicant.email }],
          },
          {
            trackSelections: [
              {
                trackId: form.version.routing.trackIds["AI & Innovation"]!,
                trackName: "AI & Innovation",
              },
            ],
            routedTeamIds: [],
            upload: null,
          },
        );
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
  });

  describe("routing workflows", () => {
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

  describe("applicant draft and submission workflows", () => {
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
  });

  describe("form authoring workflows", () => {
    it("publishes immutable versions while old application drafts retain their original schema", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
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

    it("rejects a direct-session publication when its event formats changed", async () => {
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

  describe("additional workflow coverage", () => {
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
      expect(queued).toHaveLength(2);
      const confirmationMessage = queued.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "submission.notification",
      );
      expect(confirmationMessage).toBeDefined();
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
        confirmationMessage,
        { ...testEnv, DB: delayedDb },
        { email: provider },
      );
      await staleMaterialisationReached;
      try {
        await processSubmissionNotification(confirmationMessage, testEnv, {
          email: provider,
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
        {
          email: applicant.email,
          invitationStatus: "claimed",
          isPrimary: true,
        },
        {
          email: "casey@example.com",
          invitationStatus: "sent",
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

    it("requires the operations Queue before saving or finalising a submission", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const before = await testEnv.DB.prepare(
        `SELECT status, revision, answers_json AS answersJson
         FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ status: string; revision: number; answersJson: string }>();
      expect(before).not.toBeNull();
      const unavailableEnvironment = {
        ...testEnv,
        OPERATIONS_QUEUE: undefined,
      } as unknown as CloudflareEnvironment;

      await expect(
        new SubmissionService(unavailableEnvironment).submitDraft(
          slug,
          applicant,
          {
            submissionId,
            revision: before!.revision,
            answers: validAnswers,
            speakers: [{ name: "Queue Test", email: applicant.email }],
          },
        ),
      ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
      await expect(
        testEnv.DB.prepare(
          `SELECT status, revision, answers_json AS answersJson
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual(before);
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM operation_jobs
          WHERE event_id = ? AND idempotency_key = ?`,
        )
          .bind(viewer.eventId, `submission-confirmation:${submissionId}`)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });

    it("keeps a committed submission retryable after a transient Queue rejection", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = await testEnv.DB.prepare(
        "SELECT revision FROM submissions WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .first<{ revision: number }>();
      const rejectingEnvironment = {
        ...testEnv,
        OPERATIONS_QUEUE: {
          send: async () => {
            throw new Error("Transient Queue RPC rejection");
          },
        },
      } as unknown as CloudflareEnvironment;

      const result = await new SubmissionService(
        rejectingEnvironment,
      ).submitDraft(slug, applicant, {
        submissionId,
        revision: draft!.revision,
        answers: validAnswers,
        speakers: [{ name: "Queue Test", email: applicant.email }],
      });
      expect(result.confirmation.status).toBe("queue_failed");
      await expect(
        testEnv.DB.prepare(
          `SELECT submission.status,
                (SELECT status FROM operation_jobs operation
                  WHERE operation.id = ?) AS operationStatus
           FROM submissions submission WHERE submission.id = ?`,
        )
          .bind(result.confirmation.operationId, submissionId)
          .first(),
      ).resolves.toEqual({
        status: "submitted",
        operationStatus: "queue_failed",
      });
    });
  });

  describe("applicant draft and submission workflows", () => {
    it("keeps a co-speaker application as a draft when delivery is not configured", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await testEnv.DB.prepare(
        `UPDATE sender_profiles SET status = 'disabled'
        WHERE event_id = ? AND provider = 'resend'`,
      )
        .bind(viewer.eventId)
        .run();
      try {
        await expect(
          service.submitDraft(slug, applicant, {
            submissionId,
            revision: draft.revision,
            answers: validAnswers,
            speakers: [
              { name: applicant.name, email: applicant.email },
              {
                name: "Delivery blocked co-speaker",
                email: `delivery-blocked-${crypto.randomUUID()}@example.com`,
              },
            ],
          }),
        ).rejects.toThrow(/verified sender profile/i);
        await expect(
          testEnv.DB.prepare(
            `SELECT submission.status, submission.revision,
                  (SELECT COUNT(*) FROM communications communication
                    WHERE communication.event_id = submission.event_id
                      AND json_extract(communication.content_snapshot_json, '$.submissionId') = submission.id
                  ) AS communicationCount
             FROM submissions submission
            WHERE submission.id = ? AND submission.event_id = ?`,
          )
            .bind(submissionId, viewer.eventId)
            .first(),
        ).resolves.toEqual({
          status: "draft",
          revision: draft.revision + 1,
          communicationCount: 0,
        });
      } finally {
        await testEnv.DB.prepare(
          `UPDATE sender_profiles SET status = 'verified'
          WHERE event_id = ? AND provider = 'resend'`,
        )
          .bind(viewer.eventId)
          .run();
      }
    });
  });

  describe("co-speaker workflows", () => {
    it("does not enqueue a stale invitation when a co-speaker claims during submission", async () => {
      const { service, id, slug, queued, testEnv } = await publishedForm();
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Submission invitations', 'Program Cue',
                   'submissions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
        ).bind(`sender-submission-race-${crypto.randomUUID()}`, viewer.eventId),
        testEnv.DB.prepare(
          `UPDATE sender_profiles SET status = 'verified', updated_at = unixepoch()
          WHERE event_id = ? AND provider = 'resend'`,
        ).bind(viewer.eventId),
      ]);
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const form = await service.getPublicForm(slug);
      const coSpeakerEmail = `claimed-during-submit-${crypto.randomUUID()}@example.com`;
      const claimedPersonId = crypto.randomUUID();
      const racingEnv = withNthBatchRace(testEnv, 2, async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Claimed while submitting', 1, 'published',
                     unixepoch(), unixepoch())`,
          ).bind(claimedPersonId, coSpeakerEmail),
          testEnv.DB.prepare(
            `UPDATE submission_speakers
              SET person_id = ?, invitation_status = 'claimed',
                  claimed_at = unixepoch(), updated_at = unixepoch()
            WHERE submission_id = ? AND event_id = ?
              AND email = ? COLLATE NOCASE AND is_primary = 0`,
          ).bind(claimedPersonId, submissionId, viewer.eventId, coSpeakerEmail),
        ]);
      });

      const result = await new D1SubmissionRepository(racingEnv).submitDraft(
        form,
        applicant,
        {
          submissionId,
          revision: draft.revision,
          answers: validAnswers,
          speakers: [
            { name: applicant.name, email: applicant.email },
            { name: "Claimed while submitting", email: coSpeakerEmail },
          ],
        },
        {
          trackSelections: [
            {
              trackId: form.version.routing.trackIds["AI & Innovation"]!,
              trackName: "AI & Innovation",
            },
          ],
          routedTeamIds: [],
          upload: null,
        },
      );

      expect(result.invitations).toEqual({ queued: 0, queueFailed: 0 });
      expect(queued).toHaveLength(1);
      expect(queued).not.toContainEqual(
        expect.objectContaining({ type: "communication.send" }),
      );
      await expect(
        testEnv.DB.prepare(
          `SELECT invitation_status AS invitationStatus,
                person_id AS personId, claim_token_hash AS claimTokenHash,
                (SELECT COUNT(*) FROM communications communication
                  WHERE communication.event_id = speaker.event_id
                    AND json_extract(communication.audience_json, '$.speakerId') = speaker.id
                ) AS communicationCount
           FROM submission_speakers speaker
          WHERE speaker.submission_id = ? AND speaker.event_id = ?
            AND speaker.email = ? COLLATE NOCASE`,
        )
          .bind(submissionId, viewer.eventId, coSpeakerEmail)
          .first(),
      ).resolves.toEqual({
        invitationStatus: "claimed",
        personId: claimedPersonId,
        claimTokenHash: null,
        communicationCount: 0,
      });
    });
  });

  describe("applicant draft and submission workflows", () => {
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
      await service.updateClaimedSpeakerProfile(slug, coSpeaker, {
        revision: coSpeaker.profileRevision,
        name: "Casey Owned",
        biography: "Casey's canonical biography.",
      });

      draft = (await service.repository.getApplicantDrafts(id, applicant)).find(
        (item) => item.id === draftId,
      )!;
      expect(draft.speakers[1]).toMatchObject({
        name: "Casey Owned",
        biography: "Casey's canonical biography.",
        invitationStatus: "claimed",
      });
      await expect(
        service.saveDraft(slug, applicant, {
          submissionId: draftId,
          revision: draft.revision,
          answers: { ...validAnswers, title: "Updated after claim" },
          speakers: [
            speakers[0],
            {
              ...speakers[1],
              name: "Casey Updated",
              biography: "Submitter overwrite attempt.",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(SubmissionRevisionConflictError);
      await expect(
        service.saveDraft(slug, applicant, {
          submissionId: draftId,
          revision: draft.revision,
          answers: { ...validAnswers, title: "Updated after claim" },
          speakers: draft.speakers.map((speaker) => ({
            name: speaker.name,
            email: speaker.email,
            biography: speaker.biography,
          })),
        }),
      ).resolves.toBe(draft.revision + 1);
      const preserved = await env.DB.prepare(
        `
      SELECT speaker.person_id AS personId,
             speaker.invitation_status AS invitationStatus,
             speaker.display_name AS displayName, person.biography
        FROM submission_speakers speaker
        JOIN people person ON person.id = speaker.person_id
       WHERE speaker.submission_id = ? AND speaker.email = ? COLLATE NOCASE
    `,
      )
        .bind(draftId, coSpeaker.email)
        .first<{
          personId: string | null;
          invitationStatus: string;
          displayName: string;
          biography: string;
        }>();
      expect(preserved).toEqual({
        personId: coSpeaker.personId,
        invitationStatus: "claimed",
        displayName: "Casey Owned",
        biography: "Casey's canonical biography.",
      });
    });
  });

  describe("co-speaker workflows", () => {
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
        ).bind(
          sessionId,
          viewer.eventId,
          submissionId,
          `accepted-${sessionId}`,
        ),
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
        ).bind(
          lockedSpeakerId,
          viewer.eventId,
          submissionId,
          lockedSpeakerEmail,
        ),
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
  });

  describe("applicant draft and submission workflows", () => {
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

  describe("applicant draft and submission workflows", () => {
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

    it("authorizes native video upload only for the exact applicant draft and video field", async () => {
      const { service, slug } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const email = `upload-owner-${crypto.randomUUID()}@example.com`;
      await service.applicants.requestCode(form, email, "");
      const verified = await service.applicants.verifyCode(
        form,
        email,
        "424242",
      );
      const ownerRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: verified.cookie.split(";")[0] },
      });
      const owner = await service.applicants.get(ownerRequest, form);
      const submissionId = await service.createDraft(slug, owner!);

      await expect(
        service.authorizeApplicantMultipartUpload(
          ownerRequest,
          slug,
          submissionId,
          "video",
        ),
      ).resolves.toEqual({
        organisationId: viewer.organisationId,
        eventId: form.eventId,
        personId: owner!.personId,
        submissionId,
        fieldId: "video",
      });
      await expect(
        service.authorizeApplicantMultipartUpload(
          ownerRequest,
          slug,
          submissionId,
          "description",
        ),
      ).rejects.toMatchObject({ status: 422 });

      const otherEmail = `upload-other-${crypto.randomUUID()}@example.com`;
      await service.applicants.requestCode(form, otherEmail, "");
      const other = await service.applicants.verifyCode(
        form,
        otherEmail,
        "424242",
      );
      const otherRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: other.cookie.split(";")[0] },
      });
      await expect(
        service.authorizeApplicantMultipartUpload(
          otherRequest,
          slug,
          submissionId,
          "video",
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("submits only a clean owned native video version and snapshots its immutable reference", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const upload = await insertReadySubmissionVideo(testEnv, {
        eventId: viewer.eventId,
        submissionId,
        ownerPersonId: applicant.personId,
      });

      await expect(
        service.submitDraft(slug, applicant, {
          submissionId,
          revision: draft.revision,
          answers: { ...validAnswers, video: "" },
          speakers: [{ name: applicant.name, email: applicant.email }],
          uploads: { video: upload },
        }),
      ).resolves.toMatchObject({ submissionId });

      const stored = await testEnv.DB.prepare(
        `SELECT status, submitted_snapshot_json AS snapshotJson
         FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ status: string; snapshotJson: string }>();
      expect(stored?.status).toBe("submitted");
      expect(JSON.parse(stored!.snapshotJson).uploads).toEqual({
        video: upload,
      });
      await expect(
        service.getAdminSubmission(viewer, submissionId),
      ).resolves.toMatchObject({
        uploads: { video: upload },
      });
      const submittedDraft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId);
      expect(submittedDraft?.uploads).toEqual({ video: upload });
    });

    it("reads non-draft administration detail only from a valid immutable snapshot", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          {
            name: applicant.name,
            email: applicant.email,
            biography: "Biography captured at submission.",
          },
        ],
      });
      const stored = await testEnv.DB.prepare(
        `SELECT submitted_snapshot_json AS snapshotJson,
              form_version_id AS formVersionId
         FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ snapshotJson: string; formVersionId: string }>();
      const immutableSnapshot = JSON.parse(stored!.snapshotJson) as {
        schema: { fields: Array<{ id: string; label: string }> };
        answers: Record<string, string | string[]>;
        speakers: Array<{ email: string; biography?: string }>;
      };
      const mutableSchema = structuredClone(immutableSnapshot.schema);
      const mutableTitleField = mutableSchema.fields.find(
        (field) => field.id === "title",
      );
      if (!mutableTitleField) throw new Error("Title field is missing.");
      mutableTitleField.label = "Changed live schema label";
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `UPDATE submissions
            SET title = 'Changed live title', category = 'Changed live category',
                format = 'Changed live format', answers_json = ?
          WHERE id = ? AND event_id = ?`,
        ).bind(
          JSON.stringify({
            title: "Changed live title",
            category: "Changed live category",
            format: "Changed live format",
          }),
          submissionId,
          viewer.eventId,
        ),
        testEnv.DB.prepare(
          `UPDATE form_versions SET schema_json = ?
          WHERE id = ? AND event_id = ?`,
        ).bind(
          JSON.stringify(mutableSchema),
          stored!.formVersionId,
          viewer.eventId,
        ),
        testEnv.DB.prepare(
          `UPDATE submission_revisions SET speaker_snapshot_json = ?
          WHERE submission_id = ? AND event_id = ?`,
        ).bind(
          JSON.stringify([
            {
              name: applicant.name,
              email: applicant.email,
              biography: "Changed latest revision biography.",
            },
          ]),
          submissionId,
          viewer.eventId,
        ),
      ]);

      const detail = await service.getAdminSubmission(viewer, submissionId);
      expect(detail).toMatchObject({
        title: immutableSnapshot.answers.title,
        category: (immutableSnapshot.answers.category as string[]).join(", "),
        format: immutableSnapshot.answers.format,
        answers: immutableSnapshot.answers,
      });
      expect(
        detail?.schema?.fields.find((field) => field.id === "title")?.label,
      ).toBe(
        immutableSnapshot.schema.fields.find((field) => field.id === "title")
          ?.label,
      );
      expect(detail?.speakers[0]?.submittedBiography).toBe(
        "Biography captured at submission.",
      );

      await testEnv.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = '{}'
        WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.getAdminSubmission(viewer, submissionId),
      ).rejects.toThrow(
        `Submission ${submissionId} has an invalid immutable submitted snapshot.`,
      );
    });

    it("rechecks native video release state in the final submission CAS", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const upload = await insertReadySubmissionVideo(testEnv, {
        eventId: viewer.eventId,
        submissionId,
        ownerPersonId: applicant.personId,
      });
      const racingEnv = withNthBatchRace(testEnv, 2, async () => {
        await testEnv.DB.prepare(
          `UPDATE file_versions
            SET scan_status = 'failed', released_at = NULL
          WHERE id = ? AND event_id = ?`,
        )
          .bind(upload.versionId, viewer.eventId)
          .run();
      });

      await expect(
        new SubmissionService(racingEnv).submitDraft(slug, applicant, {
          submissionId,
          revision: draft.revision,
          answers: { ...validAnswers, video: "" },
          speakers: [{ name: applicant.name, email: applicant.email }],
          uploads: { video: upload },
        }),
      ).rejects.toBeInstanceOf(SubmissionDraftSavedError);
      await expect(
        testEnv.DB.prepare("SELECT status FROM submissions WHERE id = ?")
          .bind(submissionId)
          .first(),
      ).resolves.toEqual({ status: "draft" });
    });

    it("replays an anonymous D1 draft intent with a fresh session token", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const intentId = crypto.randomUUID();

      const first = await service.startAnonymousDraft(slug, "", intentId);
      const replay = await service.startAnonymousDraft(slug, "", intentId);

      expect(replay.draftId).toBe(first.draftId);
      expect(replay.cookie).not.toBe(first.cookie);
      expect(first.draftId).toMatch(/^draft-[a-f0-9]{64}$/u);
      const firstRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: first.cookie.split(";")[0] },
      });
      const replayRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: replay.cookie.split(";")[0] },
      });
      await expect(
        service.applicants.get(firstRequest, form),
      ).resolves.toMatchObject({ anonymousDraftId: first.draftId });
      await expect(
        service.applicants.get(replayRequest, form),
      ).resolves.toMatchObject({ anonymousDraftId: first.draftId });
      await expect(
        testEnv.DB.prepare(
          `SELECT
           (SELECT COUNT(*) FROM submissions submission
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE submission.id = ? AND submission.event_id = ?
              AND version.form_id = ? AND submission.status = 'draft'
              AND submission.submitter_person_id IS NULL
              AND submission.submitter_email IS NULL) AS submissionCount,
           (SELECT COUNT(*) FROM verification_tokens
             WHERE substr(identifier, 1, length(?)) = ?
               AND substr(identifier, -length(?)) = ?) AS tokenCount`,
        )
          .bind(
            first.draftId,
            viewer.eventId,
            id,
            `anonymous-application-session:${id}:`,
            `anonymous-application-session:${id}:`,
            `:${first.draftId}`,
            `:${first.draftId}`,
          )
          .first(),
      ).resolves.toEqual({ submissionCount: 1, tokenCount: 2 });
    });

    it("converges concurrent anonymous D1 draft creation without invalidating either response", async () => {
      const { service, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      const intentId = crypto.randomUUID();

      const [first, second] = await Promise.all([
        service.startAnonymousDraft(slug, "", intentId),
        service.startAnonymousDraft(slug, "", intentId),
      ]);

      expect(second.draftId).toBe(first.draftId);
      expect(second.cookie).not.toBe(first.cookie);
      for (const cookie of [first.cookie, second.cookie]) {
        await expect(
          service.applicants.get(
            new Request(`https://example.com/apply/${slug}`, {
              headers: { cookie: cookie.split(";")[0] },
            }),
            form,
          ),
        ).resolves.toMatchObject({ anonymousDraftId: first.draftId });
      }
      await expect(
        testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM submissions WHERE id = ? AND event_id = ?",
        )
          .bind(first.draftId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ count: 1 });
    });

    it("keeps an anonymous draft browser-bound until email verification transfers ownership", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const form = await service.getPublicForm(slug);
      expect(form.allowAnonymousDrafts).toBe(true);

      const started = await service.startAnonymousDraft(slug, "");
      const anonymousRequest = new Request(
        `https://example.com/apply/${slug}`,
        {
          headers: { cookie: started.cookie.split(";")[0] },
        },
      );
      const anonymous = await service.applicants.get(anonymousRequest, form);
      expect(anonymous).toMatchObject({
        personId: null,
        verified: false,
        anonymousDraftId: started.draftId,
      });
      const initialDraft = (
        await service.repository.getApplicantDrafts(id, anonymous!)
      )[0];
      const email = `anonymous-${crypto.randomUUID()}@example.com`;
      const revision = await service.saveDraft(slug, anonymous!, {
        submissionId: started.draftId,
        revision: initialDraft.revision,
        answers: validAnswers,
        speakers: [
          {
            name: "Anonymous Applicant",
            email,
            biography: "Biography saved before verification.",
          },
        ],
      });
      const anonymousUpload = await insertReadySubmissionVideo(testEnv, {
        eventId: form.eventId,
        submissionId: started.draftId,
        ownerPersonId: null,
      });
      const anonymousMultipartActor = {
        kind: "applicant" as const,
        ...(await service.authorizeApplicantMultipartUpload(
          anonymousRequest,
          slug,
          started.draftId,
          "video",
        )),
      };
      expect(anonymousMultipartActor).toMatchObject({
        personId: null,
        submissionId: started.draftId,
      });
      const multipart = new MultipartUploadService(testEnv);
      const multipartInput = {
        target: {
          targetType: "submission" as const,
          targetId: started.draftId,
          assetKind: "video" as const,
        },
        filename: "in-progress-pitch.mp4",
        contentType: "video/mp4",
        sizeBytes: 1_024,
        idempotencyKey: crypto.randomUUID(),
      };
      const inProgressUpload = await multipart.initiate(
        anonymousMultipartActor,
        multipartInput,
      );
      await expect(
        service.submitDraft(slug, anonymous!, {
          submissionId: started.draftId,
          revision,
          answers: validAnswers,
          speakers: [{ name: "Anonymous Applicant", email }],
        }),
      ).rejects.toThrow(/verify your email/i);

      await expect(
        service.applicants.requestCode(
          form,
          `not-primary-${crypto.randomUUID()}@example.com`,
          "",
          anonymousRequest,
        ),
      ).rejects.toThrow(/primary speaker email/i);

      await service.applicants.requestCode(form, email, "", anonymousRequest);
      const verifiedSession = await service.applicants.verifyCode(
        form,
        email,
        "424242",
        anonymousRequest,
      );
      const verifiedRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: verifiedSession.cookie.split(";")[0] },
      });
      const verified = await service.applicants.get(verifiedRequest, form);
      expect(verified).toMatchObject({ email, verified: true });
      expect(await service.applicants.get(anonymousRequest, form)).toBeNull();
      expect(
        await env.DB.prepare(
          `SELECT submitter_person_id AS personId, submitter_email AS email
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(started.draftId, form.eventId)
          .first(),
      ).toEqual({ personId: verified!.personId, email });
      expect(
        await env.DB.prepare(
          `SELECT owner_person_id AS ownerPersonId
           FROM file_assets WHERE id = ? AND event_id = ?`,
        )
          .bind(anonymousUpload.assetId, form.eventId)
          .first(),
      ).toEqual({ ownerPersonId: verified!.personId });

      const verifiedMultipartActor = {
        kind: "applicant" as const,
        ...(await service.authorizeApplicantMultipartUpload(
          verifiedRequest,
          slug,
          started.draftId,
          "video",
        )),
      };
      await expect(
        multipart.resume(verifiedMultipartActor, multipartInput),
      ).resolves.toMatchObject({
        versionId: inProgressUpload.versionId,
        state: "initiated",
        duplicate: true,
      });
      await multipart.abort(verifiedMultipartActor, {
        versionId: inProgressUpload.versionId,
      });

      const transferred = (
        await service.repository.getApplicantDrafts(id, verified!)
      )[0];
      await expect(
        service.submitDraft(slug, verified!, {
          submissionId: started.draftId,
          revision: transferred.revision,
          answers: validAnswers,
          speakers: transferred.speakers.map((speaker) => ({
            name: speaker.name,
            email: speaker.email,
            biography: speaker.biography,
          })),
        }),
      ).resolves.toMatchObject({ submissionId: started.draftId });
    });
  });

  describe("routing workflows", () => {
    it("fails admin reads when a submission lacks its immutable routing snapshot", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
      const persisted = await testEnv.DB.prepare(
        `SELECT form_version_id AS formVersionId,
                submitted_snapshot_json AS snapshotJson
           FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ formVersionId: string; snapshotJson: string }>();
      expect(persisted).not.toBeNull();

      try {
        await testEnv.DB.prepare(
          `UPDATE submissions
              SET form_version_id = NULL, submitted_snapshot_json = '{}'
            WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .run();

        await expect(
          service.listAdminSubmissions(viewer, { status: "submitted" }),
        ).rejects.toThrow(/missing its immutable routing snapshot/i);
        await expect(
          service.getAdminSubmission(viewer, submissionId),
        ).rejects.toThrow(/missing its immutable routing snapshot/i);
      } finally {
        await testEnv.DB.prepare(
          `UPDATE submissions
              SET form_version_id = ?, submitted_snapshot_json = ?
            WHERE id = ? AND event_id = ?`,
        )
          .bind(
            persisted!.formVersionId,
            persisted!.snapshotJson,
            submissionId,
            viewer.eventId,
          )
          .run();
      }
    });

    it("persists routing without coupling submission to evaluator assignment readiness", async () => {
      await ensureDemoData(env as unknown as CloudflareEnvironment);
      const teamId = `team-route-${crypto.randomUUID()}`;
      const teamName = `AI review ${crypto.randomUUID().slice(0, 6)}`;
      const planId = `plan-route-${crypto.randomUUID()}`;
      const roundId = `round-route-${crypto.randomUUID()}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
         VALUES (?, ?, 'Automatic category routing', 'active')`,
        ).bind(planId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Initial review', 'active')`,
        ).bind(roundId, viewer.eventId, planId),
        env.DB.prepare(
          `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, ?, 'active')`,
        ).bind(teamId, viewer.eventId, teamName),
        env.DB.prepare(
          `INSERT INTO evaluation_team_members (
           team_id, event_id, person_id, role
         ) VALUES (?, ?, 'person-demo-evaluator', 'evaluator')`,
        ).bind(teamId, viewer.eventId),
      ]);
      const { service, id, slug } = await publishedForm({
        routing: {
          categories: { "AI & Innovation": teamId },
          teamNames: { [teamId]: teamName },
          directSessionDurationMinutes: 30,
          passwordHash: null,
        },
      });
      await env.DB.prepare(
        `UPDATE tracks SET name = 'AI and Innovation (renamed)'
        WHERE id = 'demo-track-ai' AND event_id = ?`,
      )
        .bind(viewer.eventId)
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const firstId = await service.createDraft(slug, applicant);
      const first = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((draft) => draft.id === firstId)!;
      await service.submitDraft(slug, applicant, {
        submissionId: firstId,
        revision: first.revision,
        answers: validAnswers,
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
      expect(
        await env.DB.prepare(
          `SELECT submission.status,
                  (SELECT COUNT(*) FROM submission_routing_teams route
                    WHERE route.submission_id = submission.id
                      AND route.event_id = submission.event_id
                      AND route.team_id = ?) AS routedTeamCount,
                  (SELECT COUNT(*) FROM evaluator_assignments assignment
                    WHERE assignment.submission_id = submission.id
                      AND assignment.event_id = submission.event_id) AS assignmentCount
             FROM submissions submission WHERE submission.id = ?`,
        )
          .bind(teamId, firstId)
          .first(),
      ).toEqual({
        status: "submitted",
        routedTeamCount: 1,
        assignmentCount: 0,
      });

      await env.DB.prepare(
        "UPDATE evaluation_teams SET name = ? WHERE id = ? AND event_id = ?",
      )
        .bind(`${teamName} renamed`, teamId, viewer.eventId)
        .run();
      const routed = (
        await service.listAdminSubmissions(viewer, { status: "submitted" })
      ).find((submission) => submission.id === firstId);
      expect(routed?.routedTo).toBe(teamName);
      const assigned = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((draft) => draft.id === firstId)!;
      await service.withdrawSubmission(slug, applicant, {
        submissionId: firstId,
        revision: assigned.revision,
      });
      await expect(
        env.DB.prepare(
          `SELECT submission.status,
                  (SELECT COUNT(*) FROM evaluator_assignments assignment
                    WHERE assignment.submission_id = submission.id
                      AND assignment.event_id = submission.event_id) AS assignmentCount
             FROM submissions submission
            WHERE submission.id = ? AND submission.event_id = ?`,
        )
          .bind(firstId, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        status: "withdrawn",
        assignmentCount: 0,
      });

      const secondId = await service.createDraft(slug, applicant);
      const second = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((draft) => draft.id === secondId)!;
      await env.DB.prepare(
        "UPDATE evaluation_teams SET status = 'archived' WHERE id = ? AND event_id = ?",
      )
        .bind(teamId, viewer.eventId)
        .run();
      await expect(
        service.submitDraft(slug, applicant, {
          submissionId: secondId,
          revision: second.revision,
          answers: validAnswers,
          speakers: [{ name: applicant.name, email: applicant.email }],
        }),
      ).resolves.toMatchObject({ submissionId: secondId });
      await expect(
        env.DB.prepare("SELECT status FROM submissions WHERE id = ?")
          .bind(secondId)
          .first(),
      ).resolves.toEqual({ status: "submitted" });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE tracks SET name = 'AI & Innovation' WHERE id = 'demo-track-ai' AND event_id = ?",
        ).bind(viewer.eventId),
        env.DB.prepare(
          "UPDATE evaluation_rounds SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(roundId, viewer.eventId),
        env.DB.prepare(
          "UPDATE evaluation_plans SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(planId, viewer.eventId),
      ]);
    });

    it("routes a multi-track application to the union of configured teams without assigning reviewers", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const token = crypto.randomUUID();
      const planId = `plan-multi-track-${token}`;
      const roundId = `round-multi-track-${token}`;
      const aiTeamId = `team-multi-ai-${token}`;
      const operationsTeamId = `team-multi-operations-${token}`;
      const secondEvaluatorId = `person-multi-track-${token}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
           id, email, display_name, email_verified, profile_status, created_at, updated_at
         ) VALUES (?, ?, 'Second track reviewer', 1, 'published', unixepoch(), unixepoch())`,
        ).bind(secondEvaluatorId, `multi-reviewer-${token}@example.com`),
        testEnv.DB.prepare(
          `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'evaluator', unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          `membership-multi-track-${token}`,
          viewer.organisationId,
          viewer.eventId,
          secondEvaluatorId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
         VALUES (?, ?, 'Multi-track routing', 'active')`,
        ).bind(planId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Initial review', 'active')`,
        ).bind(roundId, viewer.eventId, planId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, 'AI reviewers', 'active')`,
        ).bind(aiTeamId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, 'Operations reviewers', 'active')`,
        ).bind(operationsTeamId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_team_members (team_id, event_id, person_id, role)
         VALUES (?, ?, 'person-demo-evaluator', 'evaluator')`,
        ).bind(aiTeamId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_team_members (team_id, event_id, person_id, role)
         VALUES (?, ?, ?, 'evaluator')`,
        ).bind(operationsTeamId, viewer.eventId, secondEvaluatorId),
      ]);
      const { service, id, slug } = await publishedForm({
        routing: {
          categories: {
            "AI & Innovation": aiTeamId,
            "Event Operations": operationsTeamId,
          },
          teamNames: {
            [aiTeamId]: "AI reviewers",
            [operationsTeamId]: "Operations reviewers",
          },
        },
      });
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: {
          ...validAnswers,
          category: ["AI & Innovation", "Event Operations"],
        },
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT
           (SELECT COUNT(*) FROM submission_track_selections
             WHERE submission_id = ? AND event_id = ?) AS trackCount,
           (SELECT COUNT(*) FROM submission_routing_teams
             WHERE submission_id = ? AND event_id = ?) AS teamCount,
           (SELECT COUNT(*) FROM evaluator_assignments
             WHERE submission_id = ? AND event_id = ?) AS reviewerCount,
           (SELECT track_name_snapshot FROM submission_track_selections
             WHERE submission_id = ? AND event_id = ?
               AND track_id = 'demo-track-ai') AS aiTrackSnapshot`,
        )
          .bind(
            submissionId,
            viewer.eventId,
            submissionId,
            viewer.eventId,
            submissionId,
            viewer.eventId,
            submissionId,
            viewer.eventId,
          )
          .first(),
      ).resolves.toEqual({
        trackCount: 2,
        teamCount: 2,
        reviewerCount: 0,
        aiTrackSnapshot: "AI & Innovation",
      });
      await expect(
        service.getAdminSubmission(viewer, submissionId),
      ).resolves.toMatchObject({
        category: "AI & Innovation, Event Operations",
        routedTeamIds: [aiTeamId, operationsTeamId].sort(),
        routedTo: "AI reviewers, Operations reviewers",
      });
      await testEnv.DB.prepare(
        `DELETE FROM submission_routing_teams
        WHERE submission_id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.listAdminSubmissions(viewer, { status: "submitted" }),
      ).resolves.toEqual(expect.any(Array));
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
         VALUES (?, ?, ?)`,
        ).bind(submissionId, viewer.eventId, aiTeamId),
        testEnv.DB.prepare(
          `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
         VALUES (?, ?, ?)`,
        ).bind(submissionId, viewer.eventId, operationsTeamId),
      ]);
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          "UPDATE evaluation_rounds SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(roundId, viewer.eventId),
        testEnv.DB.prepare(
          "UPDATE evaluation_plans SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(planId, viewer.eventId),
      ]);
    });
  });

  describe("co-speaker workflows", () => {
    it("rejects a co-speaker claim without its latest exact speaker revision", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Claim invariant invitations', 'Program Cue',
                   'submissions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
        ).bind(`sender-claim-invariant-${crypto.randomUUID()}`, viewer.eventId),
        testEnv.DB.prepare(
          `UPDATE sender_profiles SET status = 'verified', updated_at = unixepoch()
          WHERE event_id = ? AND provider = 'resend'`,
        ).bind(viewer.eventId),
      ]);
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const coSpeakerEmail = `claim-invariant-${crypto.randomUUID()}@example.com`;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          { name: applicant.name, email: applicant.email },
          {
            name: "Claim invariant co-speaker",
            email: coSpeakerEmail,
            biography: "Biography that must not be silently lost.",
          },
        ],
      });
      const claim = await testEnv.DB.prepare(
        `SELECT speaker.id, delivery.source_values_json AS sourceValuesJson,
              submission.form_version_id AS formVersionId
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN communication_deliveries delivery ON delivery.source_id = speaker.id
         JOIN communications communication
           ON communication.id = delivery.communication_id
        WHERE speaker.submission_id = ? AND speaker.email = ? COLLATE NOCASE
        ORDER BY delivery.created_at DESC LIMIT 1`,
      )
        .bind(submissionId, coSpeakerEmail)
        .first<{
          id: string;
          sourceValuesJson: string;
          formVersionId: string;
        }>();
      const claimUrl = new URL(
        String(JSON.parse(claim!.sourceValuesJson)["claim.url"]),
      );
      const claimToken = claimUrl.searchParams.get("claim")!;

      await testEnv.DB.prepare(
        "DELETE FROM submission_revisions WHERE submission_id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.claimCoSpeakerToken(slug, claim!.id, claimToken),
      ).rejects.toThrow(/latest submission speaker revision is unavailable/i);

      await testEnv.DB.prepare(
        `INSERT INTO submission_revisions (
         id, event_id, submission_id, form_version_id, revision_number,
         answers_json, speaker_snapshot_json, save_kind, saved_by_person_id,
         created_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, 'submitted', ?, unixepoch())`,
      )
        .bind(
          crypto.randomUUID(),
          viewer.eventId,
          submissionId,
          claim!.formVersionId,
          JSON.stringify(validAnswers),
          JSON.stringify([{ name: applicant.name, email: applicant.email }]),
          applicant.personId,
        )
        .run();
      await expect(
        service.claimCoSpeakerToken(slug, claim!.id, claimToken),
      ).rejects.toThrow(/does not contain this co-speaker claim/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT person_id AS personId, invitation_status AS invitationStatus
           FROM submission_speakers WHERE id = ? AND event_id = ?`,
        )
          .bind(claim!.id, viewer.eventId)
          .first(),
      ).resolves.toMatchObject({ personId: null });
      await expect(
        testEnv.DB.prepare(
          "SELECT COUNT(*) AS count FROM people WHERE email = ? COLLATE NOCASE",
        )
          .bind(coSpeakerEmail)
          .first(),
      ).resolves.toEqual({ count: 0 });
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

  describe("co-speaker workflows", () => {
    it("materialises public direct-session intake and supports expiring co-speaker claims", async () => {
      const { service, id, slug, queued } = await publishedForm({
        kind: "direct_session",
        routing: {
          categories: {},
          teamNames: {},
          directSessionDurationMinutes: null,
          passwordHash: null,
        },
      });
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      )[0];
      const coSpeakerEmail = `direct-co-${crypto.randomUUID()}@example.com`;
      const result = await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: directSessionAnswers,
        speakers: [
          {
            name: applicant.name,
            email: applicant.email,
            biography: "Primary biography",
          },
          {
            name: "Direct Co-speaker",
            email: coSpeakerEmail,
            biography: "Biography proposed by the submitter.",
          },
        ],
      });
      expect(result.directSessionId).toBeTruthy();
      expect(result.invitations).toEqual({ queued: 1, queueFailed: 0 });
      expect(queued).toHaveLength(2);
      expect(
        await env.DB.prepare(`SELECT status FROM submissions WHERE id = ?`)
          .bind(submissionId)
          .first(),
      ).toEqual({ status: "accepted" });
      expect(
        await env.DB.prepare(
          `SELECT source_submission_id AS sourceSubmissionId,
                track_id AS trackId, duration_minutes AS durationMinutes,
                (SELECT COUNT(*) FROM session_speakers relationship
                  WHERE relationship.session_id = session.id) AS speakerCount
           FROM sessions session WHERE id = ?`,
        )
          .bind(result.directSessionId)
          .first(),
      ).toEqual({
        sourceSubmissionId: null,
        trackId: "demo-track-ai",
        durationMinutes: 45,
        speakerCount: 2,
      });

      const invitation = await env.DB.prepare(
        `SELECT speaker.id, speaker.claim_token_hash AS tokenHash,
              delivery.source_values_json AS sourceValuesJson,
              communication.operation_id AS operationId,
              communication.content_snapshot_json AS contentSnapshotJson
         FROM submission_speakers speaker
         JOIN communication_deliveries delivery ON delivery.source_id = speaker.id
         JOIN communications communication ON communication.id = delivery.communication_id
        WHERE speaker.submission_id = ? AND speaker.email = ? COLLATE NOCASE
        ORDER BY delivery.created_at DESC LIMIT 1`,
      )
        .bind(submissionId, coSpeakerEmail)
        .first<{
          id: string;
          tokenHash: string;
          sourceValuesJson: string;
          operationId: string;
          contentSnapshotJson: string;
        }>();
      expect(invitation?.tokenHash).toHaveLength(64);
      expect(invitation?.operationId).toBeTruthy();
      expect(JSON.parse(invitation!.contentSnapshotJson)).toMatchObject({
        event: { brandAccent: "#4f46e5" },
      });
      const firstClaimUrl = new URL(
        String(JSON.parse(invitation!.sourceValuesJson)["claim.url"]),
      );
      await env.DB.prepare(
        `UPDATE submission_speakers
          SET invitation_expires_at = unixepoch() - 1
        WHERE id = ? AND event_id = ?`,
      )
        .bind(invitation!.id, viewer.eventId)
        .run();
      await expect(
        service.claimCoSpeakerToken(
          slug,
          invitation!.id,
          firstClaimUrl.searchParams.get("claim")!,
        ),
      ).rejects.toThrow(/expired/i);

      const resent = await service.resendCoSpeakerInvitation(
        viewer,
        invitation!.id,
      );
      expect(resent).toMatchObject({ status: "queued" });
      const replacement = await env.DB.prepare(
        `SELECT speaker.claim_token_hash AS tokenHash,
              speaker.invitation_expires_at AS expiresAt,
              delivery.source_values_json AS sourceValuesJson
         FROM submission_speakers speaker
         JOIN communication_deliveries delivery ON delivery.source_id = speaker.id
         JOIN communications communication
           ON communication.id = delivery.communication_id
        WHERE speaker.id = ? AND communication.operation_id = ?
        LIMIT 1`,
      )
        .bind(invitation!.id, resent.operationId)
        .first<{
          tokenHash: string;
          expiresAt: number;
          sourceValuesJson: string;
        }>();
      expect(replacement!.tokenHash).not.toBe(invitation!.tokenHash);
      expect(replacement!.expiresAt).toBeGreaterThan(
        Math.floor(Date.now() / 1_000),
      );
      await expect(
        service.claimCoSpeakerToken(
          slug,
          invitation!.id,
          firstClaimUrl.searchParams.get("claim")!,
        ),
      ).rejects.toThrow(/invalid|replaced/i);
      const replacementUrl = new URL(
        String(JSON.parse(replacement!.sourceValuesJson)["claim.url"]),
      );
      const claimed = await service.claimCoSpeakerToken(
        slug,
        invitation!.id,
        replacementUrl.searchParams.get("claim")!,
      );
      expect(claimed.applicant.biography).toBe(
        "Biography proposed by the submitter.",
      );
      await expect(
        service.applicants.get(
          new Request(`https://example.com/apply/${slug}`, {
            headers: { cookie: claimed.cookie.split(";")[0] },
          }),
          await service.getPublicForm(slug),
        ),
      ).resolves.toMatchObject({
        personId: claimed.applicant.personId,
        verified: true,
      });
      await service.updateClaimedSpeakerProfile(slug, claimed.applicant, {
        revision: claimed.applicant.profileRevision,
        name: "Co-speaker Owned Name",
        biography: "Biography owned by the claimed co-speaker.",
      });
      expect(
        await env.DB.prepare(
          `SELECT person.biography, speaker.display_name AS displayName,
                speaker.invitation_status AS invitationStatus
           FROM submission_speakers speaker
           JOIN people person ON person.id = speaker.person_id
          WHERE speaker.id = ?`,
        )
          .bind(invitation!.id)
          .first(),
      ).toEqual({
        biography: "Biography owned by the claimed co-speaker.",
        displayName: "Co-speaker Owned Name",
        invitationStatus: "claimed",
      });
      const adminDetail = await service.getAdminSubmission(
        viewer,
        submissionId,
      );
      expect(
        adminDetail?.speakers.find((speaker) => speaker.id === invitation!.id),
      ).toMatchObject({
        biography: "Biography owned by the claimed co-speaker.",
        submittedBiography: "Biography proposed by the submitter.",
      });
    });
  });

  describe("routing workflows", () => {
    it("rejects a multi-value track answer before materialising a direct session", async () => {
      const { service, id, slug } = await publishedForm({
        kind: "direct_session",
        routing: {
          categories: {},
          teamNames: {},
          directSessionDurationMinutes: null,
          passwordHash: null,
        },
      });
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;

      await expect(
        service.submitDraft(slug, applicant, {
          submissionId,
          revision: draft.revision,
          answers: {
            ...validAnswers,
            category: ["AI & Innovation", "Event Operations"],
          },
          speakers: [{ name: applicant.name, email: applicant.email }],
        }),
      ).rejects.toThrow(/tracks must contain a single value/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                (SELECT COUNT(*) FROM sessions
                  WHERE id = submissions.last_operation_id) AS sessionCount
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ status: "draft", sessionCount: 0 });
    });
  });

  describe("applicant draft and submission workflows", () => {
    it("rejects duplicate submitted tracks as a field validation error", async () => {
      const { service, id, slug } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;

      await expect(
        service.submitDraft(slug, applicant, {
          submissionId,
          revision: draft.revision,
          answers: {
            ...validAnswers,
            category: ["AI & Innovation", "AI & Innovation"],
          },
          speakers: [{ name: applicant.name, email: applicant.email }],
        }),
      ).rejects.toThrow(/tracks must not contain duplicate choices/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                (SELECT COUNT(*) FROM submission_track_selections
                  WHERE submission_id = submissions.id) AS trackCount
           FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ status: "draft", trackCount: 0 });
    });

    it("rejects any submission materialisation without a submitted track", async () => {
      const { service, id, slug } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const form = await service.getPublicForm(slug);

      await expect(
        service.repository.submitDraft(
          form,
          applicant,
          {
            submissionId,
            revision: draft.revision,
            answers: validAnswers,
            speakers: [{ name: applicant.name, email: applicant.email }],
          },
          {
            trackSelections: [],
            routedTeamIds: [],
            upload: null,
          },
        ),
      ).rejects.toThrow(/must retain at least one submitted event track/i);
      await expect(
        env.DB.prepare(
          "SELECT status, revision FROM submissions WHERE id = ? AND event_id = ?",
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ status: "draft", revision: draft.revision });
    });
  });

  describe("co-speaker workflows", () => {
    it("does not verify a co-speaker identity when the claim token loses its CAS race", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Claim invitations', 'Program Cue',
                   'submissions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
        ).bind(`sender-claim-race-${crypto.randomUUID()}`, viewer.eventId),
        testEnv.DB.prepare(
          `UPDATE sender_profiles SET status = 'verified', updated_at = unixepoch()
          WHERE event_id = ? AND provider = 'resend'`,
        ).bind(viewer.eventId),
      ]);
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const invitedEmail = `claim-race-${crypto.randomUUID()}@example.com`;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          { name: applicant.name, email: applicant.email },
          {
            name: "Claim race speaker",
            email: invitedEmail,
            biography: "Biography from the uncommitted claim.",
          },
        ],
      });
      const invitation = await testEnv.DB.prepare(
        `SELECT speaker.id, delivery.source_values_json AS sourceValuesJson
         FROM submission_speakers speaker
         JOIN communication_deliveries delivery
           ON delivery.source_id = speaker.id
          AND delivery.event_id = speaker.event_id
        WHERE speaker.submission_id = ? AND speaker.event_id = ?
          AND speaker.email = ? COLLATE NOCASE
        ORDER BY delivery.created_at DESC LIMIT 1`,
      )
        .bind(submissionId, viewer.eventId, invitedEmail)
        .first<{ id: string; sourceValuesJson: string }>();
      const claimUrl = new URL(
        String(JSON.parse(invitation!.sourceValuesJson)["claim.url"]),
      );
      const replacementHash = "a".repeat(64);
      const racingEnv = withNthBatchRace(testEnv, 2, async () => {
        await testEnv.DB.prepare(
          `UPDATE submission_speakers SET claim_token_hash = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        )
          .bind(replacementHash, invitation!.id, viewer.eventId)
          .run();
      });

      await expect(
        new SubmissionService(racingEnv).claimCoSpeakerToken(
          slug,
          invitation!.id,
          claimUrl.searchParams.get("claim")!,
        ),
      ).rejects.toThrow(/no longer available/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT person.email_verified AS emailVerified,
                speaker.person_id AS speakerPersonId,
                speaker.invitation_status AS invitationStatus,
                speaker.claim_token_hash AS claimTokenHash
           FROM people person
           JOIN submission_speakers speaker
             ON speaker.email = person.email COLLATE NOCASE
          WHERE person.email = ? COLLATE NOCASE AND speaker.id = ?`,
        )
          .bind(invitedEmail, invitation!.id)
          .first(),
      ).resolves.toEqual({
        emailVerified: 0,
        speakerPersonId: null,
        invitationStatus: "sent",
        claimTokenHash: replacementHash,
      });
    });

    it("limits an account-required co-speaker claim session to the claimed speaker profile", async () => {
      const { service, id, slug, testEnv } = await publishedForm({
        accessMode: "account_required",
      });
      const primary: Applicant = {
        personId: "person-demo-submitter",
        name: "Alex Morgan",
        email: "alex.submitter@example.com",
        verified: true,
        anonymousDraftId: null,
        biography: "",
        profileRevision: 1,
      };
      const submissionId = await service.createDraft(slug, primary);
      const draft = (
        await service.repository.getApplicantDrafts(id, primary)
      ).find((candidate) => candidate.id === submissionId)!;
      const invitedEmail = `account-claim-${crypto.randomUUID()}@example.com`;
      await service.submitDraft(slug, primary, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          { name: primary.name, email: primary.email },
          { name: "Account claim speaker", email: invitedEmail },
        ],
      });
      const invitation = await testEnv.DB.prepare(
        `SELECT speaker.id, delivery.source_values_json AS sourceValuesJson
         FROM submission_speakers speaker
         JOIN communication_deliveries delivery
           ON delivery.source_id = speaker.id AND delivery.event_id = speaker.event_id
        WHERE speaker.submission_id = ? AND speaker.event_id = ?
          AND speaker.email = ? COLLATE NOCASE
        ORDER BY delivery.created_at DESC LIMIT 1`,
      )
        .bind(submissionId, viewer.eventId, invitedEmail)
        .first<{ id: string; sourceValuesJson: string }>();
      const claimUrl = new URL(
        String(JSON.parse(invitation!.sourceValuesJson)["claim.url"]),
      );
      const claimed = await service.claimCoSpeakerToken(
        slug,
        invitation!.id,
        claimUrl.searchParams.get("claim")!,
      );

      const claimRequest = new Request(`https://example.com/apply/${slug}`, {
        headers: { cookie: claimed.cookie.split(";")[0] },
      });
      const claimSession = await service.applicants.get(
        claimRequest,
        await service.getPublicForm(slug),
      );
      expect(claimSession).toMatchObject({
        email: invitedEmail,
        verified: true,
        claimOnly: true,
      });
      await expect(service.createDraft(slug, claimSession!)).rejects.toThrow(
        /sign in.*manage applications/i,
      );
      await expect(
        service.getApplicantPortal(slug, claimRequest),
      ).resolves.toMatchObject({
        drafts: [],
        selected: null,
        speakerProfile: {
          name: "Account claim speaker",
        },
      });
      await expect(
        service.updateClaimedSpeakerProfile(slug, claimSession!, {
          revision: claimSession!.profileRevision,
          name: "Account claim speaker",
          biography: "Claim-session profile biography.",
        }),
      ).resolves.toBeUndefined();
      await expect(
        testEnv.DB.prepare("SELECT biography FROM people WHERE id = ?")
          .bind(claimSession!.personId)
          .first(),
      ).resolves.toEqual({ biography: "Claim-session profile biography." });
    });
  });

  describe("administration intake workflows", () => {
    it("creates a tenant-scoped immutable manual application", async () => {
      const { service } = await publishedForm();
      const teamId = `team-manual-${crypto.randomUUID()}`;
      const teamName = `Manual ${crypto.randomUUID()}`;
      const planId = `plan-manual-${crypto.randomUUID()}`;
      const roundId = `round-manual-${crypto.randomUUID()}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
         VALUES (?, ?, 'Manual entry review', 'active')`,
        ).bind(planId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Manual review', 'active')`,
        ).bind(roundId, viewer.eventId, planId),
        env.DB.prepare(
          `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, ?, 'active')`,
        ).bind(teamId, viewer.eventId, teamName),
        env.DB.prepare(
          `INSERT INTO evaluation_team_members (
           team_id, event_id, person_id, role
         ) VALUES (?, ?, 'person-demo-evaluator', 'evaluator')`,
        ).bind(teamId, viewer.eventId),
      ]);
      const submissionId = await service.createManualApplication(viewer, {
        idempotencyKey: `manual-${crypto.randomUUID()}`,
        title: "Administrator entered proposal",
        description: "Received outside the public application form.",
        trackIds: ["demo-track-ai", "demo-track-operations"],
        format: "presentation",
        submitterName: "Partner Coordinator",
        submitterEmail: `partner-${crypto.randomUUID()}@example.com`,
        routedTeamIds: [teamId],
        speakers: [
          {
            name: "Guaranteed Speaker",
            email: `guaranteed-${crypto.randomUUID()}@example.com`,
            biography: "Manually recorded speaker biography.",
          },
        ],
      });
      const row = await env.DB.prepare(
        `SELECT submission.status, submission.form_version_id AS formVersionId,
              submission.submitted_snapshot_json AS snapshotJson,
              (SELECT COUNT(*) FROM submission_routing_teams route
                WHERE route.submission_id = submission.id
                  AND route.event_id = submission.event_id) AS routedTeamCount,
              (SELECT COUNT(*) FROM evaluator_assignments assignment
                WHERE assignment.submission_id = submission.id
                  AND assignment.event_id = submission.event_id) AS assignmentCount,
              audit.action
         FROM submissions submission
         JOIN audit_events audit
           ON audit.entity_id = submission.id AND audit.event_id = submission.event_id
          AND audit.action = 'submission.manual.created'
        WHERE submission.id = ? AND submission.event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{
          status: string;
          formVersionId: string | null;
          routedTeamCount: number;
          assignmentCount: number;
          snapshotJson: string;
          action: string;
        }>();
      expect(row).toMatchObject({
        status: "submitted",
        formVersionId: null,
        routedTeamCount: 1,
        assignmentCount: 0,
        action: "submission.manual.created",
      });
      expect(JSON.parse(row!.snapshotJson).speakers[0].biography).toBe(
        "Manually recorded speaker biography.",
      );
      expect(JSON.parse(row!.snapshotJson).answers.category).toEqual([
        "AI & Innovation",
        "Event Operations",
      ]);
      expect(
        JSON.parse(row!.snapshotJson).schema.fields.map(
          (field: { id: string }) => field.id,
        ),
      ).toEqual(["title", "description", "category", "format"]);
      expect(
        (
          await service.listAdminSubmissions(viewer, { status: "submitted" })
        ).find((submission) => submission.id === submissionId)?.routedTo,
      ).toBe(teamName);
      await expect(
        service.getAdminSubmission(viewer, submissionId),
      ).resolves.toMatchObject({
        routedTo: teamName,
        category: "AI & Innovation, Event Operations",
      });
      const selectedTracks = await env.DB.prepare(
        `SELECT track_id AS trackId, track_name_snapshot AS trackName, position
           FROM submission_track_selections
          WHERE submission_id = ? AND event_id = ?
          ORDER BY position`,
      )
        .bind(submissionId, viewer.eventId)
        .all();
      expect(selectedTracks.results).toEqual([
        {
          trackId: "demo-track-ai",
          trackName: "AI & Innovation",
          position: 0,
        },
        {
          trackId: "demo-track-operations",
          trackName: "Event Operations",
          position: 1,
        },
      ]);
      await expect(
        service.createManualApplication(
          { ...viewer, organisationId: "org-not-authorised" },
          {
            idempotencyKey: `manual-${crypto.randomUUID()}`,
            title: "Cross-tenant proposal",
            description: "Must not be created.",
            trackIds: ["demo-track-ai"],
            format: "presentation",
            submitterName: "Wrong tenant",
            submitterEmail: "wrong-tenant@example.com",
            routedTeamIds: [],
            speakers: [
              { name: "Wrong tenant", email: "wrong-tenant@example.com" },
            ],
          },
        ),
      ).rejects.toMatchObject({ status: 404 });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE evaluation_rounds SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(roundId, viewer.eventId),
        env.DB.prepare(
          "UPDATE evaluation_plans SET status = 'closed' WHERE id = ? AND event_id = ?",
        ).bind(planId, viewer.eventId),
      ]);
    });
  });

  describe("routing workflows", () => {
    it("fails a manual routed application atomically when routing changes", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoData(testEnv);
      const token = crypto.randomUUID();
      const teamId = `team-manual-race-${token}`;
      const planId = `plan-manual-race-${token}`;
      const roundId = `round-manual-race-${token}`;
      const submitterEmail = `manual-race-submitter-${token}@example.com`;
      const speakerEmail = `manual-race-speaker-${token}@example.com`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
         VALUES (?, ?, 'Manual race review', 'active')`,
        ).bind(planId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Manual race round', 'active')`,
        ).bind(roundId, viewer.eventId, planId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, 'Manual race team', 'active')`,
        ).bind(teamId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_team_members (
           team_id, event_id, person_id, role
         ) VALUES (?, ?, 'person-demo-evaluator', 'evaluator')`,
        ).bind(teamId, viewer.eventId),
      ]);
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.prepare(
          `UPDATE evaluation_teams SET status = 'archived'
          WHERE id = ? AND event_id = ?`,
        )
          .bind(teamId, viewer.eventId)
          .run();
      });

      await expect(
        new SubmissionService(racingEnv).createManualApplication(viewer, {
          idempotencyKey: `manual-${crypto.randomUUID()}`,
          title: "Routing changed while saving",
          description: "This entry must leave no partial records.",
          trackIds: ["demo-track-ai"],
          format: "presentation",
          submitterName: "Manual race submitter",
          submitterEmail,
          routedTeamIds: [teamId],
          speakers: [
            {
              name: "Manual race speaker",
              email: speakerEmail,
              biography: "Should not be persisted after the failed CAS.",
            },
          ],
        }),
      ).rejects.toThrow(/review teams.*changed/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT
           (SELECT COUNT(*) FROM submissions
             WHERE event_id = ? AND submitter_email = ?) AS submissionCount,
           (SELECT COUNT(*) FROM people
             WHERE email IN (?, ?)) AS personCount`,
        )
          .bind(viewer.eventId, submitterEmail, submitterEmail, speakerEmail)
          .first(),
      ).resolves.toEqual({ submissionCount: 0, personCount: 0 });

      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `UPDATE evaluation_rounds SET status = 'closed'
          WHERE id = ? AND event_id = ?`,
        ).bind(roundId, viewer.eventId),
        testEnv.DB.prepare(
          `UPDATE evaluation_plans SET status = 'closed'
          WHERE id = ? AND event_id = ?`,
        ).bind(planId, viewer.eventId),
      ]);
    });
  });

  describe("administration intake workflows", () => {
    it("replays administrator-created records by idempotency key and rejects payload reuse", async () => {
      const { service } = await publishedForm();
      const token = crypto.randomUUID();
      const directInput = {
        idempotencyKey: `direct-idempotent-${token}`,
        title: "Idempotent guaranteed session",
        description: "Created once when an administrator retries.",
        format: "presentation" as const,
        trackId: "demo-track-ai",
        durationMinutes: 30,
        speakers: [
          {
            name: "Idempotent Speaker",
            email: `direct-idempotent-${token}@example.com`,
            biography: "A stable profile snapshot.",
          },
        ],
      };
      const firstSessionId = await service.createDirectSession(
        viewer,
        directInput,
      );
      await expect(
        service.createDirectSession(viewer, directInput),
      ).resolves.toBe(firstSessionId);
      await expect(
        service.createDirectSession(viewer, {
          ...directInput,
          title: "Different payload",
        }),
      ).rejects.toThrow(/different record details/i);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sessions
          WHERE id = ? AND event_id = ?`,
        )
          .bind(firstSessionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ count: 1 });

      const manualInput = {
        idempotencyKey: `manual-idempotent-${token}`,
        title: "Idempotent manual application",
        description: "An immutable external intake record.",
        trackIds: ["demo-track-ai"],
        format: "presentation",
        submitterName: "Manual Submitter",
        submitterEmail: `manual-submitter-${token}@example.com`,
        routedTeamIds: [],
        speakers: [
          {
            name: "Manual Speaker",
            email: `manual-speaker-${token}@example.com`,
            biography: "Entered by an administrator.",
          },
        ],
      };
      const firstSubmissionId = await service.createManualApplication(
        viewer,
        manualInput,
      );
      await expect(
        service.createManualApplication(viewer, manualInput),
      ).resolves.toBe(firstSubmissionId);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM submissions
          WHERE id = ? AND event_id = ?`,
        )
          .bind(firstSubmissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ count: 1 });

      const invalidFormatKey = `manual-format-${token}`;
      await expect(
        service.createManualApplication(viewer, {
          ...manualInput,
          idempotencyKey: invalidFormatKey,
          format: "not-configured",
        }),
      ).rejects.toThrow(/not-configured.*not configured/i);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM idempotency_records
            WHERE event_id = ? AND idempotency_key = ?`,
        )
          .bind(viewer.eventId, invalidFormatKey)
          .first(),
      ).resolves.toEqual({ count: 0 });
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
      const sessionId = await service.createDirectSession(viewer, {
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
          .bind(sessionId, viewer.eventId)
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

  describe("administration intake workflows", () => {
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
        idempotencyKey: `direct-${crypto.randomUUID()}`,
        title: "Sponsor perspective",
        description: "Guaranteed programme contribution.",
        format: "presentation",
        trackId: "demo-track-ai",
        durationMinutes: 30,
        speakers: [
          {
            name: "Morgan Sponsor",
            email: "morgan-sponsor@example.com",
            biography: "Sponsor representative.",
          },
        ],
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
});

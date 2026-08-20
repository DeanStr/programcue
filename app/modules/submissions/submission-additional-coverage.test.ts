import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { processSubmissionNotification } from "../../../workers/communications-queue";
import { loader as submissionManagementLoader } from "../../routes/submission-management";
import { isSubmissionManagementUrl } from "./submission-management-url.server";
import {
  D1SubmissionRepository,
  SubmissionDraftSavedError,
} from "./submission-repository.server";
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

describe("submission management URL validation", () => {
  const submissionId = "submission-protocol-check";
  const httpUrl =
    "http://app.programcue.test/applications/submission-protocol-check/manage";

  it("rejects cleartext durable links in production", () => {
    expect(isSubmissionManagementUrl(httpUrl, submissionId, "production")).toBe(
      false,
    );
  });

  it("allows local HTTP links outside production", () => {
    expect(isSubmissionManagementUrl(httpUrl, submissionId, "test")).toBe(true);
  });
});

async function publishedForm(overrides: Record<string, unknown> = {}) {
  const queued: unknown[] = [];
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    BETTER_AUTH_URL: "https://app.programcue.test",
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
  return (await verifiedApplicantSession(service, slug, email)).applicant;
}

async function verifiedApplicantSession(
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
  return { applicant: applicant!, cookie: verified.cookie.split(";", 1)[0]! };
}

function routeContext(environment: CloudflareEnvironment) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

const validAnswers = {
  title: "Useful automation without the hype",
  description:
    "A practical session about reliable event operations and measurable outcomes.",
  category: ["AI & Innovation"],
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
      const { applicant, cookie: applicantCookie } =
        await verifiedApplicantSession(service, slug);
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
      const expectedApplicationUrl = new URL(
        `/applications/${encodeURIComponent(firstId)}/manage`,
        testEnv.BETTER_AUTH_URL,
      );
      expect(confirmationMessage).toMatchObject({
        applicationUrl: expectedApplicationUrl.toString(),
      });
      const pendingIntent = await testEnv.DB.prepare(
        `SELECT operation.payload_json AS payloadJson,
                communication.content_snapshot_json AS contentSnapshotJson
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
          WHERE operation.idempotency_key = ?`,
      )
        .bind(`submission-confirmation:${firstId}`)
        .first<{ payloadJson: string; contentSnapshotJson: string }>();
      expect(JSON.parse(pendingIntent!.payloadJson)).toMatchObject({
        applicationUrl: expectedApplicationUrl.toString(),
      });
      expect(JSON.parse(pendingIntent!.contentSnapshotJson)).toMatchObject({
        pendingMaterialization: true,
        applicationUrl: expectedApplicationUrl.toString(),
      });
      const changedSlug = `${slug}-changed`;
      await testEnv.DB.prepare(
        `UPDATE form_definitions SET public_slug = ?
          WHERE id = ? AND event_id = ?`,
      )
        .bind(changedSlug, id, viewer.eventId)
        .run();
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
      const deliveryEnvironment = {
        ...testEnv,
        BETTER_AUTH_URL: "https://app.programcue.test",
      } as unknown as CloudflareEnvironment;
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
        { ...deliveryEnvironment, DB: delayedDb },
        { email: provider },
      );
      await staleMaterialisationReached;
      try {
        await processSubmissionNotification(
          confirmationMessage,
          deliveryEnvironment,
          { email: provider },
        );
      } finally {
        releaseStaleMaterialisation();
      }
      await staleWorker;
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]).toMatchObject({
        to: [applicant.email],
        subject: `We received ${validAnswers.title}`,
      });
      expect(String(providerRequests[0]?.text)).toContain(
        `Manage application: ${expectedApplicationUrl.toString()}`,
      );
      expect(String(providerRequests[0]?.html)).toContain("Manage application");
      expect(String(providerRequests[0]?.html)).toContain(
        expectedApplicationUrl.toString().replaceAll("&", "&amp;"),
      );
      const durableConfirmation = await testEnv.DB.prepare(
        `SELECT delivery.source_values_json AS sourceValuesJson,
                communication.content_snapshot_json AS contentSnapshotJson
           FROM communications communication
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
          WHERE communication.idempotency_key = ?`,
      )
        .bind(`submission-confirmation:${firstId}`)
        .first<{ sourceValuesJson: string; contentSnapshotJson: string }>();
      expect(JSON.parse(durableConfirmation!.sourceValuesJson)).toMatchObject({
        "submission.title": validAnswers.title,
        "submission.url": expectedApplicationUrl.toString(),
      });
      expect(
        JSON.parse(durableConfirmation!.contentSnapshotJson),
      ).toMatchObject({
        content: {
          body: expect.stringContaining(
            "Manage application: {{submission.url}}",
          ),
          buttonText: "Manage application",
          buttonUrl: expectedApplicationUrl.toString(),
        },
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
        changedSlug,
        "casey@example.com",
      );
      const invitations = await service.repository.getCoSpeakerInvitations(
        id,
        coSpeaker,
      );
      expect(invitations).toMatchObject([
        { submissionId: firstId, submissionTitle: validAnswers.title },
      ]);
      await service.claimCoSpeaker(changedSlug, coSpeaker, invitations[0].id);
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
      const managed = await submissionManagementLoader({
        request: new Request(expectedApplicationUrl, {
          headers: { cookie: applicantCookie },
        }),
        params: { submissionId: firstId },
        context: routeContext(deliveryEnvironment),
      } as never);
      expect(managed).toBeInstanceOf(Response);
      expect((managed as Response).status).toBe(302);
      expect((managed as Response).headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect((managed as Response).headers.get("location")).toBe(
        `/apply/${encodeURIComponent(changedSlug)}?draft=${encodeURIComponent(firstId)}#submitted-application`,
      );
      await expect(
        submissionManagementLoader({
          request: new Request(expectedApplicationUrl),
          params: { submissionId: firstId },
          context: routeContext(deliveryEnvironment),
        } as never),
      ).rejects.toMatchObject({ status: 404 });
      const otherApplicant = await verifiedApplicantSession(
        service,
        changedSlug,
      );
      const denied = await submissionManagementLoader({
        request: new Request(expectedApplicationUrl, {
          headers: { cookie: otherApplicant.cookie },
        }),
        params: { submissionId: firstId },
        context: routeContext(deliveryEnvironment),
      } as never).then(
        () => null,
        (error: unknown) => error,
      );
      expect(denied).toBeInstanceOf(Response);
      expect((denied as Response).status).toBe(404);
      expect((denied as Response).headers.get("cache-control")).toBe(
        "private, no-store",
      );
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
      const invalidUrlEnvironment = {
        ...testEnv,
        BETTER_AUTH_URL: "ftp://app.programcue.test",
      } as unknown as CloudflareEnvironment;
      await expect(
        new SubmissionService(invalidUrlEnvironment).submitDraft(
          slug,
          applicant,
          {
            submissionId,
            revision: before!.revision,
            answers: validAnswers,
            speakers: [{ name: "URL Test", email: applicant.email }],
          },
        ),
      ).rejects.toThrow(
        "BETTER_AUTH_URL must use HTTPS before submission confirmations can be delivered",
      );
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

    it("fails an invalid durable submission payload once with explicit recovery guidance", async () => {
      const { testEnv } = await publishedForm();
      const token = crypto.randomUUID();
      const submissionId = `invalid-snapshot-submission-${token}`;
      const operationId = `invalid-snapshot-submission-notification-${token}`;
      const communicationId = `invalid-snapshot-submission-communication-${token}`;
      const idempotencyKey = `submission-confirmation:${submissionId}`;
      const message = {
        type: "submission.notification" as const,
        operationId,
        communicationId,
        submissionId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey,
        applicationUrl: `https://app.programcue.test/applications/${encodeURIComponent(submissionId)}/manage`,
      };
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json
           ) VALUES (?, ?, ?, ?, 'submission.notification', ?, ?, 'queued', ?)`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          idempotencyKey,
          token,
          JSON.stringify({
            ...message,
            applicationUrl:
              "https://app.programcue.test/applications/a-different-submission/manage",
          }),
        ),
        testEnv.DB.prepare(
          `INSERT INTO communications (
             id, event_id, operation_id, idempotency_key, kind, channel, status,
             audience_json, content_snapshot_json, recipient_count,
             created_by_person_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'transactional', 'email', 'queued', ?, '{}', 1,
                     ?, unixepoch(), unixepoch())`,
        ).bind(
          communicationId,
          viewer.eventId,
          operationId,
          idempotencyKey,
          JSON.stringify({ pendingMaterialization: true }),
          viewer.personId,
        ),
      ]);

      await processSubmissionNotification(message, testEnv);
      const terminal = await testEnv.DB.prepare(
        `SELECT operation.status AS operationStatus,
                operation.last_error AS lastError,
                communication.status AS communicationStatus
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
          WHERE operation.id = ? AND operation.event_id = ?`,
      )
        .bind(operationId, viewer.eventId)
        .first<{
          operationStatus: string;
          lastError: string;
          communicationStatus: string;
        }>();
      expect(terminal).toMatchObject({
        operationStatus: "failed",
        lastError: expect.stringContaining(
          "durable submission notification snapshot is invalid",
        ),
        communicationStatus: "failed",
      });
      await expect(
        processSubmissionNotification(message, testEnv),
      ).resolves.toBeUndefined();
    });
  });
});

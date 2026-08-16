import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { describe, expect, it } from "vitest";

import { MultipartUploadService } from "~/modules/files/multipart-upload.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
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

async function authenticatedSessionCookie(personId: string) {
  const token = `session-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO auth_sessions (
       id, person_id, token, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())`,
  )
    .bind(crypto.randomUUID(), personId, token)
    .run();
  return serializeSignedCookie(
    "better-auth.session_token",
    token,
    String((env as unknown as CloudflareEnvironment).BETTER_AUTH_SECRET),
  );
}

const validAnswers = {
  title: "Useful automation without the hype",
  description:
    "A practical session about reliable event operations and measurable outcomes.",
  category: ["AI & Innovation"],
  format: "Presentation",
  video: "https://example.com/pitch",
};

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
  describe("applicant draft and submission workflows", () => {
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

    it("opens an owned email-verified draft from an authenticated Program Cue session", async () => {
      const { service, slug } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const cookie = await authenticatedSessionCookie(applicant.personId!);
      const request = new Request(
        `https://example.com/apply/${slug}?draft=${submissionId}`,
        { headers: { cookie } },
      );

      await expect(
        service.getApplicantPortal(slug, request, submissionId),
      ).resolves.toMatchObject({
        applicant: { personId: applicant.personId, verified: true },
        selected: { id: submissionId, status: "draft" },
      });
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
                 AND action = 'submission.draft.created') AS auditCount,
             (SELECT COUNT(*) FROM memberships
               WHERE event_id = ? AND person_id = ? AND role = 'submitter'
                 AND accepted_at IS NOT NULL AND revoked_at IS NULL) AS membershipCount`,
        )
          .bind(
            first,
            viewer.eventId,
            id,
            applicant.personId,
            first,
            viewer.eventId,
            first,
            viewer.eventId,
            applicant.personId,
          )
          .first(),
      ).resolves.toEqual({
        submissionCount: 1,
        revisionCount: 1,
        auditCount: 1,
        membershipCount: 1,
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
          `SELECT role FROM memberships
            WHERE event_id = ? AND person_id = ? AND role = 'submitter'
              AND accepted_at IS NOT NULL AND revoked_at IS NULL`,
        )
          .bind(form.eventId, verified!.personId)
          .first(),
      ).toEqual({ role: "submitter" });
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
});

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
});

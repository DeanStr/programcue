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

async function acceptedParticipant(email: string, name: string) {
  const personId = `accepted-person-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status
       ) VALUES (?, ?, ?, 1, 'draft')`,
    ).bind(personId, email, name),
    env.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, invited_at,
         accepted_at, created_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      `accepted-membership-${crypto.randomUUID()}`,
      viewer.organisationId,
      viewer.eventId,
      personId,
    ),
  ]);
  return personId;
}

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
  describe("administration intake workflows", () => {
    it("creates a tenant-scoped immutable manual application", async () => {
      const { service } = await publishedForm();
      const teamId = `team-manual-${crypto.randomUUID()}`;
      const teamName = `Manual ${crypto.randomUUID()}`;
      const planId = `plan-manual-${crypto.randomUUID()}`;
      const roundId = `round-manual-${crypto.randomUUID()}`;
      const submitterEmail = `partner-${crypto.randomUUID()}@example.com`;
      const speakerEmail = `guaranteed-${crypto.randomUUID()}@example.com`;
      await Promise.all([
        acceptedParticipant(submitterEmail, "Partner Coordinator"),
        acceptedParticipant(speakerEmail, "Guaranteed Speaker"),
      ]);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
           VALUES (?, ?, 'Manual entry review', 'active')`,
        ).bind(planId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Manual review', 'active', ?)`,
        ).bind(roundId, viewer.eventId, planId, roundId),
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
        submitterEmail,
        routedTeamIds: [teamId],
        speakers: [
          {
            name: "Guaranteed Speaker",
            email: speakerEmail,
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

    it("refuses to claim an unaccepted identity for a manual application", async () => {
      const { service } = await publishedForm();
      const email = `unaccepted-manual-${crypto.randomUUID()}@example.com`;
      await expect(
        service.createManualApplication(viewer, {
          idempotencyKey: `unaccepted:${crypto.randomUUID()}`,
          title: "Unaccepted manual proposal",
          description: "This must wait for participant acceptance.",
          trackIds: ["demo-track-ai"],
          format: "presentation",
          submitterName: "Unaccepted participant",
          submitterEmail: email,
          routedTeamIds: [],
          speakers: [{ name: "Unaccepted participant", email }],
        }),
      ).rejects.toThrow(/invite.*wait for acceptance/i);
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
      const firstSession = await service.createDirectSession(
        viewer,
        directInput,
      );
      expect(firstSession.invitationDeliveries).toEqual(["demo_not_sent"]);
      await expect(
        service.createDirectSession(viewer, directInput),
      ).resolves.toMatchObject({
        sessionId: firstSession.sessionId,
        replayed: true,
        invitationDeliveries: firstSession.invitationDeliveries,
        invitationWarning: firstSession.invitationWarning,
        webhookDeliveries: firstSession.webhookDeliveries,
        webhookWarning: firstSession.webhookWarning,
      });
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
          .bind(firstSession.sessionId, viewer.eventId)
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
      await Promise.all([
        acceptedParticipant(
          manualInput.submitterEmail,
          manualInput.submitterName,
        ),
        acceptedParticipant(
          manualInput.speakers[0]!.email,
          manualInput.speakers[0]!.name,
        ),
      ]);
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

      const created = await service.createDirectSession(viewer, {
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
        .bind(created.sessionId)
        .first<{ status: string; sourceSubmissionId: string | null }>();
      expect(session).toEqual({
        status: "unscheduled",
        sourceSubmissionId: null,
      });
      await expect(
        env.DB.prepare(
          `SELECT membership.accepted_at IS NOT NULL AS accepted,
                  membership.revoked_at AS revokedAt
             FROM memberships membership
             JOIN people person ON person.id = membership.person_id
            WHERE membership.event_id = ? AND membership.role = 'speaker'
              AND person.email = ? COLLATE NOCASE`,
        )
          .bind(viewer.eventId, "morgan-sponsor@example.com")
          .first(),
      ).resolves.toEqual({ accepted: 0, revokedAt: null });
      const audit = await env.DB.prepare(
        "SELECT action FROM audit_events WHERE entity_id = ?",
      )
        .bind(created.sessionId)
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

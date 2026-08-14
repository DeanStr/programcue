import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { SBEK_FIXTURE_PEOPLE } from "~/platform/demo/demo-identities";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  SubmissionRevisionConflictError,
  type Applicant,
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

async function submitValidApplication(
  service: SubmissionService,
  formId: string,
  slug: string,
  applicant: Applicant,
) {
  const submissionId = await service.createDraft(slug, applicant);
  const draft = (
    await service.repository.getApplicantDrafts(formId, applicant)
  ).find((candidate) => candidate.id === submissionId)!;
  await service.submitDraft(slug, applicant, {
    submissionId,
    revision: draft.revision,
    answers: validAnswers,
    speakers: [
      {
        name: applicant.name,
        email: applicant.email,
        biography: applicant.biography,
      },
    ],
  });
  const submitted = (
    await service.repository.getApplicantDrafts(formId, applicant)
  ).find((candidate) => candidate.id === submissionId)!;
  return { submissionId, submitted };
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

function withCommittedBatchResponseLoss(
  testEnv: CloudflareEnvironment,
  batchNumber = 1,
) {
  let batches = 0;
  const losingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          const results = await target.batch(statements);
          if (batches === batchNumber) {
            throw new Error("The committed revision response was lost.");
          }
          return results;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? losingDb : Reflect.get(target, property);
    },
  });
}

function withSuppressedRevisionCompletion(testEnv: CloudflareEnvironment) {
  const guardedDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (
            query.includes("SET status = 'completed'") &&
            query.includes("submission_revisions revision")
          ) {
            const noOp = target.prepare(
              "UPDATE idempotency_records SET completed_at = completed_at WHERE 0",
            );
            return new Proxy(noOp, {
              get(statement, statementProperty) {
                if (statementProperty === "bind") return () => noOp;
                const value = Reflect.get(statement, statementProperty);
                return typeof value === "function"
                  ? value.bind(statement)
                  : value;
              },
            });
          }
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? guardedDb : Reflect.get(target, property);
    },
  });
}

describe("Submissions D1 vertical slice", () => {
  describe("applicant draft and submission workflows", () => {
    it("routes an exact evaluation co-speaker alias before persisting the draft and audit", async () => {
      const {
        service: setupService,
        id,
        slug,
        testEnv,
      } = await publishedForm();
      const routeable = {
        [SBEK_FIXTURE_PEOPLE.organizer.personId]:
          "evaluation-organizer@programcue.dev",
        [SBEK_FIXTURE_PEOPLE.speaker.personId]:
          "evaluation-speaker@programcue.dev",
        [SBEK_FIXTURE_PEOPLE.speaker2.personId]:
          "evaluation-speaker-2@programcue.dev",
        [SBEK_FIXTURE_PEOPLE.reviewer.personId]:
          "evaluation-reviewer@programcue.dev",
      } as const;
      await testEnv.DB.batch(
        Object.entries(routeable).map(([personId, email]) =>
          testEnv.DB.prepare("UPDATE people SET email = ? WHERE id = ?").bind(
            email,
            personId,
          ),
        ),
      );
      const evaluationEnv = {
        ...testEnv,
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "true",
      } as unknown as CloudflareEnvironment;
      const service = new SubmissionService(evaluationEnv);
      const applicant: Extract<Applicant, { verified: true }> = {
        personId: SBEK_FIXTURE_PEOPLE.speaker.personId,
        email: routeable[SBEK_FIXTURE_PEOPLE.speaker.personId],
        name: SBEK_FIXTURE_PEOPLE.speaker.name,
        biography: "",
        profileRevision: 1,
        verified: true,
        anonymousDraftId: null,
        evaluation: true,
      };
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await setupService.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const enteredEmail = "marcus.speaker@sbek-test.example.com";
      await service.saveDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          { name: applicant.name, email: applicant.email, biography: "" },
          { name: "Marcus Okafor", email: enteredEmail, biography: "" },
        ],
      });

      await expect(
        testEnv.DB.prepare(
          `SELECT speaker.email,
                  json_extract(audit.metadata_json, '$.evaluatorEmailRoutings[0].enteredEmail') AS enteredEmail,
                  json_extract(audit.metadata_json, '$.evaluatorEmailRoutings[0].routedEmail') AS routedEmail,
                  json_extract(audit.metadata_json, '$.evaluatorEmailRoutings[0].personId') AS routedPersonId
             FROM submission_speakers speaker
             JOIN audit_events audit
               ON audit.event_id = speaker.event_id
              AND audit.entity_id = speaker.submission_id
              AND audit.action = 'submission.draft.saved'
            WHERE speaker.submission_id = ? AND speaker.position = 1`,
        )
          .bind(submissionId)
          .first(),
      ).resolves.toEqual({
        email: routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
        enteredEmail,
        routedEmail: routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
        routedPersonId: SBEK_FIXTURE_PEOPLE.speaker2.personId,
      });
    });

    it("revises an owned submitted application while preserving its prior revision and routing", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const prior = await testEnv.DB.prepare(
        `SELECT submitted_snapshot_json AS snapshotJson
           FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ snapshotJson: string }>();
      const priorTracks = await testEnv.DB.prepare(
        `SELECT track_id AS trackId, track_name_snapshot AS trackName,
                position
           FROM submission_track_selections
          WHERE submission_id = ? AND event_id = ? ORDER BY position`,
      )
        .bind(submissionId, viewer.eventId)
        .all();
      const priorSpeaker = await testEnv.DB.prepare(
        `SELECT id, person_id AS personId, email, display_name AS displayName,
                role_label AS roleLabel, position,
                invitation_status AS invitationStatus,
                is_primary AS isPrimary, claimed_at AS claimedAt,
                created_at AS createdAt, updated_at AS updatedAt
           FROM submission_speakers
          WHERE submission_id = ? AND event_id = ? AND is_primary = 1`,
      )
        .bind(submissionId, viewer.eventId)
        .first();
      await testEnv.DB.prepare(
        `UPDATE form_definitions SET submission_limit = 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(id, viewer.eventId)
        .run();
      const appended = "Updated: now includes 2026 benchmark data.";
      const revisedAnswers = {
        ...validAnswers,
        description: `${validAnswers.description} ${appended}`,
      };

      const revised = await service.reviseSubmitted(
        slug,
        applicant,
        {
          submissionId,
          revision: submitted.revision,
          answers: revisedAnswers,
          speakers: submitted.speakers.map((speaker) => ({
            name: speaker.name,
            email: speaker.email,
            biography: speaker.biography,
          })),
          uploads: submitted.uploads,
        },
        crypto.randomUUID(),
      );

      expect(revised).toMatchObject({
        submissionId,
        revision: submitted.revision + 1,
        invitations: { queued: 0, queueFailed: 0 },
      });
      const reloaded = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      expect(reloaded.answers.description).toContain(appended);
      expect(reloaded.speakers).toHaveLength(1);
      const adminDetail = await service.getAdminSubmission(
        viewer,
        submissionId,
      );
      expect(adminDetail?.answers.description).toContain(appended);
      const revisions = await testEnv.DB.prepare(
        `SELECT revision_number AS revisionNumber, answers_json AS answersJson,
                save_kind AS saveKind
           FROM submission_revisions
          WHERE submission_id = ? AND revision_number IN (?, ?)
          ORDER BY revision_number`,
      )
        .bind(submissionId, submitted.revision, revised.revision)
        .all<{
          revisionNumber: number;
          answersJson: string;
          saveKind: string;
        }>();
      expect(revisions.results).toHaveLength(2);
      expect(JSON.parse(revisions.results[0]!.answersJson).description).toBe(
        validAnswers.description,
      );
      expect(
        JSON.parse(revisions.results[1]!.answersJson).description,
      ).toContain(appended);
      expect(revisions.results.map((revision) => revision.saveKind)).toEqual([
        "submitted",
        "submitted",
      ]);
      expect(JSON.parse(prior!.snapshotJson).answers.description).toBe(
        validAnswers.description,
      );
      await expect(
        testEnv.DB.prepare(
          `SELECT track_id AS trackId, track_name_snapshot AS trackName,
                  position
             FROM submission_track_selections
            WHERE submission_id = ? AND event_id = ? ORDER BY position`,
        )
          .bind(submissionId, viewer.eventId)
          .all(),
      ).resolves.toMatchObject({ results: priorTracks.results });
      await expect(
        testEnv.DB.prepare(
          `SELECT id, person_id AS personId, email, display_name AS displayName,
                  role_label AS roleLabel, position,
                  invitation_status AS invitationStatus,
                  is_primary AS isPrimary, claimed_at AS claimedAt,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM submission_speakers
            WHERE submission_id = ? AND event_id = ? AND is_primary = 1`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual(priorSpeaker);
      await expect(
        testEnv.DB.prepare(
          `SELECT action FROM audit_events
            WHERE event_id = ? AND entity_id = ? AND action = 'submission.revised'`,
        )
          .bind(viewer.eventId, submissionId)
          .first(),
      ).resolves.toEqual({ action: "submission.revised" });
    });

    it("converges concurrent exact submitted-revision retries to one durable result", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const intentId = `revision-${crypto.randomUUID()}`;
      const payload = {
        submissionId,
        revision: submitted.revision,
        answers: {
          ...validAnswers,
          description: `${validAnswers.description} Concurrent replay proof.`,
        },
        speakers: submitted.speakers.map((speaker) => ({
          name: speaker.name,
          email: speaker.email,
          biography: speaker.biography,
        })),
        uploads: submitted.uploads,
      };

      const [first, concurrent] = await Promise.all([
        service.reviseSubmitted(slug, applicant, payload, intentId),
        service.reviseSubmitted(slug, applicant, payload, intentId),
      ]);
      const replay = await service.reviseSubmitted(
        slug,
        applicant,
        payload,
        intentId,
      );

      expect(concurrent).toEqual(first);
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        submissionId,
        revision: submitted.revision + 1,
        invitations: { queued: 0, queueFailed: 0 },
        webhookQueueFailed: false,
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM submission_revisions revision
               WHERE revision.submission_id = ?
                 AND revision.revision_number = ?
                 AND revision.save_kind = 'submitted') AS revisionCount,
             (SELECT COUNT(*) FROM audit_events audit
               WHERE audit.event_id = ? AND audit.entity_id = ?
                 AND audit.action = 'submission.revised') AS auditCount,
             (SELECT COUNT(*) FROM idempotency_records command
               WHERE command.event_id = ?
                 AND command.actor_id = ?
                 AND command.scope = 'submission.submitted.revise'
                 AND command.status = 'completed'
                 AND command.entity_id = ?) AS commandCount`,
        )
          .bind(
            submissionId,
            submitted.revision + 1,
            viewer.eventId,
            submissionId,
            viewer.eventId,
            `person:${applicant.personId}`,
            submissionId,
          )
          .first(),
      ).resolves.toEqual({ revisionCount: 1, auditCount: 1, commandCount: 1 });
    });

    it("rejects changed submitted-revision details under the same intent key", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const intentId = `revision-${crypto.randomUUID()}`;
      const payload = {
        submissionId,
        revision: submitted.revision,
        answers: {
          ...validAnswers,
          description: `${validAnswers.description} Original revision.`,
        },
        speakers: submitted.speakers.map((speaker) => ({
          name: speaker.name,
          email: speaker.email,
          biography: speaker.biography,
        })),
        uploads: submitted.uploads,
      };
      await service.reviseSubmitted(slug, applicant, payload, intentId);

      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            ...payload,
            answers: {
              ...payload.answers,
              description: `${payload.answers.description} Changed reuse.`,
            },
          },
          intentId,
        ),
      ).rejects.toThrow(/used with different application details/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT revision, answers_json AS answersJson
             FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first<{ revision: number; answersJson: string }>(),
      ).resolves.toMatchObject({
        revision: submitted.revision + 1,
        answersJson: expect.not.stringContaining("Changed reuse"),
      });
    });

    it("recovers a lost post-commit response and resumes only persisted invitation and webhook work", async () => {
      const { service, id, slug, queued, testEnv } = await publishedForm();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Revision recovery invitations', 'Program Cue',
                   'revisions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`sender-recovery-${crypto.randomUUID()}`, viewer.eventId)
        .run();
      const endpointId = `revision-recovery-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_by_person_id
         ) VALUES (?, ?, ?, 'Revision recovery',
                   'https://hooks.example.com/revision-recovery', 'test-only',
                   '["submission.updated"]', 'active', ?)`,
      )
        .bind(
          endpointId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
        )
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      queued.length = 0;
      const intentId = `revision-${crypto.randomUUID()}`;
      const coSpeakerEmail = `revision-recovery-${crypto.randomUUID()}@example.com`;
      const payload = {
        submissionId,
        revision: submitted.revision,
        answers: {
          ...validAnswers,
          description: `${validAnswers.description} Lost response recovery.`,
        },
        speakers: [
          ...submitted.speakers.map((speaker) => ({
            name: speaker.name,
            email: speaker.email,
            biography: speaker.biography,
          })),
          {
            name: "Recovery Co-speaker",
            email: coSpeakerEmail,
            biography: "Tests durable invitation recovery.",
          },
        ],
        uploads: submitted.uploads,
      };
      const responseLossEnv = withCommittedBatchResponseLoss(testEnv);

      await expect(
        new SubmissionService(responseLossEnv).reviseSubmitted(
          slug,
          applicant,
          payload,
          intentId,
        ),
      ).rejects.toThrow(/committed revision response was lost/i);
      expect(queued).toEqual([]);
      await expect(
        testEnv.DB.prepare(
          `SELECT submission.revision,
                  command.id AS commandId, command.status AS commandStatus,
                  (SELECT COUNT(*) FROM operation_jobs operation
                    WHERE operation.event_id = submission.event_id
                      AND operation.dispatched_at IS NOT NULL
                      AND (
                        EXISTS (
                          SELECT 1 FROM communications communication
                           WHERE communication.operation_id = operation.id
                             AND communication.event_id = operation.event_id
                             AND json_extract(communication.audience_json,
                                              '$.submissionOperationId') =
                                 command.id
                        )
                        OR EXISTS (
                          SELECT 1 FROM operation_items item
                          JOIN webhook_deliveries delivery
                            ON delivery.id = item.entity_id
                           AND item.entity_type = 'webhook_delivery'
                           WHERE item.operation_id = operation.id
                             AND delivery.entity_id = submission.id
                             AND delivery.event_type = 'submission.updated'
                        )
                      )) AS dispatchedCount
             FROM submissions submission
             JOIN idempotency_records command
               ON command.entity_id = submission.id
              AND command.event_id = submission.event_id
              AND command.scope = 'submission.submitted.revise'
            WHERE submission.id = ? AND submission.event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toMatchObject({
        revision: submitted.revision + 1,
        commandStatus: "completed",
        dispatchedCount: 0,
      });

      const recovered = await service.reviseSubmitted(
        slug,
        applicant,
        payload,
        intentId,
      );
      expect(recovered).toMatchObject({
        submissionId,
        revision: submitted.revision + 1,
        invitations: { queued: 1, queueFailed: 0 },
        webhookQueueFailed: false,
      });
      expect(
        queued.map((message) =>
          typeof message === "object" && message && "type" in message
            ? message.type
            : null,
        ),
      ).toEqual(
        expect.arrayContaining(["communication.send", "webhook.deliver"]),
      );
      const queuedAfterRecovery = queued.length;
      await expect(
        service.reviseSubmitted(slug, applicant, payload, intentId),
      ).resolves.toEqual(recovered);
      expect(queued).toHaveLength(queuedAfterRecovery);
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM submission_revisions revision
               WHERE revision.submission_id = ?
                 AND revision.revision_number = ?) AS revisionCount,
             (SELECT COUNT(*) FROM audit_events audit
               WHERE audit.event_id = ? AND audit.entity_id = ?
                 AND audit.action = 'submission.revised') AS auditCount,
             (SELECT COUNT(*) FROM webhook_deliveries delivery
               WHERE delivery.endpoint_id = ? AND delivery.entity_id = ?
                 AND delivery.event_type = 'submission.updated') AS webhookCount,
             (SELECT COUNT(*) FROM communications communication
               WHERE communication.event_id = ?
                 AND json_extract(communication.audience_json,
                                  '$.submissionId') = ?) AS invitationCount`,
        )
          .bind(
            submissionId,
            submitted.revision + 1,
            viewer.eventId,
            submissionId,
            endpointId,
            submissionId,
            viewer.eventId,
            submissionId,
          )
          .first(),
      ).resolves.toEqual({
        revisionCount: 1,
        auditCount: 1,
        webhookCount: 1,
        invitationCount: 1,
      });
    });

    it("rolls back a submitted revision when its durable completion cannot be recorded", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const guardedEnv = withSuppressedRevisionCompletion(testEnv);

      await expect(
        new SubmissionService(guardedEnv).reviseSubmitted(
          slug,
          applicant,
          {
            submissionId,
            revision: submitted.revision,
            answers: {
              ...validAnswers,
              description: `${validAnswers.description} Must roll back.`,
            },
            speakers: submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            uploads: submitted.uploads,
          },
          `revision-${crypto.randomUUID()}`,
        ),
      ).rejects.toThrow(/CHECK constraint failed/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT submission.revision,
                  instr(submission.answers_json, 'Must roll back') AS changed,
                  (SELECT COUNT(*) FROM submission_revisions revision
                    WHERE revision.submission_id = submission.id
                      AND revision.revision_number = ?) AS revisionCount,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.event_id = submission.event_id
                      AND audit.entity_id = submission.id
                      AND audit.action = 'submission.revised') AS auditCount,
                  (SELECT COUNT(*) FROM idempotency_records command
                    WHERE command.event_id = submission.event_id
                      AND command.entity_id = submission.id
                      AND command.scope = 'submission.submitted.revise')
                    AS commandCount
             FROM submissions submission
            WHERE submission.id = ? AND submission.event_id = ?`,
        )
          .bind(submitted.revision + 1, submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        revision: submitted.revision,
        changed: 0,
        revisionCount: 0,
        auditCount: 0,
        commandCount: 0,
      });
    });

    it("adds a co-speaker in a submitted revision and queues the durable claim invitation", async () => {
      const { service, id, slug, queued, testEnv } = await publishedForm();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Submitted revision invitations', 'Program Cue',
                   'submissions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`sender-revision-${crypto.randomUUID()}`, viewer.eventId)
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const coSpeakerEmail = `revision-speaker-${crypto.randomUUID()}@example.com`;

      const revised = await service.reviseSubmitted(
        slug,
        applicant,
        {
          submissionId,
          revision: submitted.revision,
          answers: validAnswers,
          speakers: [
            ...submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            {
              name: "Marcus Okafor",
              email: coSpeakerEmail,
              biography: "Staff Developer Advocate at Cloudreach Labs.",
            },
          ],
          uploads: submitted.uploads,
        },
        crypto.randomUUID(),
      );

      expect(revised.invitations).toEqual({ queued: 1, queueFailed: 0 });
      expect(
        queued.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "communication.send",
        ),
      ).toBe(true);
      await expect(
        testEnv.DB.prepare(
          `SELECT display_name AS name, role_label AS roleLabel,
                  invitation_status AS invitationStatus
             FROM submission_speakers
            WHERE submission_id = ? AND event_id = ? AND email = ? COLLATE NOCASE`,
        )
          .bind(submissionId, viewer.eventId, coSpeakerEmail)
          .first(),
      ).resolves.toEqual({
        name: "Marcus Okafor",
        roleLabel: "Co-speaker",
        invitationStatus: "sent",
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT speaker_snapshot_json AS speakersJson
             FROM submission_revisions
            WHERE submission_id = ? AND revision_number = ?`,
        )
          .bind(submissionId, revised.revision)
          .first<{ speakersJson: string }>(),
      ).resolves.toMatchObject({
        speakersJson: expect.stringContaining("Marcus Okafor"),
      });
      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            submissionId,
            revision: revised.revision,
            answers: validAnswers,
            speakers: submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            uploads: submitted.uploads,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/cannot be removed, reordered or edited/i);
    });

    it("uses the current public slug for a co-speaker added to an older form-version submission", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Republished revision invitations', 'Program Cue',
                   'republished@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`sender-republished-${crypto.randomUUID()}`, viewer.eventId)
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const revisedSlug = `revised-slug-${crypto.randomUUID().slice(0, 8)}`;
      const workspace = await service.getAdminWorkspace(viewer, id);
      await service.saveForm(viewer, {
        ...SubmissionService.workspaceToInput(workspace!),
        publicSlug: revisedSlug,
      });
      const updatedWorkspace = await service.getAdminWorkspace(viewer, id);
      await service.publishForm(
        viewer,
        id,
        updatedWorkspace!.revision,
        updatedWorkspace!.draftVersion.revision,
      );
      const coSpeakerEmail = `republished-${crypto.randomUUID()}@example.com`;

      await service.reviseSubmitted(
        revisedSlug,
        applicant,
        {
          submissionId,
          revision: submitted.revision,
          answers: validAnswers,
          speakers: [
            ...submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            {
              name: "New Co-speaker",
              email: coSpeakerEmail,
              biography: "A co-speaker invited after the form was republished.",
            },
          ],
          uploads: submitted.uploads,
        },
        crypto.randomUUID(),
      );

      const delivery = await testEnv.DB.prepare(
        `SELECT source_values_json AS sourceValuesJson
           FROM communication_deliveries
          WHERE event_id = ? AND recipient_address = ?`,
      )
        .bind(viewer.eventId, coSpeakerEmail)
        .first<{ sourceValuesJson: string }>();
      const claimUrl = new URL(
        JSON.parse(delivery!.sourceValuesJson)["claim.url"],
      );
      expect(claimUrl.pathname).toBe(`/apply/${revisedSlug}`);
      expect(claimUrl.pathname).not.toBe(`/apply/${slug}`);
    });

    it("retains an immutable conditional native upload when a revision hides its field", async () => {
      const conditionalSchema = structuredClone(DEFAULT_FORM_SCHEMA);
      const videoField = conditionalSchema.fields.find(
        (field) => field.id === "video",
      )!;
      videoField.condition = { fieldId: "format", equals: "Presentation" };
      const { service, id, slug, testEnv } = await publishedForm({
        schema: conditionalSchema,
      });
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
      const submittedAnswers = { ...validAnswers, video: "" };
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: submittedAnswers,
        speakers: [
          {
            name: applicant.name,
            email: applicant.email,
            biography: applicant.biography,
          },
        ],
        uploads: { video: upload },
      });
      const submitted = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;

      await service.reviseSubmitted(
        slug,
        applicant,
        {
          submissionId,
          revision: submitted.revision,
          answers: {
            ...submittedAnswers,
            format: "Panel",
            video: "",
          },
          speakers: submitted.speakers.map((speaker) => ({
            name: speaker.name,
            email: speaker.email,
            biography: speaker.biography,
          })),
          uploads: { video: upload },
        },
        crypto.randomUUID(),
      );

      const reloaded = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      expect(reloaded.answers.format).toBe("Panel");
      expect(reloaded.answers).not.toHaveProperty("video");
      expect(reloaded.uploads).toEqual({ video: upload });
      const snapshot = await testEnv.DB.prepare(
        `SELECT submitted_snapshot_json AS snapshotJson
           FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ snapshotJson: string }>();
      expect(JSON.parse(snapshot!.snapshotJson).uploads).toEqual({
        video: upload,
      });
    });

    it("fails fast without mutation when the submitted snapshot has the wrong form version", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const row = await testEnv.DB.prepare(
        `SELECT submitted_snapshot_json AS snapshotJson
           FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ snapshotJson: string }>();
      const corruptSnapshot = {
        ...JSON.parse(row!.snapshotJson),
        formVersionId: "wrong-form-version",
      };
      await testEnv.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
          WHERE id = ? AND event_id = ?`,
      )
        .bind(JSON.stringify(corruptSnapshot), submissionId, viewer.eventId)
        .run();

      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            submissionId,
            revision: submitted.revision,
            answers: {
              ...validAnswers,
              description: "This corrupt submission must not be revised.",
            },
            speakers: submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            uploads: submitted.uploads,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/wrong form version/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT revision, submitted_snapshot_json AS snapshotJson
             FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        revision: submitted.revision,
        snapshotJson: JSON.stringify(corruptSnapshot),
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND entity_id = ?
              AND action = 'submission.revised'`,
        )
          .bind(viewer.eventId, submissionId)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    });

    it("fails fast without mutation when an unclaimed speaker is missing or duplicated in the submitted snapshot", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Snapshot corruption invitations', 'Program Cue',
                   'snapshot-corruption@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(
          `sender-snapshot-corruption-${crypto.randomUUID()}`,
          viewer.eventId,
        )
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const coSpeakerEmail = `snapshot-corruption-${crypto.randomUUID()}@example.com`;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          {
            name: applicant.name,
            email: applicant.email,
            biography: applicant.biography,
          },
          {
            name: "Pending snapshot speaker",
            email: coSpeakerEmail,
            biography: "",
          },
        ],
      });
      const submitted = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const stored = await testEnv.DB.prepare(
        `SELECT answers_json AS answersJson,
                submitted_snapshot_json AS snapshotJson
           FROM submissions WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .first<{ answersJson: string; snapshotJson: string }>();
      const originalSnapshot = JSON.parse(stored!.snapshotJson) as {
        speakers: Array<{ name: string; email: string; biography?: string }>;
      };
      const pendingSnapshotSpeaker = originalSnapshot.speakers.find(
        (speaker) => speaker.email === coSpeakerEmail,
      )!;
      const corruptions = [
        {
          snapshot: {
            ...originalSnapshot,
            speakers: originalSnapshot.speakers.filter(
              (speaker) => speaker.email !== coSpeakerEmail,
            ),
          },
          error: /persisted speaker relationship missing/i,
        },
        {
          snapshot: {
            ...originalSnapshot,
            speakers: [
              ...originalSnapshot.speakers,
              {
                ...pendingSnapshotSpeaker,
                email: coSpeakerEmail.toUpperCase(),
              },
            ],
          },
          error: /invalid submitted snapshot/i,
        },
      ];

      for (const corruption of corruptions) {
        const snapshotJson = JSON.stringify(corruption.snapshot);
        await testEnv.DB.prepare(
          `UPDATE submissions SET submitted_snapshot_json = ?
            WHERE id = ? AND event_id = ?`,
        )
          .bind(snapshotJson, submissionId, viewer.eventId)
          .run();

        await expect(
          service.reviseSubmitted(
            slug,
            applicant,
            {
              submissionId,
              revision: submitted.revision,
              answers: {
                ...validAnswers,
                description: "This corrupt speaker snapshot must not commit.",
              },
              speakers: submitted.speakers.map((speaker) => ({
                name: speaker.name,
                email: speaker.email,
                biography: speaker.biography,
              })),
              uploads: submitted.uploads,
            },
            crypto.randomUUID(),
          ),
        ).rejects.toThrow(corruption.error);
        await expect(
          testEnv.DB.prepare(
            `SELECT submission.revision,
                    submission.answers_json AS answersJson,
                    submission.submitted_snapshot_json AS snapshotJson,
                    (SELECT COUNT(*) FROM submission_revisions revision
                      WHERE revision.submission_id = submission.id
                        AND revision.event_id = submission.event_id
                        AND revision.revision_number = ?) AS revisionCount,
                    (SELECT COUNT(*) FROM audit_events audit
                      WHERE audit.event_id = submission.event_id
                        AND audit.entity_id = submission.id
                        AND audit.action = 'submission.revised') AS auditCount,
                    (SELECT COUNT(*) FROM idempotency_records command
                      WHERE command.event_id = submission.event_id
                        AND command.actor_id = ?
                        AND command.scope = 'submission.submitted.revise')
                      AS commandCount
               FROM submissions submission
              WHERE submission.id = ? AND submission.event_id = ?`,
          )
            .bind(
              submitted.revision + 1,
              `person:${applicant.personId}`,
              submissionId,
              viewer.eventId,
            )
            .first(),
        ).resolves.toEqual({
          revision: submitted.revision,
          answersJson: stored!.answersJson,
          snapshotJson,
          revisionCount: 0,
          auditCount: 0,
          commandCount: 0,
        });
      }
    });

    it("rejects a submitted revision when the form changes before its atomic commit", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.prepare(
          `UPDATE form_definitions
              SET revision = revision + 1, public_slug = ?
            WHERE id = ? AND event_id = ?`,
        )
          .bind(`raced-${crypto.randomUUID().slice(0, 8)}`, id, viewer.eventId)
          .run();
      });

      await expect(
        new SubmissionService(racingEnv).reviseSubmitted(
          slug,
          applicant,
          {
            submissionId,
            revision: submitted.revision,
            answers: {
              ...validAnswers,
              description: "This raced revision must not commit.",
            },
            speakers: submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            uploads: submitted.uploads,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/changed before the revision was saved/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT revision, submitted_snapshot_json AS snapshotJson
             FROM submissions WHERE id = ? AND event_id = ?`,
        )
          .bind(submissionId, viewer.eventId)
          .first<{ revision: number; snapshotJson: string }>(),
      ).resolves.toMatchObject({
        revision: submitted.revision,
        snapshotJson: expect.not.stringContaining("raced revision"),
      });
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND entity_id = ?
              AND action = 'submission.revised'`,
        )
          .bind(viewer.eventId, submissionId)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    });

    it("rejects a submitted revision when a pending co-speaker is claimed at its atomic commit boundary", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Revision claim race invitations', 'Program Cue',
                   'revision-races@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`sender-revision-race-${crypto.randomUUID()}`, viewer.eventId)
        .run();
      const applicant = await verifiedApplicant(service, slug);
      const submissionId = await service.createDraft(slug, applicant);
      const draft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const coSpeakerEmail = `revision-race-${crypto.randomUUID()}@example.com`;
      await service.submitDraft(slug, applicant, {
        submissionId,
        revision: draft.revision,
        answers: validAnswers,
        speakers: [
          {
            name: applicant.name,
            email: applicant.email,
            biography: applicant.biography,
          },
          {
            name: "Claimed during revision",
            email: coSpeakerEmail,
            biography: "This relationship changes at the write boundary.",
          },
        ],
      });
      const submitted = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((candidate) => candidate.id === submissionId)!;
      const pendingSpeaker = await testEnv.DB.prepare(
        `SELECT id, person_id AS personId,
                invitation_status AS invitationStatus
           FROM submission_speakers
          WHERE submission_id = ? AND event_id = ?
            AND email = ? COLLATE NOCASE`,
      )
        .bind(submissionId, viewer.eventId, coSpeakerEmail)
        .first<{
          id: string;
          personId: string | null;
          invitationStatus: string;
        }>();
      expect(pendingSpeaker).toMatchObject({
        personId: null,
        invitationStatus: "sent",
      });
      const claimedPersonId = crypto.randomUUID();
      const intentId = crypto.randomUUID();
      const racingEnv = withNthBatchRace(testEnv, 1, async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `INSERT INTO people (
               id, email, display_name, email_verified, profile_status,
               created_at, updated_at
             ) VALUES (?, ?, 'Claimed during revision', 1, 'published',
                       unixepoch(), unixepoch())`,
          ).bind(claimedPersonId, coSpeakerEmail),
          testEnv.DB.prepare(
            `UPDATE submission_speakers
                SET person_id = ?, invitation_status = 'claimed',
                    claimed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ? AND submission_id = ? AND event_id = ?
                AND person_id IS NULL
                AND invitation_status IN ('pending', 'sent')`,
          ).bind(
            claimedPersonId,
            pendingSpeaker!.id,
            submissionId,
            viewer.eventId,
          ),
        ]);
      });

      await expect(
        new SubmissionService(racingEnv).reviseSubmitted(
          slug,
          applicant,
          {
            submissionId,
            revision: submitted.revision,
            answers: {
              ...validAnswers,
              description: "This stale speaker snapshot must not commit.",
            },
            speakers: submitted.speakers.map((speaker) => ({
              name: speaker.name,
              email: speaker.email,
              biography: speaker.biography,
            })),
            uploads: submitted.uploads,
          },
          intentId,
        ),
      ).rejects.toThrow(/changed before the revision was saved/i);
      await expect(
        testEnv.DB.prepare(
          `SELECT submission.revision,
                  instr(submission.answers_json, 'stale speaker snapshot') AS changed,
                  speaker.person_id AS personId,
                  speaker.invitation_status AS invitationStatus,
                  (SELECT COUNT(*) FROM submission_revisions revision
                    WHERE revision.submission_id = submission.id
                      AND revision.revision_number = ?) AS revisionCount,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.event_id = submission.event_id
                      AND audit.entity_id = submission.id
                      AND audit.action = 'submission.revised') AS auditCount,
                  (SELECT COUNT(*) FROM idempotency_records command
                    WHERE command.event_id = submission.event_id
                      AND command.scope = 'submission.submitted.revise'
                      AND command.idempotency_key = ?)
                    AS commandCount
             FROM submissions submission
             JOIN submission_speakers speaker
               ON speaker.submission_id = submission.id
              AND speaker.event_id = submission.event_id
              AND speaker.id = ?
            WHERE submission.id = ? AND submission.event_id = ?`,
        )
          .bind(
            submitted.revision + 1,
            `airtable:${viewer.eventId}:submission.submitted.revise:intent:${applicant.personId}:${intentId}`,
            pendingSpeaker!.id,
            submissionId,
            viewer.eventId,
          )
          .first(),
      ).resolves.toEqual({
        revision: submitted.revision,
        changed: 0,
        personId: claimedPersonId,
        invitationStatus: "claimed",
        revisionCount: 0,
        auditCount: 0,
        commandCount: 0,
      });
    });

    it("fails submitted revisions after review starts, after close, or on a stale revision", async () => {
      const { service, id, slug, testEnv } = await publishedForm();
      const applicant = await verifiedApplicant(service, slug);
      const { submissionId, submitted } = await submitValidApplication(
        service,
        id,
        slug,
        applicant,
      );
      const payload = {
        submissionId,
        revision: submitted.revision,
        answers: { ...validAnswers, description: "A safe revised abstract." },
        speakers: submitted.speakers.map((speaker) => ({
          name: speaker.name,
          email: speaker.email,
          biography: speaker.biography,
        })),
        uploads: submitted.uploads,
      };

      await testEnv.DB.prepare(
        `UPDATE submissions SET status = 'assigned', revision = revision + 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            ...payload,
            revision: submitted.revision + 1,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/no review in progress/i);
      await testEnv.DB.prepare(
        `UPDATE submissions SET status = 'accepted', revision = revision + 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            ...payload,
            revision: submitted.revision + 2,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/no review in progress/i);
      await testEnv.DB.prepare(
        `UPDATE submissions SET status = 'submitted', revision = revision + 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await testEnv.DB.prepare(
        `UPDATE form_definitions SET closes_at = unixepoch() - 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(id, viewer.eventId)
        .run();
      await expect(
        service.reviseSubmitted(
          slug,
          applicant,
          {
            ...payload,
            revision: submitted.revision + 3,
          },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/closed/i);
      await testEnv.DB.prepare(
        `UPDATE form_definitions SET closes_at = NULL
          WHERE id = ? AND event_id = ?`,
      )
        .bind(id, viewer.eventId)
        .run();
      await expect(
        service.reviseSubmitted(slug, applicant, payload, crypto.randomUUID()),
      ).rejects.toBeInstanceOf(SubmissionRevisionConflictError);
    });

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
  });
});

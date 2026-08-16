import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
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
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Initial review', 'active', ?)`,
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
      await expect(
        service.getAdminSubmission(viewer, firstId),
      ).resolves.toMatchObject({
        hasEvaluationPlan: true,
        routingExplanation: {
          source: {
            kind: "published_form",
            formName: expect.stringMatching(/^Test form /),
            versionNumber: 1,
          },
          routes: [
            {
              trackId: "demo-track-ai",
              trackName: "AI & Innovation",
              teamId,
              teamName,
            },
          ],
          routedTeams: [{ id: teamId, name: teamName }],
        },
      });
      await env.DB.prepare(
        `UPDATE evaluation_plans SET status = 'archived'
          WHERE event_id = ? AND status <> 'archived'`,
      )
        .bind(viewer.eventId)
        .run();
      await expect(
        service.getAdminSubmission(viewer, firstId),
      ).resolves.toMatchObject({ hasEvaluationPlan: false });
      expect(routed?.routingState).toBe("automatic");

      const exceptionId = await service.createDraft(slug, applicant);
      const exceptionDraft = (
        await service.repository.getApplicantDrafts(id, applicant)
      ).find((draft) => draft.id === exceptionId)!;
      await service.submitDraft(slug, applicant, {
        submissionId: exceptionId,
        revision: exceptionDraft.revision,
        answers: { ...validAnswers, category: ["Event Operations"] },
        speakers: [{ name: applicant.name, email: applicant.email }],
      });
      const routingExceptions = await service.listAdminSubmissions(viewer, {
        routing: "missing_automatic",
      });
      expect(routingExceptions.map((submission) => submission.id)).toContain(
        exceptionId,
      );
      expect(
        routingExceptions.every(
          (submission) => submission.routingState === "missing_automatic",
        ),
      ).toBe(true);
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
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Initial review', 'active', ?)`,
        ).bind(roundId, viewer.eventId, planId, roundId),
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
        routingExplanation: {
          source: {
            kind: "published_form",
            formName: expect.stringMatching(/^Test form /),
            versionNumber: 1,
          },
          routes: [
            {
              trackId: "demo-track-ai",
              trackName: "AI & Innovation",
              teamId: aiTeamId,
              teamName: "AI reviewers",
            },
            {
              trackId: "demo-track-operations",
              trackName: "Event Operations",
              teamId: operationsTeamId,
              teamName: "Operations reviewers",
            },
          ],
        },
      });
      await testEnv.DB.prepare(
        `DELETE FROM submission_routing_teams
          WHERE submission_id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.listAdminSubmissions(viewer, { status: "submitted" }),
      ).rejects.toThrow(/persisted routed teams that do not match/i);
      await expect(
        service.getAdminSubmission(viewer, submissionId),
      ).rejects.toThrow(/persisted routed teams that do not match/i);
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
      const submitterPersonId = `manual-race-submitter-${token}`;
      const speakerPersonId = `manual-race-speaker-${token}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status
           ) VALUES (?, ?, 'Manual race submitter', 1, 'draft')`,
        ).bind(submitterPersonId, submitterEmail),
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status
           ) VALUES (?, ?, 'Manual race speaker', 1, 'draft')`,
        ).bind(speakerPersonId, speakerEmail),
        testEnv.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             accepted_at, created_at
           ) VALUES (?, ?, ?, ?, 'submitter', unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          `manual-race-submitter-membership-${token}`,
          viewer.organisationId,
          viewer.eventId,
          submitterPersonId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             accepted_at, created_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          `manual-race-speaker-membership-${token}`,
          viewer.organisationId,
          viewer.eventId,
          speakerPersonId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
           VALUES (?, ?, 'Manual race review', 'active')`,
        ).bind(planId, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO evaluation_rounds (
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Manual race round', 'active', ?)`,
        ).bind(roundId, viewer.eventId, planId, roundId),
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
      ).resolves.toEqual({ submissionCount: 0, personCount: 2 });

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
});

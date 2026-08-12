import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ensureDemoEvaluationData } from "./demo.server";
import { processCommunicationSend } from "../../../workers/queue/communication-send";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const committeeChair: Viewer = {
  ...admin,
  personId: admin.personId,
  name: "Casey Chair",
  email: "casey.chair@example.com",
  role: "committee_chair",
};

function evaluationEnvironment(base = env as unknown as CloudflareEnvironment) {
  return {
    ...base,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
}

async function invitationTokenIdentifier(snapshotJson: string) {
  const body = JSON.parse(snapshotJson).content.body as string;
  const token = new URL(
    body.match(/https?:\/\/\S+/u)?.[0] ?? "",
  ).searchParams.get("token");
  if (!token) throw new Error("The invitation snapshot is missing its token.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

const criteria = [
  {
    id: "eval-test-relevance",
    name: "Relevance",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 0,
  },
  {
    id: "eval-test-originality",
    name: "Originality",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 1,
  },
  {
    id: "eval-test-quality",
    name: "Quality",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 2,
  },
  {
    id: "eval-test-practical",
    name: "Practical",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 3,
  },
  {
    id: "eval-test-expertise",
    name: "Expertise",
    description: "",
    inputType: "scale_5",
    weightPercent: 10,
    required: true,
    position: 4,
  },
] as const;

function submittedSnapshot(
  answers: Record<string, string | string[]> = {},
  formVersionId = "eval-test-form-v1",
  coreReviewVisibility?: "reviewers" | "administrators_only",
) {
  return JSON.stringify({
    formVersionId,
    versionNumber: 1,
    schema: {
      introduction: "",
      fields: [
        {
          id: "title",
          label: "Title",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          condition: null,
        },
        {
          id: "category",
          label: "Category",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          condition: null,
        },
        {
          id: "format",
          label: "Format",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          condition: null,
        },
        {
          id: "description",
          label: "Description",
          type: "long_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: "reviewers",
          condition: null,
        },
        {
          id: "biography",
          label: "Speaker biography",
          type: "long_text",
          required: false,
          help: "",
          options: [],
          reviewVisibility: "administrators_only",
          condition: null,
        },
      ],
    },
    answers: {
      title: "A practical event proposal",
      category: "Operations",
      format: "Presentation",
      ...answers,
    },
    speakers: [{ name: "Alex Morgan", email: "alex.submitter@example.com" }],
  });
}

function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
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

async function resetEvaluationFixture() {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM submissions WHERE id = 'eval-multi-round-not-advanced'",
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE event_id = ? AND source_submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare(
      "DELETE FROM submission_decisions WHERE event_id = ? AND submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare("DELETE FROM evaluation_teams WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE submissions SET status = 'submitted', title = 'A practical event proposal',
              form_version_id = 'eval-test-form-v1', category = 'Operations',
              format = 'Presentation', answers_json = ?,
              submitted_snapshot_json = ?, last_operation_id = NULL,
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = 'eval-test-submission' AND event_id = ?`,
    ).bind(
      JSON.stringify({
        abstract: "A clear, useful proposal.",
        description: "A practical description for the public programme.",
        biography: "Alex Morgan is the identifying speaker biography.",
      }),
      submittedSnapshot({
        abstract: "A clear, useful proposal.",
        description: "A practical description for the public programme.",
        biography: "Alex Morgan is the identifying speaker biography.",
      }),
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE memberships SET revoked_at = NULL, accepted_at = COALESCE(accepted_at, unixepoch())
        WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
    ).bind(admin.eventId, evaluator.personId),
  ]);
}

describe("evaluation vertical slice", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_definitions (id, event_id, name, kind, status, public_slug, min_speakers, max_speakers, access_mode, revision, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form', ?, 'Evaluation fixture', 'submission', 'published', 'eval-test-form', 1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_versions (id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json, status, revision, published_at, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form-v1', ?, 'eval-test-form', 1, '[]', '{"categories":{},"trackIds":{"Operations":"demo-track-operations"},"trackNames":{"demo-track-operations":"Operations"},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":null}', '{}', 'published', 1, unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submissions (id, event_id, form_version_id, submitter_person_id, submitter_email, public_reference, title, category, format, status, answers_json, submitted_snapshot_json, revision, submitted_at, created_at, updated_at) VALUES ('eval-test-submission', ?, 'eval-test-form-v1', 'person-demo-submitter', 'alex.submitter@example.com', 'SUB-EVAL-1', 'A practical event proposal', 'Operations', 'Presentation', 'submitted', ?, ?, 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        JSON.stringify({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
        submittedSnapshot({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_speakers (id, event_id, submission_id, person_id, email, display_name, position, invitation_status, is_primary, claimed_at, created_at, updated_at) VALUES ('eval-test-speaker', ?, 'eval-test-submission', 'person-demo-submitter', 'alex.submitter@example.com', 'Alex Morgan', 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           ) VALUES ('eval-test-submission', ?, 'demo-track-operations', 'Operations', 0)`,
      ).bind(admin.eventId),
    ]);
  });

  describe("configuration and access workflows", () => {
    it("administers teams and expands a team assignment to its active members", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const teamId = await service.saveTeam(admin, {
        name: "Operations committee",
        description: "Reviews programme operations proposals.",
        chairPersonId: null,
        status: "active",
      });
      await service.changeTeamMember(admin, {
        teamId,
        personId: evaluator.personId,
        role: "evaluator",
        operation: "add",
      });
      await service.savePlan(admin, {
        revision: 0,
        name: "Team assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-team-round",
            name: "Committee review",
            anonymous: false,
            criteria,
          },
        ],
      });
      const assigned = await service.assign(admin, {
        roundId: "eval-team-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [],
        teamId,
      });
      expect(assigned).toMatchObject({
        createdAssignmentCount: 1,
        requestedAssignmentCount: 1,
        undoOperationId: expect.any(String),
        undoExpiresAt: expect.any(Number),
      });
      const repeated = await service.assign(admin, {
        roundId: "eval-team-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [],
        teamId,
      });
      expect(repeated).toMatchObject({
        createdAssignmentCount: 0,
        requestedAssignmentCount: 1,
        undoOperationId: null,
        undoExpiresAt: null,
      });

      const workspace = await service.getAdminWorkspace(admin);
      expect(workspace.teams).toContainEqual(
        expect.objectContaining({
          id: teamId,
          name: "Operations committee",
          memberCount: 1,
          members: [expect.objectContaining({ personId: evaluator.personId })],
        }),
      );
      expect(workspace.assignments).toContainEqual(
        expect.objectContaining({
          roundId: "eval-team-round",
          submissionId: "eval-test-submission",
          evaluatorPersonId: evaluator.personId,
          teamId,
        }),
      );
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE event_id = ? AND action = 'evaluation.assignments.created'
              AND json_extract(metadata_json, '$.teamId') = ?`,
        )
          .bind(admin.eventId, teamId)
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });

      await env.DB.prepare(
        `UPDATE memberships SET revoked_at = unixepoch()
          WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
      )
        .bind(admin.eventId, evaluator.personId)
        .run();
      await service.changeTeamMember(admin, {
        teamId,
        personId: evaluator.personId,
        role: "evaluator",
        operation: "remove",
      });
      const afterRemoval = await service.getAdminWorkspace(admin);
      expect(
        afterRemoval.teams.find((team) => team.id === teamId)?.members,
      ).toEqual([]);
      expect(
        afterRemoval.assignments.find(
          (assignment) => assignment.submissionId === "eval-test-submission",
        )?.teamId,
      ).toBe(teamId);
    });
  });

  describe("configuration and access workflows", () => {
    it("keeps the team's named chair and active chair membership in sync", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, accepted_at, created_at
        ) VALUES (
          'eval-test-chair-membership', ?, ?, ?, 'committee_chair',
          unixepoch(), unixepoch(), unixepoch()
        )
      `,
      )
        .bind(admin.organisationId, admin.eventId, admin.personId)
        .run();
      try {
        const service = new EvaluationService(
          env as unknown as CloudflareEnvironment,
        );
        const teamId = await service.saveTeam(admin, {
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: admin.personId,
          status: "active",
        });
        expect(
          await env.DB.prepare(
            `
            SELECT t.chair_person_id AS chairPersonId, tm.role
              FROM evaluation_teams t
              JOIN evaluation_team_members tm
                ON tm.team_id = t.id AND tm.event_id = t.event_id
             WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
               AND tm.removed_at IS NULL
          `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: admin.personId, role: "chair" });

        await service.changeTeamMember(admin, {
          teamId,
          personId: admin.personId,
          role: "evaluator",
          operation: "add",
        });
        expect(
          await env.DB.prepare(
            `
            SELECT t.chair_person_id AS chairPersonId, tm.role
              FROM evaluation_teams t
              JOIN evaluation_team_members tm
                ON tm.team_id = t.id AND tm.event_id = t.event_id
             WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
               AND tm.removed_at IS NULL
          `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: null, role: "evaluator" });

        await service.saveTeam(admin, {
          teamId,
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: admin.personId,
          status: "active",
        });

        await service.saveTeam(admin, {
          teamId,
          name: "Named chair committee",
          description: "Tests the single chair invariant.",
          chairPersonId: null,
          status: "active",
        });
        expect(
          await env.DB.prepare(
            `
            SELECT t.chair_person_id AS chairPersonId, tm.role
              FROM evaluation_teams t
              JOIN evaluation_team_members tm
                ON tm.team_id = t.id AND tm.event_id = t.event_id
             WHERE t.id = ? AND t.event_id = ? AND tm.person_id = ?
               AND tm.removed_at IS NULL
          `,
          )
            .bind(teamId, admin.eventId, admin.personId)
            .first(),
        ).toEqual({ chairPersonId: null, role: "evaluator" });
      } finally {
        await env.DB.prepare(
          "DELETE FROM memberships WHERE id = 'eval-test-chair-membership'",
        ).run();
      }
    });

    it("creates expiring evaluator invitations and activates team eligibility only after acceptance", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const teamId = await service.saveTeam(admin, {
        name: "Invited evaluators",
        description: "Invitation onboarding coverage.",
        chairPersonId: null,
        status: "active",
      });
      try {
        const invited = await service.inviteEvaluationMember(admin, {
          name: "Taylor Reviewer",
          email: "taylor.reviewer@example.com",
          role: "evaluator",
          teamId,
        });
        expect(invited.delivery).toBe("demo_not_sent");
        const membership = await env.DB.prepare(
          `
          SELECT m.id, m.accepted_at AS acceptedAt,
                 m.invitation_expires_at AS expiresAt,
                 (SELECT COUNT(*) FROM audit_events audit
                   WHERE audit.entity_id = m.id
                     AND audit.action = 'membership.evaluator.invited') AS inviteAuditCount
            FROM memberships m
            JOIN people p ON p.id = m.person_id
           WHERE m.event_id = ? AND m.role = 'evaluator' AND p.email = ?
        `,
        )
          .bind(admin.eventId, "taylor.reviewer@example.com")
          .first<{
            id: string;
            acceptedAt: number | null;
            expiresAt: number;
            inviteAuditCount: number;
          }>();
        expect(membership).toMatchObject({
          id: invited.membershipId,
          acceptedAt: null,
          inviteAuditCount: 1,
        });
        expect(membership!.expiresAt).toBeGreaterThan(
          Math.floor(Date.now() / 1_000),
        );
        const workspace = await service.getAdminWorkspace(admin);
        expect(workspace.evaluationInvitations).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            email: "taylor.reviewer@example.com",
            status: "pending",
          }),
        );
        expect(
          workspace.teams.find((team) => team.id === teamId),
        ).toMatchObject({
          eligibleMemberCount: 0,
          members: [
            expect.objectContaining({
              email: "taylor.reviewer@example.com",
              authorised: false,
            }),
          ],
        });

        await env.DB.prepare(
          "UPDATE memberships SET invitation_expires_at = unixepoch() - 1 WHERE id = ?",
        )
          .bind(invited.membershipId)
          .run();
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            status: "expired",
          }),
        );

        const resent = await service.inviteEvaluationMember(admin, {
          name: "Taylor Reviewer",
          email: "taylor.reviewer@example.com",
          role: "evaluator",
          teamId,
        });
        expect(resent.membershipId).toBe(invited.membershipId);
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invited.membershipId,
            status: "pending",
          }),
        );
        expect(
          await env.DB.prepare(
            `
            SELECT COUNT(*) AS count FROM memberships m
            JOIN people p ON p.id = m.person_id
             WHERE m.event_id = ? AND m.role = 'evaluator' AND p.email = ?
          `,
          )
            .bind(admin.eventId, "taylor.reviewer@example.com")
            .first<{ count: number }>(),
        ).toEqual({ count: 1 });
        await env.DB.prepare(
          `UPDATE memberships SET accepted_at = unixepoch()
            WHERE id = ? AND accepted_at IS NULL`,
        )
          .bind(invited.membershipId)
          .run();
        const acceptedWorkspace = await service.getAdminWorkspace(admin);
        expect(acceptedWorkspace.evaluationInvitations).toEqual([]);
        expect(
          acceptedWorkspace.teams.find((team) => team.id === teamId),
        ).toMatchObject({ eligibleMemberCount: 1 });
        expect(acceptedWorkspace.evaluators).toContainEqual(
          expect.objectContaining({ email: "taylor.reviewer@example.com" }),
        );
        await expect(
          service.inviteEvaluationMember(admin, {
            name: "Taylor Reviewer",
            email: "taylor.reviewer@example.com",
            role: "evaluator",
            teamId,
          }),
        ).rejects.toThrow(/already has active evaluator access/i);
      } finally {
        await env.DB.prepare(
          "DELETE FROM people WHERE email = 'taylor.reviewer@example.com'",
        ).run();
      }
    });

    it("activates only the exact SBEK reviewer after the explicit demo invitation", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-sbek-reviewer'
            AND role = 'evaluator'`,
      )
        .bind(admin.eventId)
        .run();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const invited = await service.inviteEvaluationMember(admin, {
        name: "Sam Whitfield",
        email: "sbek-reviewer@example.com",
        role: "evaluator",
        teamId: null,
      });

      expect(invited).toMatchObject({
        delivery: "demo_not_sent",
        demoAccessActivation: "activated",
      });
      expect(
        await env.DB.prepare(
          `SELECT accepted_at IS NOT NULL AS accepted,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = membership.id
                      AND audit.action = 'membership.demo_fixture_activated') AS activationAuditCount
             FROM memberships membership
            WHERE membership.id = ?`,
        )
          .bind(invited.membershipId)
          .first(),
      ).toEqual({ accepted: 1, activationAuditCount: 1 });
    });

    it("invites, promotes and revokes committee chairs with administrator-only authority", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const inviteEmail = "invited.committee.chair@example.com";
      try {
        const invitation = await service.inviteEvaluationMember(admin, {
          name: "Invited Committee Chair",
          email: inviteEmail,
          role: "committee_chair",
          teamId: null,
        });
        expect(invitation.delivery).toBe("demo_not_sent");
        expect(
          (await service.getAdminWorkspace(admin)).evaluationInvitations,
        ).toContainEqual(
          expect.objectContaining({
            id: invitation.membershipId,
            email: inviteEmail,
            role: "committee_chair",
            status: "pending",
          }),
        );
        await expect(
          service.inviteEvaluationMember(admin, {
            name: "Invalid team chair invitation",
            email: "invalid.team.chair@example.com",
            role: "committee_chair",
            teamId: "any-team",
          }),
        ).rejects.toThrow(/assign them to a team after acceptance/i);
        await expect(
          service.inviteEvaluationMember(committeeChair, {
            name: "Unauthorised Chair",
            email: "unauthorised.chair@example.com",
            role: "committee_chair",
            teamId: null,
          }),
        ).rejects.toMatchObject({ status: 403 });

        const promoted = await service.changeCommitteeChairAccess(admin, {
          personId: evaluator.personId,
          operation: "promote",
          confirmed: true,
        });
        expect(
          (await service.getAdminWorkspace(admin)).evaluators,
        ).toContainEqual(
          expect.objectContaining({
            id: evaluator.personId,
            role: "committee_chair",
            chairMembershipId: promoted.membershipId,
          }),
        );
        const teamId = await service.saveTeam(admin, {
          name: "Chair lifecycle team",
          description: "Role lifecycle coverage.",
          chairPersonId: evaluator.personId,
          status: "active",
        });
        const revoked = await service.changeCommitteeChairAccess(admin, {
          personId: evaluator.personId,
          operation: "revoke",
          confirmed: true,
        });
        expect(revoked.membershipId).toBe(promoted.membershipId);
        expect(
          await env.DB.prepare(
            `SELECT revoked_at IS NOT NULL AS revoked
               FROM memberships WHERE id = ?`,
          )
            .bind(promoted.membershipId)
            .first(),
        ).toEqual({ revoked: 1 });
        expect(
          await env.DB.prepare(
            "SELECT chair_person_id AS chairPersonId FROM evaluation_teams WHERE id = ?",
          )
            .bind(teamId)
            .first(),
        ).toEqual({ chairPersonId: null });
        expect(
          await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM audit_events
              WHERE event_id = ? AND entity_id = ?
                AND action IN (
                  'membership.committee_chair.promoted',
                  'membership.committee_chair.revoked'
                )`,
          )
            .bind(admin.eventId, promoted.membershipId)
            .first(),
        ).toEqual({ count: 2 });
        await expect(
          service.changeCommitteeChairAccess(committeeChair, {
            personId: evaluator.personId,
            operation: "promote",
            confirmed: true,
          }),
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await env.DB.prepare("DELETE FROM people WHERE email IN (?, ?, ?)")
          .bind(
            inviteEmail,
            "invalid.team.chair@example.com",
            "unauthorised.chair@example.com",
          )
          .run();
      }
    });

    it("enforces evaluation-manager authority in the service layer", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await expect(
        service.saveTeam(evaluator, {
          name: "Unauthorised team",
          description: "",
          chairPersonId: null,
          status: "active",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.inviteEvaluationMember(evaluator, {
          name: "Unauthorised evaluator",
          email: "unauthorised.evaluator@example.com",
          role: "evaluator",
          teamId: null,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});

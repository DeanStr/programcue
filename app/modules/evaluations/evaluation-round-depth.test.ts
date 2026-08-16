import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  encodeScorecardSelection,
  parseScorecardSelection,
} from "./evaluation-scorecard-selection";
import { EvaluationService } from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const sam: Viewer = {
  personId: "person-sbek-reviewer",
  name: "Sam Whitfield",
  email: "sbek-reviewer@example.com",
  role: "evaluator",
  organisationId: admin.organisationId,
  eventId: admin.eventId,
  demo: true,
};

const submissionId = "abstract-depth-submission";
const formId = "abstract-depth-form";
const formVersionId = "abstract-depth-form-v1";

it("round-trips scorecard selector values without treating pipe characters as delimiters", () => {
  const encoded = encodeScorecardSelection("vendor|abstract|rubric", 3);
  expect(parseScorecardSelection(encoded)).toEqual({
    scorecardId: "vendor|abstract|rubric",
    scorecardVersion: 3,
  });
});

const formSchema = {
  introduction: "",
  fields: [
    {
      id: "title",
      label: "Session title",
      type: "short_text",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      id: "category",
      label: "Category",
      type: "select",
      required: true,
      help: "",
      example: "",
      options: ["Operations"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      help: "",
      example: "",
      options: ["Presentation"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      id: "session_overview",
      label: "Session overview",
      type: "long_text",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      id: "participant_name",
      label: "Participant name",
      type: "short_text",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "identity",
      condition: null,
    },
    {
      id: "co_speakers",
      label: "Co-speakers",
      type: "short_text",
      required: false,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "identity",
      condition: null,
    },
    {
      id: "contact_email",
      label: "Contact email",
      type: "short_text",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "identity",
      condition: null,
    },
    {
      id: "company",
      label: "Company",
      type: "short_text",
      required: false,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "identity",
      condition: null,
    },
    {
      id: "employer",
      label: "Employer",
      type: "short_text",
      required: false,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      type: "url",
      required: false,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "biography",
      label: "Biography",
      type: "long_text",
      required: false,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "administrators_only",
      condition: null,
    },
  ],
};

const routingSnapshot = JSON.stringify({
  categories: {},
  trackIds: { Operations: "demo-track-operations" },
  trackNames: { "demo-track-operations": "Operations" },
  teamNames: {},
  directSessionDurationMinutes: null,
  passwordHash: null,
});

function submittedSnapshot() {
  return {
    formVersionId,
    versionNumber: 1,
    schema: formSchema,
    answers: {
      title: "Taming the event data beast",
      category: "Operations",
      format: "Presentation",
      session_overview: "A useful review proposal.",
      participant_name: "Priya Raman",
      co_speakers: "Marcus Okafor",
      contact_email: "priya.raman@example.com",
      company: "Latticework Systems",
      employer: "Latticework Systems",
      linkedin: "https://linkedin.example/priya-raman",
      biography: "Priya leads a thoughtful event data practice.",
    },
    speakers: [
      { name: "Priya Raman", email: "priya.raman@example.com" },
      { name: "Marcus Okafor", email: "marcus.okafor@example.com" },
    ],
    uploads: {},
  };
}

const criteria = [
  {
    id: "abstract-originality",
    name: "Originality",
    description: "Distinctive perspective.",
    inputType: "scale_5" as const,
    options: [],
    weightPercent: 50,
    required: true,
    position: 0,
  },
  {
    id: "abstract-relevance",
    name: "Relevance",
    description: "Fit for the programme.",
    inputType: "scale_5" as const,
    options: [],
    weightPercent: 50,
    required: true,
    position: 1,
  },
  {
    id: "abstract-recommendation",
    name: "Recommendation",
    description: "Choose the review recommendation.",
    inputType: "dropdown" as const,
    options: ["Accept", "Maybe", "Reject"],
    weightPercent: 0,
    required: true,
    position: 2,
  },
  {
    id: "abstract-comments",
    name: "Comments",
    description: "Long-form reviewer context.",
    inputType: "free_text" as const,
    options: [],
    weightPercent: 0,
    required: false,
    position: 3,
  },
];

async function addSamToMembership() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memberships
       (id, organisation_id, event_id, person_id, role, accepted_at, invited_at, created_at)
     VALUES (?, ?, ?, ?, 'evaluator', unixepoch(), unixepoch(), unixepoch())`,
  )
    .bind(
      "abstract-depth-sam-membership",
      admin.organisationId,
      admin.eventId,
      sam.personId,
    )
    .run();
}

async function addSubmission() {
  const snapshot = JSON.stringify(submittedSnapshot());
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO form_definitions
         (id, event_id, name, kind, status, public_slug, min_speakers,
          max_speakers, access_mode, revision, created_by_person_id, created_at, updated_at)
       VALUES (?, ?, 'Abstract depth fixture', 'submission', 'published',
               ?, 1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())`,
    ).bind(formId, admin.eventId, formId, admin.personId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO form_versions
         (id, event_id, form_id, version_number, schema_json, routing_json,
          settings_snapshot_json, status, revision, published_at, created_by_person_id,
          created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, '{}', 'published', 1, unixepoch(), ?, unixepoch(), unixepoch())`,
    ).bind(
      formVersionId,
      admin.eventId,
      formId,
      JSON.stringify(formSchema),
      routingSnapshot,
      admin.personId,
    ),
    env.DB.prepare(
      `INSERT INTO submissions
         (id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ABSTRACT-DEPTH-001', ?, 'Operations', 'Presentation',
               'submitted', ?, ?, 1, unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      submissionId,
      admin.eventId,
      formVersionId,
      "person-sbek-speaker",
      "priya.raman@example.com",
      "Taming the event data beast",
      JSON.stringify(submittedSnapshot().answers),
      snapshot,
    ),
    env.DB.prepare(
      `INSERT INTO submission_speakers
         (id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'person-sbek-speaker', ?, 'Priya Raman', 0, 'claimed', 1,
               unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      "abstract-depth-speaker-priya",
      admin.eventId,
      submissionId,
      "priya.raman@example.com",
    ),
    env.DB.prepare(
      `INSERT INTO submission_speakers
         (id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'person-sbek-speaker2', ?, 'Marcus Okafor', 1, 'claimed', 0,
               unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      "abstract-depth-speaker-marcus",
      admin.eventId,
      submissionId,
      "marcus.okafor@example.com",
    ),
    env.DB.prepare(
      `INSERT INTO submission_track_selections
         (submission_id, event_id, track_id, track_name_snapshot, position)
       VALUES (?, ?, 'demo-track-operations', 'Operations', 0)`,
    ).bind(submissionId, admin.eventId),
  ]);
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare(
      "DELETE FROM submissions WHERE id = ? AND event_id = ?",
    ).bind(submissionId, admin.eventId),
    env.DB.prepare(
      "DELETE FROM form_versions WHERE id = ? AND event_id = ?",
    ).bind(formVersionId, admin.eventId),
    env.DB.prepare(
      "DELETE FROM form_definitions WHERE id = ? AND event_id = ?",
    ).bind(formId, admin.eventId),
  ]);
  await addSamToMembership();
  await addSubmission();
});

function planInput() {
  return {
    revision: 0,
    name: "Abstract review plan",
    status: "active" as const,
    rounds: [
      {
        id: "abstract-initial-round",
        name: "Initial Review",
        opensAt: "2020-08-01T09:00:00.000Z",
        closesAt: "2099-10-15T17:00:00.000Z",
        anonymous: true,
        scorecardId: "scorecard-initial-v2",
        scorecardVersion: 2,
        criteria,
      },
      {
        id: "abstract-final-round",
        name: "Final Review",
        opensAt: "2099-10-16T09:00:00.000Z",
        closesAt: "2099-11-30T17:00:00.000Z",
        anonymous: false,
        scorecardId: "scorecard-final-v4",
        scorecardVersion: 4,
        criteria: criteria.map((criterion) => ({
          ...criterion,
          id: `${criterion.id}-final`,
          name: `Final ${criterion.name}`,
        })),
      },
    ],
  };
}

describe("abstract management round depth", () => {
  it("persists independent round dates, scorecards, pools and dropdown options", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const planId = await service.savePlan(admin, planInput());
    const initialPool = await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    expect(initialPool).toMatchObject({ cancelledAssignmentCount: 0 });

    const workspace = await service.getAdminWorkspace(admin);
    expect(workspace.plan?.id).toBe(planId);
    expect(workspace.plan?.rounds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "abstract-initial-round",
          name: "Initial Review",
          opensAt: expect.any(Number),
          closesAt: expect.any(Number),
          anonymous: true,
          scorecardId: "scorecard-initial-v2",
          scorecardVersion: 2,
          reviewers: [
            expect.objectContaining({
              personId: sam.personId,
              name: "Sam Whitfield",
            }),
          ],
        }),
        expect.objectContaining({
          id: "abstract-final-round",
          name: "Final Review",
          anonymous: false,
          scorecardId: "scorecard-final-v4",
          scorecardVersion: 4,
          reviewers: [],
        }),
      ]),
    );
    const initial = workspace.plan!.rounds.find(
      (round) => round.id === "abstract-initial-round",
    )!;
    expect(
      initial.criteria.find((criterion) => criterion.inputType === "dropdown"),
    ).toMatchObject({
      name: "Recommendation",
      options: ["Accept", "Maybe", "Reject"],
    });
  });

  it("assigns and advances only the pooled members of a partially scoped team", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    const teamId = await service.saveTeam(admin, {
      name: "Partially scoped review team",
      description: "Only one member is in this round's pool.",
      chairPersonId: null,
      status: "active",
    });
    try {
      await service.changeTeamMember(admin, {
        teamId,
        personId: sam.personId,
        role: "evaluator",
        operation: "add",
      });
      await service.changeTeamMember(admin, {
        teamId,
        personId: "person-demo-evaluator",
        role: "evaluator",
        operation: "add",
      });
      await service.changeRoundReviewerPool(admin, {
        roundId: "abstract-initial-round",
        personId: sam.personId,
        operation: "add",
      });
      await service.changeRoundReviewerPool(admin, {
        roundId: "abstract-final-round",
        personId: sam.personId,
        operation: "add",
      });

      await expect(
        service.assign(admin, {
          roundId: "abstract-initial-round",
          targetType: "submission",
          targetIds: [submissionId],
          evaluatorPersonIds: [],
          teamId,
        }),
      ).resolves.toMatchObject({
        createdAssignmentCount: 1,
        requestedAssignmentCount: 1,
      });

      const assignment = await env.DB.prepare(
        `SELECT id FROM evaluator_assignments
          WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
      )
        .bind(admin.eventId, "abstract-initial-round", sam.personId)
        .first<{ id: string }>();
      const workspace = await service.getReviewerWorkspace(sam, assignment!.id);
      await service.saveReview(
        sam,
        {
          assignmentId: assignment!.id,
          revision: workspace.review?.revision ?? 0,
          scores: Object.fromEntries(
            workspace.criteria.map((criterion) => [
              criterion.id,
              criterion.inputType === "dropdown"
                ? "Accept"
                : criterion.inputType === "free_text"
                  ? "Strong proposal."
                  : 5,
            ]),
          ),
          recommendation: "accept",
          confidence: 5,
          submitterFeedback: "Advance this proposal.",
          privateNotes: "Partially scoped team pool.",
          conflictAffirmed: true,
          intent: "submit",
        },
        "participant_ui",
      );

      await expect(
        service.advanceRound(
          {
            kind: "api_key",
            organisationId: admin.organisationId,
            eventId: admin.eventId,
            personId: null,
            actorId: "api_key:partial-team-advance",
          },
          {
            fromRoundId: "abstract-initial-round",
            fromRoundRevision: 1,
            toRoundId: "abstract-final-round",
            toRoundRevision: 1,
            submissionIds: [submissionId],
            evaluatorPersonIds: [],
            teamId,
            confirmed: true,
          },
          {
            idempotencyKey: "partial-team-advance-key",
            requestHash: "partial-team-advance-hash",
          },
        ),
      ).resolves.toMatchObject({
        advancedSubmissionCount: 1,
        assignmentCount: 1,
      });

      await expect(
        env.DB.prepare(
          `SELECT evaluator_person_id AS evaluatorPersonId, status
             FROM evaluator_assignments
            WHERE event_id = ? AND round_id = ?`,
        )
          .bind(admin.eventId, "abstract-final-round")
          .all(),
      ).resolves.toEqual({
        results: [{ evaluatorPersonId: sam.personId, status: "assigned" }],
        success: true,
        meta: expect.anything(),
      });
    } finally {
      await env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?")
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        "DELETE FROM evaluation_teams WHERE id = ? AND event_id = ?",
      )
        .bind(teamId, admin.eventId)
        .run();
    }
  });

  it("preserves round pools when an unassigned plan is replaced", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    const loaded = await service.getAdminWorkspace(admin);
    const replacement = planInput();
    replacement.revision = loaded.plan!.revision;

    await service.savePlan(admin, replacement);

    const reloaded = await service.getAdminWorkspace(admin);
    expect(
      reloaded.plan!.rounds.find(
        (round) => round.id === "abstract-initial-round",
      )!.reviewers,
    ).toEqual([
      expect.objectContaining({
        personId: sam.personId,
        name: "Sam Whitfield",
      }),
    ]);
  });

  it("rejects invalid date ranges before persisting a round", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.savePlan(admin, {
        ...planInput(),
        rounds: [
          {
            ...planInput().rounds[0],
            closesAt: "2020-07-31T09:00:00.000Z",
          },
        ],
      }),
    ).rejects.toThrow(/close date must be after/i);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM evaluation_plans WHERE event_id = ? AND name = ?",
      )
        .bind(admin.eventId, "Abstract review plan")
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("edits an active unassigned round without replacing stable criterion identifiers", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    const workspace = await service.getAdminWorkspace(admin);
    const activeRound = workspace.plan!.rounds.find(
      (round) => round.id === "abstract-initial-round",
    )!;

    await service.updateDraftRound(admin, {
      roundId: activeRound.id,
      revision: activeRound.revision,
      name: "Initial abstract review",
      opensAt: new Date(activeRound.opensAt! * 1_000).toISOString(),
      closesAt: new Date(activeRound.closesAt! * 1_000).toISOString(),
      anonymous: activeRound.anonymous,
      scorecardId: activeRound.scorecardId,
      scorecardVersion: activeRound.scorecardVersion,
      dueAt: null,
      criteria: activeRound.criteria,
    });

    const reloaded = await service.getAdminWorkspace(admin);
    const editedRound = reloaded.plan!.rounds.find(
      (round) => round.id === activeRound.id,
    )!;
    expect(editedRound).toMatchObject({
      name: "Initial abstract review",
      status: "active",
      revision: activeRound.revision + 1,
    });
    expect(editedRound.criteria.map((criterion) => criterion.id)).toEqual(
      activeRound.criteria.map((criterion) => criterion.id),
    );

    await env.DB.prepare(
      `INSERT INTO ai_review_assessments (
         id, event_id, round_id, submission_id, scorecard_id,
         scorecard_version, round_revision, score, rationale, provider,
         model, provider_response_id, generated_by_person_id,
         last_operation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 4,
                 'A sufficiently detailed persisted AI assessment rationale for this test.',
                 'workers_ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', ?, ?, ?)`,
    )
      .bind(
        "abstract-round-edit-ai-assessment",
        admin.eventId,
        editedRound.id,
        submissionId,
        editedRound.scorecardId,
        editedRound.scorecardVersion,
        editedRound.revision,
        "abstract-round-edit-ai-response",
        admin.personId,
        "abstract-round-edit-ai-operation",
      )
      .run();
    await expect(
      service.updateDraftRound(admin, {
        roundId: editedRound.id,
        revision: editedRound.revision,
        name: editedRound.name,
        dueAt: null,
        criteria: editedRound.criteria,
      }),
    ).rejects.toThrow(/AI-assessment activity|not editable/i);
    await env.DB.prepare(
      "DELETE FROM ai_review_assessments WHERE id = ? AND event_id = ?",
    )
      .bind("abstract-round-edit-ai-assessment", admin.eventId)
      .run();

    await expect(
      service.updateDraftRound(admin, {
        roundId: editedRound.id,
        revision: editedRound.revision,
        name: editedRound.name,
        dueAt: null,
        criteria: editedRound.criteria.map((criterion, index) => ({
          ...criterion,
          id: `replacement-id-${index}`,
        })),
      }),
    ).rejects.toThrow(/identifiers must be preserved/i);

    await service.changeRoundReviewerPool(admin, {
      roundId: editedRound.id,
      personId: sam.personId,
      operation: "add",
    });
    await service.assign(admin, {
      roundId: editedRound.id,
      targetType: "submission",
      targetIds: [submissionId],
      evaluatorPersonIds: [sam.personId],
    });
    await expect(
      service.updateDraftRound(admin, {
        roundId: editedRound.id,
        revision: editedRound.revision,
        name: "Should not save",
        dueAt: null,
        criteria: editedRound.criteria,
      }),
    ).rejects.toThrow(/without assignments|not editable/i);
  });

  it("rejects case-insensitive duplicate names across plan, add and edit paths", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const duplicatePlan = planInput();
    duplicatePlan.rounds[1]!.name = " initial review ";
    await expect(service.savePlan(admin, duplicatePlan)).rejects.toThrow(
      /round names must be unique/i,
    );

    const planId = await service.savePlan(admin, planInput());
    let workspace = await service.getAdminWorkspace(admin);
    await expect(
      service.addNextRound(admin, {
        planId,
        planRevision: workspace.plan!.revision,
        name: " final review ",
        dueAt: null,
        cloneRoundId: "abstract-final-round",
      }),
    ).rejects.toThrow(/round with that name already exists/i);

    workspace = await service.getAdminWorkspace(admin);
    const finalRound = workspace.plan!.rounds.find(
      (round) => round.id === "abstract-final-round",
    )!;
    await expect(
      service.updateDraftRound(admin, {
        roundId: finalRound.id,
        revision: finalRound.revision,
        name: " INITIAL REVIEW ",
        dueAt: null,
        criteria: finalRound.criteria,
      }),
    ).rejects.toThrow(/round with that name already exists/i);
  });

  it("deletes only the confirmed final unassigned draft and cascades its configuration", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const planId = await service.savePlan(admin, planInput());
    let workspace = await service.getAdminWorkspace(admin);
    const addedRoundId = await service.addNextRound(admin, {
      planId,
      planRevision: workspace.plan!.revision,
      name: "Panel Review",
      dueAt: null,
      cloneRoundId: "abstract-final-round",
    });
    workspace = await service.getAdminWorkspace(admin);
    const staleAddedRound = workspace.plan!.rounds.find(
      (round) => round.id === addedRoundId,
    )!;
    await service.changeRoundReviewerPool(admin, {
      roundId: addedRoundId,
      personId: sam.personId,
      operation: "add",
    });
    await expect(
      service.deleteDraftRound(admin, {
        roundId: staleAddedRound.id,
        roundRevision: staleAddedRound.revision,
        planRevision: workspace.plan!.revision,
        expectedReviewerPersonIds: [],
        confirmed: true,
      }),
    ).rejects.toThrow(/reviewer pool changed after.*confirmed/i);
    workspace = await service.getAdminWorkspace(admin);
    const middleRound = workspace.plan!.rounds.find(
      (round) => round.id === "abstract-final-round",
    )!;
    const addedRound = workspace.plan!.rounds.find(
      (round) => round.id === addedRoundId,
    )!;

    await expect(
      service.deleteDraftRound(admin, {
        roundId: addedRound.id,
        roundRevision: addedRound.revision,
        planRevision: workspace.plan!.revision,
        expectedReviewerPersonIds: addedRound.reviewers.map(
          (reviewer) => reviewer.personId,
        ),
        confirmed: false,
      }),
    ).rejects.toThrow();
    await expect(
      service.deleteDraftRound(admin, {
        roundId: middleRound.id,
        roundRevision: middleRound.revision,
        planRevision: workspace.plan!.revision,
        expectedReviewerPersonIds: middleRound.reviewers.map(
          (reviewer) => reviewer.personId,
        ),
        confirmed: true,
      }),
    ).rejects.toThrow(/final draft round/i);

    await env.DB.prepare(
      `INSERT INTO evaluator_assignments (
         id, event_id, round_id, submission_id, evaluator_person_id,
         status, revision, assigned_at
       ) VALUES (?, ?, ?, ?, ?, 'assigned', 1, unixepoch())`,
    )
      .bind(
        "abstract-delete-guard-assignment",
        admin.eventId,
        addedRound.id,
        submissionId,
        sam.personId,
      )
      .run();
    await expect(
      service.deleteDraftRound(admin, {
        roundId: addedRound.id,
        roundRevision: addedRound.revision,
        planRevision: workspace.plan!.revision,
        expectedReviewerPersonIds: addedRound.reviewers.map(
          (reviewer) => reviewer.personId,
        ),
        confirmed: true,
      }),
    ).rejects.toThrow(/assignment.*activity/i);
    await env.DB.prepare(
      "DELETE FROM evaluator_assignments WHERE id = ? AND event_id = ?",
    )
      .bind("abstract-delete-guard-assignment", admin.eventId)
      .run();

    const result = await service.deleteDraftRound(admin, {
      roundId: addedRound.id,
      roundRevision: addedRound.revision,
      planRevision: workspace.plan!.revision,
      expectedReviewerPersonIds: addedRound.reviewers.map(
        (reviewer) => reviewer.personId,
      ),
      confirmed: true,
    });
    expect(result).toEqual({
      roundId: addedRound.id,
      planRevision: workspace.plan!.revision + 1,
    });
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM evaluation_rounds
             WHERE id = ? AND event_id = ?) AS roundCount,
           (SELECT COUNT(*) FROM evaluation_criteria
             WHERE round_id = ? AND event_id = ?) AS criterionCount,
           (SELECT COUNT(*) FROM evaluation_round_reviewers
             WHERE round_id = ? AND event_id = ?) AS reviewerCount,
           (SELECT revision FROM evaluation_plans
             WHERE id = ? AND event_id = ?) AS planRevision`,
      )
        .bind(
          addedRound.id,
          admin.eventId,
          addedRound.id,
          admin.eventId,
          addedRound.id,
          admin.eventId,
          planId,
          admin.eventId,
        )
        .first(),
    ).resolves.toEqual({
      roundCount: 0,
      criterionCount: 0,
      reviewerCount: 0,
      planRevision: workspace.plan!.revision + 1,
    });
  });

  it("binds reused scorecards to their rubric and forks edited drafts", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const planId = await service.savePlan(admin, planInput());
    const beforeAdd = await service.getAdminWorkspace(admin);
    const addedRoundId = await service.addNextRound(admin, {
      planId,
      planRevision: beforeAdd.plan!.revision,
      name: "Selected Initial Rubric",
      opensAt: "2099-12-01T09:00:00.000Z",
      closesAt: "2099-12-10T17:00:00.000Z",
      anonymous: false,
      dueAt: null,
      cloneRoundId: "abstract-final-round",
      scorecardId: "scorecard-initial-v2",
      scorecardVersion: 2,
    });
    const afterAdd = await service.getAdminWorkspace(admin);
    const addedRound = afterAdd.plan!.rounds.find(
      (round) => round.id === addedRoundId,
    )!;
    expect(addedRound.scorecardId).toBe("scorecard-initial-v2");
    expect(addedRound.criteria.map((criterion) => criterion.name)).toEqual(
      expect.arrayContaining([
        "Originality",
        "Relevance",
        "Recommendation",
        "Comments",
      ]),
    );
    expect(
      addedRound.criteria.map((criterion) => criterion.name),
    ).not.toContain("Final Originality");

    await service.updateDraftRound(admin, {
      roundId: addedRound.id,
      revision: addedRound.revision,
      name: addedRound.name,
      opensAt: new Date(addedRound.opensAt! * 1_000).toISOString(),
      closesAt: new Date(addedRound.closesAt! * 1_000).toISOString(),
      anonymous: addedRound.anonymous,
      scorecardId: "scorecard-initial-v2",
      scorecardVersion: 2,
      dueAt: null,
      criteria: addedRound.criteria.map((criterion, index) => ({
        ...criterion,
        name: index === 0 ? "Forked Originality" : criterion.name,
      })),
    });
    const afterEdit = await service.getAdminWorkspace(admin);
    const editedRound = afterEdit.plan!.rounds.find(
      (round) => round.id === addedRound.id,
    )!;
    expect(editedRound.scorecardId).toBe(addedRound.id);
    expect(editedRound.scorecardVersion).toBe(1);
    expect(editedRound.criteria[0]?.name).toBe("Forked Originality");
    expect(editedRound.criteria[0]?.id).toBe(addedRound.criteria[0]?.id);
  });

  it("rejects one scorecard version being saved with different rubrics", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const input = planInput();
    await expect(
      service.savePlan(admin, {
        ...input,
        rounds: [
          input.rounds[0],
          {
            ...input.rounds[1],
            scorecardId: input.rounds[0].scorecardId,
            scorecardVersion: input.rounds[0].scorecardVersion,
          },
        ],
      }),
    ).rejects.toThrow(/linked to different rubrics/i);
  });

  it("rejects editing a persisted scorecard version under the same identity", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    const workspace = await service.getAdminWorkspace(admin);
    const changed = planInput();
    changed.revision = workspace.plan!.revision;
    changed.rounds[0]!.criteria[0] = {
      ...changed.rounds[0]!.criteria[0]!,
      name: "Changed without a new version",
    };

    await expect(service.savePlan(admin, changed)).rejects.toThrow(
      /already linked to a different persisted rubric/i,
    );
  });

  it("rejects invalid round dates and does not inherit omitted dates", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const planId = await service.savePlan(admin, planInput());
    const workspace = await service.getAdminWorkspace(admin);

    await expect(
      service.addNextRound(admin, {
        planId,
        planRevision: workspace.plan!.revision,
        name: "Invalid inherited dates",
        opensAt: "2019-08-01T09:00:00.000Z",
        closesAt: "2019-07-31T09:00:00.000Z",
        dueAt: null,
        anonymous: false,
        cloneRoundId: "abstract-initial-round",
      }),
    ).rejects.toThrow(/close date must be after/i);

    const unscheduledRoundId = await service.addNextRound(admin, {
      planId,
      planRevision: workspace.plan!.revision,
      name: "Unscheduled clone",
      dueAt: null,
      anonymous: false,
      cloneRoundId: "abstract-initial-round",
    });
    const reloaded = await service.getAdminWorkspace(admin);
    const unscheduledRound = reloaded.plan!.rounds.find(
      (round) => round.id === unscheduledRoundId,
    );
    expect(unscheduledRound).toMatchObject({
      opensAt: null,
      closesAt: null,
    });
  });

  it("requires round membership for assignment and keeps blinded identities out of reviewer output", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    await expect(
      service.assign(admin, {
        roundId: "abstract-initial-round",
        targetType: "submission",
        targetIds: [submissionId],
        evaluatorPersonIds: [sam.personId],
      }),
    ).rejects.toThrow(/not authorised|round reviewer/i);

    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    const assignment = await service.assign(admin, {
      roundId: "abstract-initial-round",
      targetType: "submission",
      targetIds: [submissionId],
      evaluatorPersonIds: [sam.personId],
    });
    expect(assignment.createdAssignmentCount).toBe(1);

    const assignmentRow = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
    )
      .bind(admin.eventId, "abstract-initial-round", sam.personId)
      .first<{ id: string }>();
    expect(assignmentRow).not.toBeNull();
    const reviewerWorkspace = await service.getReviewerWorkspace(
      sam,
      assignmentRow!.id,
    );
    const reviewerJson = JSON.stringify(reviewerWorkspace);
    expect(reviewerJson).not.toContain("Priya Raman");
    expect(reviewerJson).not.toContain("Marcus Okafor");
    expect(reviewerJson).not.toContain("priya.raman@example.com");
    expect(reviewerJson).not.toContain("marcus.okafor@example.com");
    expect(reviewerJson).not.toContain("Latticework Systems");
    expect(reviewerJson).not.toContain("https://linkedin.example/priya-raman");
    expect(reviewerJson).not.toContain("thoughtful event data practice");
    expect(reviewerWorkspace.submission).toMatchObject({
      blindedReviewing: true,
      submitterEmail: null,
      speakerNames: [],
    });
    expect(reviewerWorkspace.submission!.answerFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session_overview",
          value: "A useful review proposal.",
        }),
      ]),
    );

    const organizerWorkspace = await service.getAdminWorkspace(admin);
    const organizerSubmission = organizerWorkspace.submissions.find(
      (submission) => submission.id === submissionId,
    );
    expect(organizerSubmission).toMatchObject({
      submitterEmail: "priya.raman@example.com",
      speakers: expect.arrayContaining([
        {
          name: "Priya Raman",
          email: "priya.raman@example.com",
          roleLabel: null,
        },
        {
          name: "Marcus Okafor",
          email: "marcus.okafor@example.com",
          roleLabel: null,
        },
      ]),
      identityAnswers: expect.objectContaining({
        company: "Latticework Systems",
        biography: "Priya leads a thoughtful event data practice.",
      }),
    });
  });

  it("persists and reloads dropdown responses, while guessed URLs cannot bypass pool membership", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    await service.assign(admin, {
      roundId: "abstract-initial-round",
      targetType: "submission",
      targetIds: [submissionId],
      evaluatorPersonIds: [sam.personId],
    });
    const assigned = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
    )
      .bind(admin.eventId, "abstract-initial-round", sam.personId)
      .first<{ id: string }>();
    const saved = await service.saveReview(
      sam,
      {
        assignmentId: assigned!.id,
        revision: 0,
        scores: {
          "abstract-originality": 5,
          "abstract-relevance": 4,
          "abstract-recommendation": "Accept",
          "abstract-comments": "Strong fit.",
        },
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "",
        privateNotes: "",
        conflictAffirmed: true,
        intent: "submit",
      },
      "participant_ui",
    );
    expect(saved.reviewId).toBeTruthy();
    const reloaded = await service.getReviewerWorkspace(sam);
    expect(
      reloaded.criteria.find(
        (criterion) => criterion.name === "Recommendation",
      ),
    ).toMatchObject({ options: ["Accept", "Maybe", "Reject"] });
    expect(reloaded.review).toMatchObject({
      scores: expect.objectContaining({
        "abstract-recommendation": "Accept",
      }),
    });

    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "remove",
      confirmed: true,
    });
    await expect(
      service.getReviewerWorkspace(sam, assigned!.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getReviewerWorkspace({
        ...sam,
        organisationId: "org-not-authorised",
      }),
    ).rejects.toThrow(/authorised organisation|event not found/i);
  });

  it("cancels unfinished assignments when a reviewer leaves a round pool", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    await service.assign(admin, {
      roundId: "abstract-initial-round",
      targetType: "submission",
      targetIds: [submissionId],
      evaluatorPersonIds: [sam.personId],
    });
    const assigned = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
    )
      .bind(admin.eventId, "abstract-initial-round", sam.personId)
      .first<{ id: string }>();

    await expect(
      service.changeRoundReviewerPool(admin, {
        roundId: "abstract-initial-round",
        personId: sam.personId,
        operation: "remove",
      }),
    ).rejects.toThrow(/confirm.*removal/i);
    await expect(
      env.DB.prepare(
        "SELECT status FROM evaluator_assignments WHERE id = ? AND event_id = ?",
      )
        .bind(assigned!.id, admin.eventId)
        .first(),
    ).resolves.toEqual({ status: "assigned" });

    const removed = await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "remove",
      confirmed: true,
    });
    expect(removed).toMatchObject({ cancelledAssignmentCount: 1 });
    await expect(
      env.DB.prepare(
        `SELECT status, cancellation_reason
           FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
      )
        .bind(assigned!.id, admin.eventId)
        .first(),
    ).resolves.toEqual({
      status: "cancelled",
      cancellation_reason: "reviewer_removed",
    });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM evaluator_assignments
          WHERE event_id = ? AND round_id = ? AND status IN ('assigned','in_progress','reopened')`,
      )
        .bind(admin.eventId, "abstract-initial-round")
        .first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      service.getReviewerWorkspace(sam, assigned!.id),
    ).rejects.toMatchObject({
      status: 404,
    });

    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    await expect(
      service.assign(admin, {
        roundId: "abstract-initial-round",
        targetType: "submission",
        targetIds: [submissionId],
        evaluatorPersonIds: [sam.personId],
      }),
    ).resolves.toMatchObject({
      createdAssignmentCount: 1,
      requestedAssignmentCount: 1,
    });
    await expect(
      env.DB.prepare(
        `SELECT id, status, cancellation_reason
           FROM evaluator_assignments
          WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
      )
        .bind(admin.eventId, "abstract-initial-round", sam.personId)
        .first(),
    ).resolves.toMatchObject({
      id: assigned!.id,
      status: "assigned",
      cancellation_reason: null,
    });
  });

  it("rejects conflict declarations after a round closes", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.savePlan(admin, planInput());
    await service.changeRoundReviewerPool(admin, {
      roundId: "abstract-initial-round",
      personId: sam.personId,
      operation: "add",
    });
    await service.assign(admin, {
      roundId: "abstract-initial-round",
      targetType: "submission",
      targetIds: [submissionId],
      evaluatorPersonIds: [sam.personId],
    });
    const assigned = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?`,
    )
      .bind(admin.eventId, "abstract-initial-round", sam.personId)
      .first<{ id: string }>();

    await env.DB.prepare(
      `UPDATE evaluation_rounds
          SET closes_at = unixepoch() - 1
        WHERE id = ? AND event_id = ?`,
    )
      .bind("abstract-initial-round", admin.eventId)
      .run();

    await expect(
      service.declareConflict(
        sam,
        {
          assignmentId: assigned!.id,
          reason: "Conflict declared after the review deadline.",
        },
        "participant_ui",
      ),
    ).rejects.toThrow(/assignment not found|cannot be recused/i);
    await expect(
      env.DB.prepare(
        "SELECT status FROM evaluator_assignments WHERE id = ? AND event_id = ?",
      )
        .bind(assigned!.id, admin.eventId)
        .first(),
    ).resolves.toEqual({ status: "assigned" });
  });
});

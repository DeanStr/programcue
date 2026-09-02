import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { ensureDemoEvaluationData } from "./demo.server";
import {
  EvaluationService,
  EvaluationStateError,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const roundId = "demo-evaluation-round";
const samPersonId = "person-sbek-reviewer";

async function addAcceptedSamMembership() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES (
       'reviewer-progress-sam-membership', ?, ?, ?, 'evaluator',
       unixepoch(), unixepoch(), unixepoch()
     )`,
  )
    .bind(admin.organisationId, admin.eventId, samPersonId)
    .run();
}

async function addSamToRoundPool() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO evaluation_round_reviewers (
       id, event_id, round_id, person_id, added_by_person_id,
       revision, created_at, updated_at
     ) VALUES (
       'reviewer-progress-sam-pool', ?, ?, ?, ?, 1,
       unixepoch(), unixepoch()
     )`,
  )
    .bind(admin.eventId, roundId, samPersonId, admin.personId)
    .run();
}

async function addSamAssignment(status: "assigned" | "submitted") {
  await env.DB.prepare(
    `INSERT INTO evaluator_assignments (
       id, event_id, round_id, submission_id, evaluator_person_id,
       status, revision, assigned_at, submitted_at
     ) VALUES (
       'reviewer-progress-sam-assignment', ?, ?,
       'demo-evaluation-submission-calm', ?, ?, 1, unixepoch(),
       CASE WHEN ? = 'submitted' THEN unixepoch() ELSE NULL END
     )`,
  )
    .bind(admin.eventId, roundId, samPersonId, status, status)
    .run();
}

async function publishedTemplate(
  category: "ad_hoc" | "task_reminder" = "ad_hoc",
) {
  const communications = new CommunicationService(
    env as unknown as CloudflareEnvironment,
  );
  const saved = await communications.saveTemplate(admin, {
    name: `${category} reviewer progress template`,
    category,
    subject: "Your review assignments are waiting",
    content: {
      body: "Please return to Program Cue and complete your assigned reviews.",
      physicalAddress: "255 Front Street West, Toronto, ON",
    },
  });
  await communications.publishTemplate(admin, saved.versionId);
  return saved.versionId;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM events WHERE id = 'reviewer-progress-other-event'",
    ),
    env.DB.prepare(
      `DELETE FROM evaluator_assignments
        WHERE id IN (
          'reviewer-progress-sam-assignment',
          'reviewer-progress-recused',
          'reviewer-progress-cancelled',
          'reviewer-progress-second-assignment',
          'reviewer-progress-stale-session-assignment'
        )`,
    ),
    env.DB.prepare(
      `DELETE FROM evaluation_round_reviewers
        WHERE id IN (
          'reviewer-progress-sam-pool',
          'reviewer-progress-second-pool'
        )`,
    ),
    env.DB.prepare(
      "DELETE FROM evaluation_rounds WHERE id = 'reviewer-progress-second-round'",
    ),
    env.DB.prepare(
      "DELETE FROM memberships WHERE id = 'reviewer-progress-sam-membership'",
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE id = 'reviewer-progress-stale-session'",
    ),
    env.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'assigned', submitted_at = NULL
        WHERE id IN (
          'demo-evaluation-assignment-1',
          'demo-evaluation-assignment-2'
        )`,
    ),
  ]);
  await ensureDemoProgramme(env as unknown as CloudflareEnvironment);
  await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
  await addAcceptedSamMembership();
});

describe("round reviewer progress and reminder preparation", () => {
  it("preserves stale session history without counting or reminding it as current work", async () => {
    await addSamToRoundPool();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format,
           duration_minutes, status, revision, created_at, updated_at
         ) VALUES (
           'reviewer-progress-stale-session', ?, 'Archived session',
           'reviewer-progress-stale-session', 'Historical session review.',
           'presentation', 45, 'archived', 1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, revision, assigned_at
         ) VALUES (
           'reviewer-progress-stale-session-assignment', ?, ?,
           'reviewer-progress-stale-session', ?, ?, 'assigned', 1,
           unixepoch()
         )`,
      ).bind(
        admin.eventId,
        roundId,
        JSON.stringify({
          title: "Archived session",
          trackName: "Programme",
          format: "presentation",
        }),
        samPersonId,
      ),
    ]);

    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const workspace = await service.getAdminWorkspace(admin);
    expect(
      workspace.assignments.map((assignment) => assignment.id),
    ).not.toContain("reviewer-progress-stale-session-assignment");
    expect(
      workspace.reviewerProgress.find(
        (progress) => progress.reviewerPersonId === samPersonId,
      ),
    ).toMatchObject({
      assignedCount: 0,
      completedCount: 0,
      inProgressCount: 0,
      pendingCount: 0,
    });

    const templateVersionId = await publishedTemplate();
    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId,
      }),
    ).rejects.toThrow(/unfinished work/i);
    await expect(
      env.DB.prepare(
        `SELECT status FROM evaluator_assignments
          WHERE id = 'reviewer-progress-stale-session-assignment'
            AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "assigned" });
  });

  it("reports round-scoped progress, includes empty pool members, and excludes cancelled or recused work", async () => {
    await addSamToRoundPool();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'demo-evaluation-assignment-1' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'reopened', submitted_at = NULL
          WHERE id = 'demo-evaluation-assignment-2' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, revision, assigned_at
         ) VALUES (
           'reviewer-progress-recused', ?, ?, 'demo-session-1', '{}',
           'person-demo-evaluator', 'recused', 1, unixepoch()
         )`,
      ).bind(admin.eventId, roundId),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status, revision, assigned_at
         ) VALUES (
           'reviewer-progress-cancelled', ?, ?, 'demo-session-2', '{}',
           'person-demo-evaluator', 'cancelled', 1, unixepoch()
         )`,
      ).bind(admin.eventId, roundId),
      env.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status,
           blinded_reviewing, scorecard_id, scorecard_version,
           advancement_rule_json, revision, created_at, updated_at
         ) VALUES (
           'reviewer-progress-second-round', ?, 'demo-evaluation-plan', 2,
           'Second review', 'active', 0, 'reviewer-progress-second-scorecard',
           1, '{}', 1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO evaluation_criteria (
           id, event_id, round_id, name, input_type, options_json,
           weight_percent, required, position
         ) VALUES (
           'reviewer-progress-second-criterion', ?,
           'reviewer-progress-second-round', 'Quality', 'scale_5', '[]',
           100, 1, 0
         )`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO evaluation_round_reviewers (
           id, event_id, round_id, person_id, added_by_person_id,
           revision, created_at, updated_at
         ) VALUES (
           'reviewer-progress-second-pool', ?,
           'reviewer-progress-second-round', 'person-demo-evaluator', ?,
           1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, submission_id, evaluator_person_id,
           status, revision, assigned_at
         ) VALUES (
           'reviewer-progress-second-assignment', ?,
           'reviewer-progress-second-round',
           'demo-evaluation-submission-calm', 'person-demo-evaluator',
           'assigned', 1, unixepoch()
         )`,
      ).bind(admin.eventId),
    ]);

    const workspace = await new EvaluationService(
      env as unknown as CloudflareEnvironment,
    ).getAdminWorkspace(admin);

    expect(workspace.reviewerProgress).toEqual(
      expect.arrayContaining([
        {
          roundId,
          reviewerPersonId: "person-demo-evaluator",
          reviewerName: "Jordan Lee",
          reviewerEmail: "jordan.evaluator@example.com",
          assignedCount: 3,
          completedCount: 1,
          resolvedCount: 2,
          inProgressCount: 1,
          pendingCount: 0,
          recusedCount: 1,
        },
        {
          roundId,
          reviewerPersonId: samPersonId,
          reviewerName: "Sam Whitfield",
          reviewerEmail: "sbek-reviewer@example.com",
          assignedCount: 0,
          completedCount: 0,
          resolvedCount: 0,
          inProgressCount: 0,
          pendingCount: 0,
          recusedCount: 0,
        },
        {
          roundId: "reviewer-progress-second-round",
          reviewerPersonId: "person-demo-evaluator",
          reviewerName: "Jordan Lee",
          reviewerEmail: "jordan.evaluator@example.com",
          assignedCount: 1,
          completedCount: 0,
          resolvedCount: 0,
          inProgressCount: 0,
          pendingCount: 1,
          recusedCount: 0,
        },
      ]),
    );
  });

  it("prepares one exact transactional draft for current unfinished pool reviewers without sending", async () => {
    await addSamToRoundPool();
    await addSamAssignment("assigned");
    const templateVersionId = await publishedTemplate();
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );

    const draft = await service.prepareReviewerReminder(admin, {
      roundId,
      reviewerPersonIds: [samPersonId],
      templateVersionId,
    });

    expect(draft).toMatchObject({
      templateVersionId,
      audienceType: "manual",
      manualRecipients: "sbek-reviewer@example.com",
      kind: "transactional",
      scheduledAt: null,
    });
    const persisted = await env.DB.prepare(
      `SELECT event_id AS eventId, status, kind, audience_json AS audienceJson
         FROM communications WHERE id = ?`,
    )
      .bind(draft.id)
      .first<{
        eventId: string;
        status: string;
        kind: string;
        audienceJson: string;
      }>();
    expect(persisted).toMatchObject({
      eventId: admin.eventId,
      status: "draft",
      kind: "transactional",
    });
    expect(JSON.parse(persisted!.audienceJson)).toMatchObject({
      audienceType: "manual",
      manualRecipients: "sbek-reviewer@example.com",
    });
  });

  it("fails before resolving recipients or creating a draft when Airtable authority is stale", async () => {
    await addSamToRoundPool();
    await addSamAssignment("assigned");
    const templateVersionId = await publishedTemplate();
    const unavailable = new Error(
      "The Airtable authority projection is not synchronized.",
    );
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
      {
        airtable: {
          assertReadable,
        } as unknown as AirtableProviderBoundary,
      },
    );
    const draftCountBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM communications
        WHERE event_id = ? AND template_version_id = ?`,
    )
      .bind(admin.eventId, templateVersionId)
      .first<{ count: number }>();

    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId,
      }),
    ).rejects.toBe(unavailable);
    expect(assertReadable).toHaveBeenCalledOnce();
    expect(assertReadable).toHaveBeenCalledWith(admin);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM communications
          WHERE event_id = ? AND template_version_id = ?`,
      )
        .bind(admin.eventId, templateVersionId)
        .first<{ count: number }>(),
    ).resolves.toEqual(draftCountBefore);
  });

  it("fails closed for non-pool, completed, cross-event, unauthorised, and non-ad-hoc requests", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const templateVersionId = await publishedTemplate();

    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId,
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);

    await addSamToRoundPool();
    await addSamAssignment("submitted");
    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId,
      }),
    ).rejects.toThrow(/unfinished work/i);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, revision, created_at, updated_at
         )
         SELECT 'reviewer-progress-other-event', organisation_id,
                'Other reviewer event', 'reviewer-progress-other-event',
                timezone, starts_at, ends_at, file_policy_json, 1,
                unixepoch(), unixepoch()
           FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(admin.eventId, admin.organisationId),
      env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (
           'reviewer-progress-other-membership', ?,
           'reviewer-progress-other-event', 'person-sbek-speaker2',
           'evaluator', unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(admin.organisationId),
      env.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, revision,
           created_by_person_id, created_at, updated_at
         ) VALUES (
           'reviewer-progress-other-plan', 'reviewer-progress-other-event',
           'Other plan', 'active', 1, ?, unixepoch(), unixepoch()
         )`,
      ).bind(admin.personId),
      env.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status,
           scorecard_id, revision, created_at, updated_at
         ) VALUES (
           'reviewer-progress-other-round', 'reviewer-progress-other-event',
           'reviewer-progress-other-plan', 1, 'Other round', 'active',
           'reviewer-progress-other-scorecard', 1, unixepoch(), unixepoch()
         )`,
      ),
      env.DB.prepare(
        `INSERT INTO evaluation_round_reviewers (
           id, event_id, round_id, person_id, added_by_person_id,
           revision, created_at, updated_at
         ) VALUES (
           'reviewer-progress-other-pool', 'reviewer-progress-other-event',
           'reviewer-progress-other-round', 'person-sbek-speaker2', ?,
           1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.personId),
    ]);
    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: ["person-sbek-speaker2"],
        templateVersionId,
      }),
    ).rejects.toThrow(/this round's pool/i);

    const chair = { ...admin, role: "committee_chair" as const };
    await expect(
      service.prepareReviewerReminder(chair, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const wrongCategoryVersionId = await publishedTemplate("task_reminder");
    await expect(
      service.prepareReviewerReminder(admin, {
        roundId,
        reviewerPersonIds: [samPersonId],
        templateVersionId: wrongCategoryVersionId,
      }),
    ).rejects.toThrow(/published ad hoc email template/i);
  });
});

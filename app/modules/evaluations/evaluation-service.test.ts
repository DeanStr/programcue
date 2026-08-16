import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ensureDemoEvaluationData } from "./demo.server";
import { EvaluationService } from "./evaluation-service.server";

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

describe("evaluation demo data", () => {
  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM evaluation_plans WHERE id = 'demo-evaluation-plan'",
      ),
      env.DB.prepare(
        "DELETE FROM submissions WHERE id LIKE 'demo-evaluation-submission-%'",
      ),
      env.DB.prepare(
        "DELETE FROM form_definitions WHERE id = 'demo-evaluation-form'",
      ),
    ]);
  });

  it("is demo-only, idempotent and produces real tenant-scoped evaluation workspaces", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoEvaluationData({
      DB: env.DB,
      DEMO_MODE: "false",
    } as unknown as CloudflareEnvironment);
    expect(
      await env.DB.prepare(
        "SELECT id FROM evaluation_plans WHERE id = 'demo-evaluation-plan'",
      ).first(),
    ).toBeNull();

    await ensureDemoEvaluationData(testEnv);
    await ensureDemoEvaluationData(testEnv);

    const [form, version, submissions, speakers, rubric, assignments, reviews] =
      await Promise.all([
        env.DB.prepare(
          `
        SELECT f.id, f.status, e.organisation_id AS organisationId
          FROM form_definitions f JOIN events e ON e.id = f.event_id
         WHERE f.id = 'demo-evaluation-form'
      `,
        ).first<{ id: string; status: string; organisationId: string }>(),
        env.DB.prepare(
          `
        SELECT schema_json AS schemaJson, routing_json AS routingJson,
               settings_snapshot_json AS settingsJson
          FROM form_versions
         WHERE id = 'demo-evaluation-form-v1'
      `,
        ).first<{
          schemaJson: string;
          routingJson: string;
          settingsJson: string;
        }>(),
        env.DB.prepare(
          `
        SELECT id, status, submitted_at AS submittedAt
          FROM submissions
         WHERE id LIKE 'demo-evaluation-submission-%'
         ORDER BY id
      `,
        ).all<{ id: string; status: string; submittedAt: number | null }>(),
        env.DB.prepare(
          `
        SELECT id, submission_id AS submissionId, display_name AS displayName
          FROM submission_speakers
         WHERE id LIKE 'demo-evaluation-speaker-%'
         ORDER BY id
      `,
        ).all<{ id: string; submissionId: string; displayName: string }>(),
        env.DB.prepare(
          `
        SELECT r.status, COUNT(c.id) AS criterionCount,
               COALESCE(SUM(c.weight_percent), 0) AS totalWeight
          FROM evaluation_rounds r
          LEFT JOIN evaluation_criteria c ON c.round_id = r.id AND c.event_id = r.event_id
         WHERE r.id = 'demo-evaluation-round' AND r.event_id = ?
         GROUP BY r.id
      `,
        )
          .bind(admin.eventId)
          .first<{
            status: string;
            criterionCount: number;
            totalWeight: number;
          }>(),
        env.DB.prepare(
          `
        SELECT a.id, a.event_id AS eventId, a.evaluator_person_id AS evaluatorPersonId
          FROM evaluator_assignments a
         WHERE a.id LIKE 'demo-evaluation-assignment-%'
         ORDER BY a.id
      `,
        ).all<{ id: string; eventId: string; evaluatorPersonId: string }>(),
        env.DB.prepare(
          `
        SELECT COUNT(*) AS count
          FROM reviews r JOIN evaluator_assignments a ON a.id = r.assignment_id
         WHERE a.id LIKE 'demo-evaluation-assignment-%'
      `,
        ).first<{ count: number }>(),
      ]);

    expect(form).toEqual({
      id: "demo-evaluation-form",
      status: "archived",
      organisationId: admin.organisationId,
    });
    const demoFormFields = formSchemaSchema.parse(
      JSON.parse(version?.schemaJson ?? "null"),
    ).fields;
    expect(demoFormFields).toHaveLength(6);
    expect(
      demoFormFields.every((field) => field.reviewVisibility === "reviewers"),
    ).toBe(true);
    expect(JSON.parse(version?.routingJson ?? "null")).toEqual({
      categories: {},
      trackIds: {
        "Event Operations": "demo-track-operations",
        "Experience Design": "demo-track-experience",
      },
      trackNames: {
        "demo-track-operations": "Event Operations",
        "demo-track-experience": "Experience Design",
      },
      teamNames: {},
      directSessionDurationMinutes: null,
      passwordHash: null,
    });
    expect(JSON.parse(version?.settingsJson ?? "null")).toMatchObject({
      minSpeakers: 1,
      maxSpeakers: 2,
    });
    expect(submissions.results).toHaveLength(2);
    expect(
      submissions.results.every(
        (submission) =>
          submission.status === "assigned" && submission.submittedAt !== null,
      ),
    ).toBe(true);
    expect(speakers.results.map((speaker) => speaker.displayName)).toEqual([
      "Alex Morgan",
      "Priya Shah",
    ]);
    expect(rubric).toEqual({
      status: "active",
      criterionCount: 4,
      totalWeight: 100,
    });
    expect(assignments.results).toHaveLength(2);
    expect(
      assignments.results.every(
        (assignment) =>
          assignment.eventId === admin.eventId &&
          assignment.evaluatorPersonId === evaluator.personId,
      ),
    ).toBe(true);
    expect(reviews?.count).toBe(0);

    const service = new EvaluationService(testEnv);
    const adminWorkspace = await service.getAdminWorkspace(admin);
    expect(adminWorkspace.plan?.id).toBe("demo-evaluation-plan");
    expect(
      adminWorkspace.submissions.filter((submission) =>
        submission.id.startsWith("demo-evaluation-submission-"),
      ),
    ).toHaveLength(2);

    const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
    expect(reviewerWorkspace.assignments).toHaveLength(2);
    expect(reviewerWorkspace.selected).toMatchObject({
      id: "demo-evaluation-assignment-1",
      title: "Operational calm under pressure",
      category: "Event Operations",
      format: "Workshop",
    });
    expect(
      reviewerWorkspace.criteria.reduce(
        (sum, criterion) => sum + criterion.weightPercent,
        0,
      ),
    ).toBe(100);
    expect(reviewerWorkspace.submission?.speakerNames).toEqual(["Alex Morgan"]);
    expect(reviewerWorkspace.submission?.answers).toMatchObject({
      title: "Operational calm under pressure",
      category: "Event Operations",
      format: "Workshop",
      session_overview: expect.any(String),
      audience_takeaway: expect.any(String),
      delivery_approach: expect.any(String),
    });
    expect(reviewerWorkspace.review).toBeNull();
    await expect(
      service.getReviewerWorkbench(evaluator),
    ).resolves.toMatchObject({
      kind: "ready",
      eventName: "Future of Events 2027",
      workspace: { selected: { id: "demo-evaluation-assignment-1" } },
    });
  });
});

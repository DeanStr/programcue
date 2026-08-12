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
      eventName: "Future of Events 2025",
      workspace: { selected: { id: "demo-evaluation-assignment-1" } },
    });
  });
});

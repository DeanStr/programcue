import type { FormVersion } from "~/modules/submissions/submission-repository-shared";
import type {
  FormRouting,
  SubmissionFormSchema,
} from "~/modules/submissions/submission-schema";
import { DEFAULT_FORM_PRESENTATION } from "~/modules/submissions/submission-schema";
import { ensureDemoData } from "~/platform/demo/seed.server";

const DEMO_ORGANISATION_ID = "org-future-events";
const DEMO_EVENT_ID = "evt-foe-2025";
const DEMO_ADMIN_ID = "person-demo-admin";
const DEMO_EVALUATOR_ID = "person-demo-evaluator";

const FORM_ID = "demo-evaluation-form";
const FORM_VERSION_ID = "demo-evaluation-form-v1";
const PLAN_ID = "demo-evaluation-plan";
const ROUND_ID = "demo-evaluation-round";

const formSchema = {
  schemaVersion: 2,
  introduction:
    "These archived proposals provide stable, realistic evaluation examples in demo mode.",
  presentation: DEFAULT_FORM_PRESENTATION,
  sections: [
    {
      id: "proposal",
      title: "Proposal",
      description: "",
    },
  ],
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Session title",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
    {
      id: "category",
      type: "select",
      label: "Category",
      required: true,
      help: "",
      example: "",
      options: ["Event Operations", "Experience Design"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
    {
      id: "format",
      type: "select",
      label: "Format",
      required: true,
      help: "",
      example: "",
      options: ["Workshop", "Presentation"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
    {
      id: "session_overview",
      type: "long_text",
      label: "Session overview",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
    {
      id: "audience_takeaway",
      type: "long_text",
      label: "Audience takeaway",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
    {
      id: "delivery_approach",
      type: "long_text",
      label: "Delivery approach",
      required: true,
      help: "",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
      sectionId: "proposal",
    },
  ],
} satisfies SubmissionFormSchema;

const formRouting = {
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
} satisfies FormRouting;

const formSettings = {
  name: "Evaluation demo proposals",
  kind: "submission",
  publicSlug: "evaluation-demo",
  closesAt: null,
  submissionLimit: null,
  minSpeakers: 1,
  maxSpeakers: 2,
  accessMode: "email_verified",
} satisfies Required<FormVersion["settings"]>;

const proposals = [
  {
    id: "demo-evaluation-submission-calm",
    reference: "DEMO-EVAL-001",
    title: "Operational calm under pressure",
    category: "Event Operations",
    format: "Workshop",
    submitterPersonId: "person-demo-submitter",
    submitterEmail: "alex.submitter@example.com",
    speakerId: "demo-evaluation-speaker-calm",
    speakerName: "Alex Morgan",
    answers: {
      session_overview:
        "A practical workshop for replacing fragmented run-of-show decisions with clear operating rhythms.",
      audience_takeaway:
        "A reusable incident cadence and handoff checklist for live event teams.",
      delivery_approach:
        "Short case study, facilitated scenario and a take-home operating template.",
    },
  },
  {
    id: "demo-evaluation-submission-inclusive",
    reference: "DEMO-EVAL-002",
    title: "Designing inclusive attendee journeys",
    category: "Experience Design",
    format: "Presentation",
    submitterPersonId: "person-demo-speaker",
    submitterEmail: "priya.speaker@example.com",
    speakerId: "demo-evaluation-speaker-inclusive",
    speakerName: "Priya Shah",
    answers: {
      session_overview:
        "Field-tested patterns for making event technology calmer and more accessible from registration to follow-up.",
      audience_takeaway:
        "A prioritised set of accessibility checks that can be applied before launch.",
      delivery_approach:
        "Annotated examples, audience prompts and a concise implementation checklist.",
    },
  },
] as const;

const criteria = [
  {
    id: "demo-evaluation-criterion-relevance",
    name: "Audience relevance",
    description: "Fit for the event audience and programme.",
    weight: 30,
    position: 0,
  },
  {
    id: "demo-evaluation-criterion-substance",
    name: "Content substance",
    description: "Clarity, evidence and depth of the proposal.",
    weight: 25,
    position: 1,
  },
  {
    id: "demo-evaluation-criterion-practicality",
    name: "Practical value",
    description: "Usefulness of the promised attendee outcomes.",
    weight: 25,
    position: 2,
  },
  {
    id: "demo-evaluation-criterion-delivery",
    name: "Delivery approach",
    description: "Suitability of the format and facilitation plan.",
    weight: 20,
    position: 3,
  },
] as const;

export async function ensureDemoEvaluationData(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;

  await ensureDemoData(env);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT OR IGNORE INTO form_definitions (
        id, event_id, name, description, kind, status, public_slug,
        min_speakers, max_speakers, access_mode, revision,
        created_by_person_id, created_at, updated_at
      )
      SELECT ?, e.id, 'Evaluation demo proposals',
             'Independent submitted proposals used by the evaluation demo.',
             'submission', 'archived', 'evaluation-demo',
             1, 2, 'email_verified', 1, ?, unixepoch(), unixepoch()
        FROM events e
       WHERE e.id = ? AND e.organisation_id = ?
    `).bind(FORM_ID, DEMO_ADMIN_ID, DEMO_EVENT_ID, DEMO_ORGANISATION_ID),
    env.DB.prepare(`
      INSERT OR IGNORE INTO form_versions (
        id, event_id, form_id, version_number, schema_json, routing_json,
        settings_snapshot_json, status, revision, published_at,
        created_by_person_id, created_at, updated_at
      )
      SELECT ?, f.event_id, f.id, 1, ?, ?, ?, 'published', 1,
             unixepoch(), ?, unixepoch(), unixepoch()
        FROM form_definitions f
       WHERE f.id = ? AND f.event_id = ?
    `).bind(
      FORM_VERSION_ID,
      JSON.stringify(formSchema),
      JSON.stringify(formRouting),
      JSON.stringify(formSettings),
      DEMO_ADMIN_ID,
      FORM_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(`
      UPDATE form_definitions
         SET status = 'archived'
       WHERE id = ? AND event_id = ?
         AND EXISTS (
           SELECT 1 FROM events
            WHERE id = form_definitions.event_id AND organisation_id = ?
         )
    `).bind(FORM_ID, DEMO_EVENT_ID, DEMO_ORGANISATION_ID),
    env.DB.prepare(`
      UPDATE form_versions
         SET schema_json = ?, routing_json = ?, settings_snapshot_json = ?
       WHERE id = ? AND form_id = ? AND event_id = ?
    `).bind(
      JSON.stringify(formSchema),
      JSON.stringify(formRouting),
      JSON.stringify(formSettings),
      FORM_VERSION_ID,
      FORM_ID,
      DEMO_EVENT_ID,
    ),
  ];

  for (const proposal of proposals) {
    const answerValues = {
      title: proposal.title,
      category: proposal.category,
      format: proposal.format,
      ...proposal.answers,
    };
    const answers = JSON.stringify(answerValues);
    const submittedSnapshot = JSON.stringify({
      formVersionId: FORM_VERSION_ID,
      versionNumber: 1,
      schema: formSchema,
      answers: answerValues,
      speakers: [
        { name: proposal.speakerName, email: proposal.submitterEmail },
      ],
    });
    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        )
        SELECT ?, v.event_id, v.id, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, 1,
               unixepoch(), unixepoch(), unixepoch()
          FROM form_versions v
         WHERE v.id = ? AND v.event_id = ? AND v.status = 'published'
      `).bind(
        proposal.id,
        proposal.submitterPersonId,
        proposal.submitterEmail,
        proposal.reference,
        proposal.title,
        proposal.category,
        proposal.format,
        answers,
        submittedSnapshot,
        FORM_VERSION_ID,
        DEMO_EVENT_ID,
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name,
          role_label, position, invitation_status, is_primary, claimed_at,
          created_at, updated_at
        )
        SELECT ?, s.event_id, s.id, ?, ?, ?, 'Primary speaker', 0, 'claimed', 1,
               unixepoch(), unixepoch(), unixepoch()
          FROM submissions s
         WHERE s.id = ? AND s.event_id = ?
      `).bind(
        proposal.speakerId,
        proposal.submitterPersonId,
        proposal.submitterEmail,
        proposal.speakerName,
        proposal.id,
        DEMO_EVENT_ID,
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO submission_track_selections (
          event_id, submission_id, track_id, track_name_snapshot, position
        )
        SELECT s.event_id, s.id, t.id, t.name, 0
          FROM submissions s
          JOIN tracks t ON t.event_id = s.event_id AND t.id = ? AND t.name = ?
         WHERE s.id = ? AND s.event_id = ?
      `).bind(
        formRouting.trackIds[proposal.category],
        proposal.category,
        proposal.id,
        DEMO_EVENT_ID,
      ),
    );
  }

  statements.push(
    env.DB.prepare(`
      INSERT OR IGNORE INTO evaluation_plans (
        id, event_id, name, status, blinded_reviewing, decision_role,
        revision, created_by_person_id, created_at, updated_at
      )
      SELECT ?, e.id, 'Programme committee review', 'active', 0,
             'administrator', 1, ?, unixepoch(), unixepoch()
        FROM events e
       WHERE e.id = ? AND e.organisation_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM evaluation_plans existing_plan
            WHERE existing_plan.event_id = e.id
              AND existing_plan.status <> 'archived'
         )
    `).bind(PLAN_ID, DEMO_ADMIN_ID, DEMO_EVENT_ID, DEMO_ORGANISATION_ID),
    env.DB.prepare(`
      INSERT OR IGNORE INTO evaluation_rounds (
        id, event_id, plan_id, round_number, name, status,
        blinded_reviewing, scorecard_id, scorecard_version,
        advancement_rule_json, revision, created_at, updated_at
      )
      SELECT ?, p.event_id, p.id, 1, 'Initial review', 'active', 0, ?, 1, '{}', 1,
             unixepoch(), unixepoch()
        FROM evaluation_plans p
       WHERE p.id = ? AND p.event_id = ? AND p.status = 'active'
    `).bind(ROUND_ID, ROUND_ID, PLAN_ID, DEMO_EVENT_ID),
  );

  for (const criterion of criteria) {
    statements.push(
      env.DB.prepare(`
      INSERT OR IGNORE INTO evaluation_criteria (
        id, event_id, round_id, name, description, input_type,
        options_json, weight_percent, required, position
      )
      SELECT ?, r.event_id, r.id, ?, ?, 'scale_5', '[]', ?, 1, ?
        FROM evaluation_rounds r
       WHERE r.id = ? AND r.event_id = ? AND r.status = 'active'
    `).bind(
        criterion.id,
        criterion.name,
        criterion.description,
        criterion.weight,
        criterion.position,
        ROUND_ID,
        DEMO_EVENT_ID,
      ),
    );
  }

  statements.push(
    env.DB.prepare(`
    INSERT OR IGNORE INTO evaluation_round_reviewers (
      id, event_id, round_id, person_id, added_by_person_id,
      revision, created_at, updated_at
    )
    SELECT 'demo-evaluation-round-reviewer', r.event_id, r.id, m.person_id, ?, 1,
           unixepoch(), unixepoch()
      FROM evaluation_rounds r
      JOIN memberships m
        ON m.event_id = r.event_id AND m.person_id = ?
       AND m.role = 'evaluator'
       AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
     WHERE r.id = ? AND r.event_id = ? AND r.status = 'active'
  `).bind(DEMO_ADMIN_ID, DEMO_EVALUATOR_ID, ROUND_ID, DEMO_EVENT_ID),
  );

  for (const [index, proposal] of proposals.entries()) {
    statements.push(
      env.DB.prepare(`
      INSERT OR IGNORE INTO evaluator_assignments (
        id, event_id, round_id, submission_id, evaluator_person_id,
        status, revision, assigned_at
      )
      SELECT ?, r.event_id, r.id, s.id, m.person_id, 'assigned', 1, unixepoch()
        FROM evaluation_rounds r
        JOIN submissions s ON s.event_id = r.event_id AND s.id = ?
        JOIN memberships m ON m.event_id = r.event_id
                          AND m.person_id = ?
                          AND m.role = 'evaluator'
                          AND m.accepted_at IS NOT NULL
                          AND m.revoked_at IS NULL
        JOIN evaluation_round_reviewers pool
          ON pool.event_id = r.event_id
         AND pool.round_id = r.id
         AND pool.person_id = m.person_id
       WHERE r.id = ? AND r.event_id = ? AND r.status = 'active'
    `).bind(
        `demo-evaluation-assignment-${index + 1}`,
        proposal.id,
        DEMO_EVALUATOR_ID,
        ROUND_ID,
        DEMO_EVENT_ID,
      ),
    );
  }

  await env.DB.batch(statements);
}

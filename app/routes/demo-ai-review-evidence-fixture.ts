import { type ActionFunctionArgs, data } from "react-router";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const CONFIRMATION = "seed-ai-review-evidence-browser-fixture";
const EVENT_ID = "evt-foe-2025";
const ROUND_ID = "demo-evaluation-round";
const SUBMISSION_ID = "demo-evaluation-submission-inclusive";
const ASSESSMENT_ID = "e2e-ai-review-evidence-assessment";

function requireE2eFixtureRuntime(env: CloudflareEnvironment) {
  const fixtureFlag = (
    env as CloudflareEnvironment & { PROGRAM_CUE_E2E_FIXTURES?: string }
  ).PROGRAM_CUE_E2E_FIXTURES;
  if (
    fixtureFlag !== "true" ||
    String(env.DEMO_MODE) !== "true" ||
    String(env.APP_ENV) !== "demo"
  ) {
    throw new Response("Not found", { status: 404 });
  }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function loader() {
  throw new Response("Not found", { status: 404 });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { env } = getCloudflareContext(context);
  requireE2eFixtureRuntime(env);
  if (request.method !== "POST") {
    return data(
      { ok: false, error: "The AI review evidence fixture requires POST." },
      { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
    );
  }
  const form = await request.formData();
  if (form.get("confirm") !== CONFIRMATION) {
    throw new Response("Explicit E2E fixture confirmation is required", {
      status: 400,
    });
  }

  await ensureDemoEvaluationData(env);
  const source = await env.DB.prepare(
    `SELECT submission.submitted_snapshot_json AS submittedSnapshotJson,
            revision.id AS submissionRevisionId,
            round.scorecard_id AS scorecardId,
            round.scorecard_version AS scorecardVersion,
            round.revision AS roundRevision
       FROM submissions submission
       JOIN submission_revisions revision
         ON revision.submission_id = submission.id
        AND revision.event_id = submission.event_id
        AND revision.save_kind = 'submitted'
       JOIN evaluation_rounds round
         ON round.id = ? AND round.event_id = submission.event_id
      WHERE submission.id = ? AND submission.event_id = ?
      ORDER BY revision.revision_number DESC
      LIMIT 1`,
  )
    .bind(ROUND_ID, SUBMISSION_ID, EVENT_ID)
    .first<{
      submittedSnapshotJson: string;
      submissionRevisionId: string;
      scorecardId: string;
      scorecardVersion: number;
      roundRevision: number;
    }>();
  if (!source) throw new Error("The E2E AI evidence source is unavailable.");

  await env.DB.prepare(
    `INSERT INTO ai_review_assessments (
       id, event_id, round_id, submission_id, scorecard_id,
       scorecard_version, round_revision, score, rationale, provider, model,
       provider_response_id, generated_by_person_id, last_operation_id,
       submission_revision_id, source_snapshot_sha256, model_input_sha256,
       prompt_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 2.5,
               'Browser evidence fixture only: no model provider was called and no external AI success is claimed.',
               'workers_ai', 'e2e-fixture-no-provider-call',
               'e2e-fixture-no-provider-response', 'person-demo-admin',
               'e2e-ai-review-evidence-operation', ?, ?, ?, 1)`,
  )
    .bind(
      ASSESSMENT_ID,
      EVENT_ID,
      ROUND_ID,
      SUBMISSION_ID,
      source.scorecardId,
      source.scorecardVersion,
      source.roundRevision,
      source.submissionRevisionId,
      await sha256(source.submittedSnapshotJson),
      await sha256("E2E presentation fixture: no provider call"),
    )
    .run();

  return data(
    { ok: true, assessmentId: ASSESSMENT_ID },
    { headers: { "cache-control": "no-store" } },
  );
}

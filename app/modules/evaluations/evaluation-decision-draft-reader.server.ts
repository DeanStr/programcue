import { decisionDraftEffectPreviewSchema } from "./evaluation-schema";

export async function loadEvaluationDecisionDrafts(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  eventId: string;
}) {
  const { env, organisationId, eventId } = input;
  const decisionDraftRows = await env.DB.prepare(
    `SELECT decision.submission_id AS submissionId,
            decision.revision_number AS revisionNumber,
            decision.decision, decision.rationale,
            decision.effect_preview_json AS effectPreviewJson
       FROM submission_decisions decision
       JOIN events event
         ON event.id = decision.event_id AND event.organisation_id = ?
      WHERE decision.event_id = ? AND decision.status = 'draft'
      ORDER BY decision.submission_id, decision.revision_number DESC`,
  )
    .bind(organisationId, eventId)
    .all<{
      submissionId: string;
      revisionNumber: number;
      decision: "accepted" | "rejected" | "waitlisted";
      rationale: string | null;
      effectPreviewJson: string;
    }>();
  const decisionDraftBySubmission = new Map<
    string,
    {
      revisionNumber: number;
      decision: "accepted" | "rejected" | "waitlisted";
      rationale: string;
      includeReviewerFeedback: boolean;
      sessionTrackId: string | null;
      sessionFormatKey: string | null;
      sessionDurationMinutes: number | null;
    }
  >();
  for (const row of decisionDraftRows.results) {
    if (decisionDraftBySubmission.has(row.submissionId)) continue;
    const effectPreview = decisionDraftEffectPreviewSchema.safeParse(
      JSON.parse(row.effectPreviewJson),
    );
    if (!effectPreview.success) {
      throw new Error(
        `Decision draft ${row.submissionId} has invalid persisted preview data.`,
      );
    }
    decisionDraftBySubmission.set(row.submissionId, {
      revisionNumber: row.revisionNumber,
      decision: row.decision,
      rationale: row.rationale ?? "",
      ...effectPreview.data,
    });
  }

  return decisionDraftBySubmission;
}

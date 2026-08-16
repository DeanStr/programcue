import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { EVALUATION_APPLICANT_MEMBERSHIP_ID } from "~/platform/evaluation/evaluation-session.server";

export type EvaluationApplicantGuidePhase =
  "clean" | "activated" | "draft" | "submitted" | "inactive";

export type EvaluationReviewerGuidePhase =
  | "clean"
  | "invited"
  | "invitation_expired"
  | "accepted"
  | "assigned"
  | "review_draft"
  | "review_submitted"
  | "inactive";

export type EvaluationScenarioGuideState = {
  applicant: {
    phase: EvaluationApplicantGuidePhase;
    draftCount: number;
    submittedCount: number;
  };
  reviewer: {
    phase: EvaluationReviewerGuidePhase;
    assignmentCount: number;
    reviewCount: number;
  };
};

export function evaluationApplicantGuideLabel(
  phase: EvaluationApplicantGuidePhase,
) {
  switch (phase) {
    case "clean":
      return "Clean applicant";
    case "activated":
      return "Activated applicant";
    case "draft":
      return "Applicant with draft";
    case "submitted":
      return "Submitted applicant";
    case "inactive":
      return "Applicant access needs attention";
  }
}

export function evaluationReviewerGuideLabel(
  phase: EvaluationReviewerGuidePhase,
) {
  switch (phase) {
    case "clean":
      return "Clean reviewer";
    case "invited":
      return "Invited reviewer";
    case "invitation_expired":
      return "Reviewer invitation expired";
    case "accepted":
      return "Reviewer with event access";
    case "assigned":
      return "Assigned reviewer";
    case "review_draft":
      return "Reviewer with draft review";
    case "review_submitted":
      return "Reviewer with submitted review";
    case "inactive":
      return "Reviewer state needs attention";
  }
}

type GuideStateRow = {
  applicantMembershipCount: number;
  applicantActivated: number;
  applicantDraftCount: number;
  applicantSubmittedCount: number;
  reviewerMembershipCount: number;
  reviewerPendingMembershipCount: number;
  reviewerExpiredInvitationCount: number;
  reviewerAcceptedMembershipCount: number;
  reviewerAssignmentCount: number;
  reviewerActiveAssignmentCount: number;
  reviewerInProgressAssignmentCount: number;
  reviewerSubmittedAssignmentCount: number;
  reviewerReviewCount: number;
  reviewerDraftReviewCount: number;
  reviewerSubmittedReviewCount: number;
};

export function requireEvaluationGuideCount(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The evaluation guide received an invalid ${field} count.`);
  }
  return value;
}

const GUIDE_STATE_COUNT_FIELDS = [
  ["applicantMembershipCount", "applicant membership"],
  ["applicantActivated", "applicant activation"],
  ["applicantDraftCount", "applicant draft application"],
  ["applicantSubmittedCount", "applicant submitted application"],
  ["reviewerMembershipCount", "reviewer membership"],
  ["reviewerPendingMembershipCount", "reviewer pending invitation"],
  ["reviewerExpiredInvitationCount", "reviewer expired invitation"],
  ["reviewerAcceptedMembershipCount", "reviewer accepted membership"],
  ["reviewerAssignmentCount", "reviewer assignment"],
  ["reviewerActiveAssignmentCount", "reviewer active assignment"],
  ["reviewerInProgressAssignmentCount", "reviewer in-progress assignment"],
  ["reviewerSubmittedAssignmentCount", "reviewer submitted assignment"],
  ["reviewerReviewCount", "reviewer review"],
  ["reviewerDraftReviewCount", "reviewer draft review"],
  ["reviewerSubmittedReviewCount", "reviewer submitted review"],
] as const satisfies ReadonlyArray<readonly [keyof GuideStateRow, string]>;

function validateGuideStateRow(row: GuideStateRow) {
  for (const [field, label] of GUIDE_STATE_COUNT_FIELDS) {
    requireEvaluationGuideCount(row[field], label);
  }
  return row;
}

function applicantPhase(row: GuideStateRow): EvaluationApplicantGuidePhase {
  if (row.applicantSubmittedCount > 0) return "submitted";
  if (row.applicantDraftCount > 0) return "draft";
  if (row.applicantActivated > 0) return "activated";
  if (row.applicantMembershipCount > 0) return "inactive";
  return "clean";
}

function reviewerPhase(row: GuideStateRow): EvaluationReviewerGuidePhase {
  if (
    row.reviewerSubmittedReviewCount > 0 ||
    row.reviewerSubmittedAssignmentCount > 0
  ) {
    return "review_submitted";
  }
  if (
    row.reviewerDraftReviewCount > 0 ||
    row.reviewerInProgressAssignmentCount > 0
  ) {
    return "review_draft";
  }
  if (row.reviewerActiveAssignmentCount > 0) return "assigned";
  if (row.reviewerAcceptedMembershipCount > 0) return "accepted";
  if (row.reviewerPendingMembershipCount > 0) return "invited";
  if (row.reviewerExpiredInvitationCount > 0) return "invitation_expired";
  if (
    row.reviewerMembershipCount > 0 ||
    row.reviewerAssignmentCount > 0 ||
    row.reviewerReviewCount > 0
  ) {
    return "inactive";
  }
  return "clean";
}

export async function readEvaluationScenarioGuideState(
  env: CloudflareEnvironment,
  fixtureGeneration: string,
): Promise<EvaluationScenarioGuideState> {
  const result = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'submitter') AS applicantMembershipCount,
       (SELECT COUNT(*) FROM memberships
         WHERE id = ? AND organisation_id = ? AND event_id = ?
           AND person_id = ? AND role = 'submitter'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
           AND last_operation_id = ?) AS applicantActivated,
       (SELECT COUNT(*) FROM submissions
         WHERE event_id = ? AND submitter_person_id = ?
           AND status = 'draft') AS applicantDraftCount,
       (SELECT COUNT(*) FROM submissions
         WHERE event_id = ? AND submitter_person_id = ?
           AND status <> 'draft') AS applicantSubmittedCount,
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator') AS reviewerMembershipCount,
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator' AND invited_at IS NOT NULL
           AND invitation_expires_at > unixepoch()
           AND accepted_at IS NULL AND revoked_at IS NULL) AS reviewerPendingMembershipCount,
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator' AND invited_at IS NOT NULL
           AND accepted_at IS NULL AND revoked_at IS NULL
           AND (invitation_expires_at IS NULL
                OR invitation_expires_at <= unixepoch())) AS reviewerExpiredInvitationCount,
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator' AND accepted_at IS NOT NULL
           AND revoked_at IS NULL) AS reviewerAcceptedMembershipCount,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?) AS reviewerAssignmentCount,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?
           AND status IN ('assigned','in_progress','reopened')) AS reviewerActiveAssignmentCount,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?
           AND status IN ('in_progress','reopened')) AS reviewerInProgressAssignmentCount,
       (SELECT COUNT(*) FROM evaluator_assignments
         WHERE event_id = ? AND evaluator_person_id = ?
           AND status = 'submitted') AS reviewerSubmittedAssignmentCount,
       (SELECT COUNT(*) FROM reviews review
          JOIN evaluator_assignments assignment
            ON assignment.id = review.assignment_id
           AND assignment.event_id = review.event_id
         WHERE review.event_id = ? AND assignment.evaluator_person_id = ?) AS reviewerReviewCount,
       (SELECT COUNT(*) FROM reviews review
          JOIN evaluator_assignments assignment
            ON assignment.id = review.assignment_id
           AND assignment.event_id = review.event_id
         WHERE review.event_id = ? AND assignment.evaluator_person_id = ?
           AND assignment.status IN ('assigned','in_progress','reopened')
           AND review.status IN ('draft','reopened')) AS reviewerDraftReviewCount,
       (SELECT COUNT(*) FROM reviews review
          JOIN evaluator_assignments assignment
            ON assignment.id = review.assignment_id
           AND assignment.event_id = review.event_id
         WHERE review.event_id = ? AND assignment.evaluator_person_id = ?
           AND assignment.status = 'submitted'
           AND review.status IN ('submitted','locked')) AS reviewerSubmittedReviewCount`,
  )
    .bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      EVALUATION_APPLICANT_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      `evaluation-account:${fixtureGeneration}`,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_reviewer.personId,
    )
    .first<GuideStateRow>();
  if (!result) {
    throw new Error("The evaluation guide could not read scenario state.");
  }
  const row = validateGuideStateRow(result);

  const applicant = {
    phase: applicantPhase(row),
    draftCount: row.applicantDraftCount,
    submittedCount: row.applicantSubmittedCount,
  };
  const reviewer = {
    phase: reviewerPhase(row),
    assignmentCount: row.reviewerAssignmentCount,
    reviewCount: row.reviewerReviewCount,
  };
  return {
    applicant,
    reviewer,
  };
}

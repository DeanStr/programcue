import { Form, Link } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EvaluationPlanState } from "~/components/evaluation-admin-configuration-panels";
import {
  BulkAssignmentDialog,
  RoundAdvancementDialog,
  ModerationDialog,
  ReviewReopenDialog,
  DecisionDialog,
} from "~/components/evaluation-admin-dialogs";

export function EvaluationHeader() {
  const {
    loaderData,
    actionData,
    navigation,
    committedWarning,
    assignmentUndo,
    decisionId,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    moderationSubmissionId,
    setModerationSubmissionId,
    reopenAssignmentId,
    setReopenAssignmentId,
    advanceOpen,
    setAdvanceOpen,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    invitationRole,
    setInvitationRole,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    selected,
    selectedHasCompletedReview,
    activeRound,
    nextRound,
    activeRoundAssignments,
    sessionReviewAssignments,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
    moderationSubmission,
    currentModeration,
    reopenAssignment,
  } = useEvaluationAdminModel();
  return (
    <div className="page-head">
      <div>
        <h1>Evaluation</h1>
        <p>
          Configure review, assign evaluators and release programme decisions.
        </p>
      </div>
      <div className="page-actions">
        <Link className="btn" to="/review/workbench">
          Open reviewer workspace
        </Link>
      </div>
    </div>
  );
}

export function EvaluationFilterNotice() {
  const { loaderData } = useEvaluationAdminModel();
  return loaderData.unassignedOnly ? (
    <div className="validation-item warn card pad mb" role="status">
      <strong>Unassigned proposals</strong>
      <span>
        Showing {loaderData.submissions.length} of{" "}
        {loaderData.totalSubmissionCount} submitted records.{" "}
        <Link to="/admin/review">Clear filter</Link>
      </span>
    </div>
  ) : null;
}

export function EvaluationActionNotice() {
  const { actionData, committedWarning } = useEvaluationAdminModel();
  return actionData &&
    ("error" in actionData || ("ok" in actionData && !actionData.ok)) ? (
    <div
      className={`validation-item ${committedWarning ? "warn" : "error"} mb`}
      role={committedWarning ? "status" : "alert"}
    >
      {"error" in actionData ? actionData.error : actionData.message}
    </div>
  ) : actionData?.message ? (
    <div className="validation-item ok mb" role="status">
      {actionData.message}
    </div>
  ) : null;
}

export function EvaluationAssignmentUndo() {
  const { assignmentUndo } = useEvaluationAdminModel();
  return assignmentUndo ? (
    <div className="validation-item warn mb" role="status">
      <span>
        This assignment change is reversible for five minutes if no review work
        starts.
      </span>
      <Form method="post" className="right">
        <input type="hidden" name="intent" value="undo-assignments" />
        <input
          type="hidden"
          name="operationId"
          value={assignmentUndo.operationId}
        />
        <input type="hidden" name="confirmed" value="true" />
        <button className="btn small" type="submit">
          Undo assignments
        </button>
      </Form>
    </div>
  ) : null;
}

export function EvaluationAdminPage() {
  return (
    <>
      <EvaluationHeader />
      <EvaluationFilterNotice />
      <EvaluationActionNotice />
      <EvaluationAssignmentUndo />
      <EvaluationPlanState />
      <BulkAssignmentDialog />
      <RoundAdvancementDialog />
      <ModerationDialog />
      <ReviewReopenDialog />
      <DecisionDialog />
    </>
  );
}

import { Form, Link } from "react-router";
import { EvaluationPlanState } from "~/components/evaluation-admin-configuration-panels";
import {
  BulkAssignmentDialog,
  DecisionDialog,
  ModerationDialog,
  ReviewReopenDialog,
  RoundAdvancementDialog,
} from "~/components/evaluation-admin-dialogs";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { AdminPageSectionNavigation } from "~/components/ui/admin-page-sections";
import { Button, ButtonLink } from "~/components/ui/button";

export function EvaluationHeader() {
  return (
    <div className="page-head">
      <div>
        <h1>Review &amp; selection</h1>
        <p>
          Configure review, assign evaluators and release programme decisions.
        </p>
      </div>
      <div className="page-actions">
        <ButtonLink to="/review/workbench">Open reviewer workspace</ButtonLink>
      </div>
    </div>
  );
}

export function EvaluationFilterNotice() {
  const { loaderData } = useEvaluationAdminModel();
  return loaderData.reviewFilter ? (
    <div className="validation-item warn card pad mb" role="status">
      <strong>
        {loaderData.unassignedOnly
          ? "Unassigned review targets"
          : "Incomplete review targets"}
      </strong>
      <span>
        {loaderData.unassignedOnly
          ? "Showing targets with no assignments."
          : "Showing targets with at least one assignment and fewer completed reviews than assignments."}{" "}
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
        <Button size="small" type="submit">
          Undo assignments
        </Button>
      </Form>
    </div>
  ) : null;
}

export function EvaluationAdminPage() {
  const { loaderData } = useEvaluationAdminModel();
  return (
    <div className="pc-eval-admin">
      <EvaluationHeader />
      {loaderData.plan ? null : (
        <AdminPageSectionNavigation
          label="Evaluation administration sections"
          links={[{ id: "evaluation-setup", label: "Create plan" }]}
        />
      )}
      <EvaluationFilterNotice />
      <EvaluationActionNotice />
      <EvaluationAssignmentUndo />
      <EvaluationPlanState />
      <BulkAssignmentDialog />
      <RoundAdvancementDialog />
      <ModerationDialog />
      <ReviewReopenDialog />
      <DecisionDialog />
    </div>
  );
}

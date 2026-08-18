import { Form } from "react-router";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { bindEvalDateTime } from "~/components/evaluation-progression-panel";
import { RubricFields } from "~/components/evaluation-rubric-fields";
import { useConfirm } from "~/components/ui/confirm-dialog";

export function EvaluationReviewCyclePanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  const { confirm, dialog } = useConfirm();
  const plan = loaderData.plan;
  const preview = loaderData.reviewCyclePreview;
  if (!plan || !preview || !loaderData.canManageEvaluationAccess) return null;
  const sourceRound = plan.rounds.at(-1);
  if (!sourceRound) {
    throw new Error(
      "The current evaluation plan has no round to supply a new-cycle rubric.",
    );
  }
  const runningAssessmentCount = Number(
    preview.runningAssessmentOperationCount,
  );
  const waitingForAiAssessments = runningAssessmentCount > 0;
  return (
    <>
      {dialog}
      <details className="card pad mb pc-disclosure pc-eval-cycle">
        <summary>Start a new review cycle</summary>
        <div className="stack mt">
          <p className="subtle">
            Archive this plan and its rounds as historical evidence, then start
            a fresh active round. Existing decisions, reviews and unfinished
            work are retained unchanged; reviewer pools and assignments are not
            copied into the new cycle.
          </p>
          {waitingForAiAssessments ? (
            <div className="validation-item warn" role="status">
              <strong>
                Wait for {runningAssessmentCount} AI review assessment
                {runningAssessmentCount === 1 ? "" : "s"}
              </strong>
              <span>
                Finish or resume the running assessment
                {runningAssessmentCount === 1 ? "" : "s"} from the submission
                results before archiving this review cycle.
              </span>
            </div>
          ) : null}
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="start-review-cycle" />
            <input type="hidden" name="currentPlanId" value={plan.id} />
            <input
              type="hidden"
              name="currentPlanRevision"
              value={plan.revision}
            />
            <input
              type="hidden"
              name="expectedRunningAssessmentOperationCount"
              value={runningAssessmentCount}
            />
            <input
              type="hidden"
              name="expectedUnfinishedAssignmentCount"
              value={preview.unfinishedAssignmentCount}
            />
            <input
              type="hidden"
              name="expectedUnfinishedReviewCount"
              value={preview.unfinishedReviewCount}
            />
            <input type="hidden" name="confirmed" value="true" />
            <div className="grid grid-2">
              <label className="label">
                New plan name
                <input
                  className="input"
                  name="planName"
                  defaultValue={`${plan.name} · next cycle`}
                  required
                />
              </label>
              <label className="label">
                First round name
                <input
                  className="input"
                  name="roundName"
                  defaultValue="Initial review"
                  required
                />
              </label>
            </div>
            <div className="grid grid-2">
              <label className="label">
                Opens ({loaderData.eventTimezone})
                <input
                  className="input pc-eval-datetime"
                  type="datetime-local"
                  name="roundOpensAt"
                  data-empty=""
                  onInput={bindEvalDateTime}
                />
              </label>
              <label className="label">
                Closes ({loaderData.eventTimezone})
                <input
                  className="input pc-eval-datetime"
                  type="datetime-local"
                  name="roundClosesAt"
                  data-empty=""
                  onInput={bindEvalDateTime}
                />
              </label>
            </div>
            <label className="validation-item">
              <input type="checkbox" name="anonymous" value="true" />
              <span>
                <strong>Hide author and co-author identity</strong>
                Reviewers in this round will not see who submitted.
              </span>
            </label>
            <div className="validation-item info">
              <strong>Rubric source</strong>
              <span>
                Prefilled from Round {sourceRound.roundNumber} —{" "}
                {sourceRound.name}
                {" · "}Scorecard v{sourceRound.scorecardVersion}. Review and
                edit every criterion before starting the new cycle.
              </span>
            </div>
            <RubricFields criteria={sourceRound.criteria} />
            <button
              className="btn danger"
              type="button"
              disabled={navigation.state !== "idle" || waitingForAiAssessments}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form) {
                  throw new Error("The new review cycle form is missing.");
                }
                if (!form.reportValidity()) return;
                confirm(
                  {
                    title: "Start a new review cycle?",
                    description:
                      "The current plan leaves the active reviewer queues and becomes read-only history. Published decisions and submission states are not reopened or changed.",
                    records: [
                      `${plan.name} · ${plan.rounds.length} round${plan.rounds.length === 1 ? "" : "s"}`,
                      `Rubric copied from Round ${sourceRound.roundNumber} — ${sourceRound.name} · Scorecard v${sourceRound.scorecardVersion}`,
                      `${preview.unfinishedAssignmentCount} unfinished assignment${preview.unfinishedAssignmentCount === 1 ? "" : "s"}`,
                      `${preview.unfinishedReviewCount} saved unfinished review${preview.unfinishedReviewCount === 1 ? "" : "s"}`,
                    ],
                    confirmLabel: "Start new cycle",
                    tone: "danger",
                  },
                  () => form.requestSubmit(),
                );
              }}
            >
              Review and start new cycle
            </button>
          </Form>
        </div>
      </details>
    </>
  );
}

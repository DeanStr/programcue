import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

export function EvaluationMetrics() {
  const { loaderData } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <div className="pc-eval-metrics">
      <section className="pc-eval-metric">
        <span className="label">Plan</span>
        <strong className="value">{plan.name}</strong>
      </section>
      <section className="pc-eval-metric">
        <span className="label">Rounds</span>
        <strong className="value pc-num">{plan.rounds.length}</strong>
      </section>
      <section className="pc-eval-metric">
        <span className="label">Evaluators</span>
        <strong className="value pc-num">{loaderData.evaluators.length}</strong>
      </section>
      <section className="pc-eval-metric">
        <span className="label">Review targets</span>
        <strong className="value pc-num">
          {loaderData.reviewTargetSummary.total}
        </strong>
        <span className="detail">
          {loaderData.reviewTargetSummary.proposals} proposal
          {loaderData.reviewTargetSummary.proposals === 1 ? "" : "s"} ·{" "}
          {loaderData.reviewTargetSummary.sessions} session
          {loaderData.reviewTargetSummary.sessions === 1 ? "" : "s"}
        </span>
      </section>
    </div>
  );
}

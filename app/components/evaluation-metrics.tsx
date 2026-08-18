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
        <span className="label">Submissions</span>
        <strong className="value pc-num">
          {loaderData.submissions.length}
        </strong>
      </section>
    </div>
  );
}

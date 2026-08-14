import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

export function EvaluationMetrics() {
  const { loaderData } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <div className="grid grid-4 mb">
      <section className="card metric">
        <span className="label">Plan</span>
        <strong className="value" style={{ fontSize: 18 }}>
          {plan.name}
        </strong>
      </section>
      <section className="card metric">
        <span className="label">Rounds</span>
        <strong className="value">{plan.rounds.length}</strong>
      </section>
      <section className="card metric">
        <span className="label">Evaluators</span>
        <strong className="value">{loaderData.evaluators.length}</strong>
      </section>
      <section className="card metric">
        <span className="label">Submissions</span>
        <strong className="value">{loaderData.submissions.length}</strong>
      </section>
    </div>
  );
}

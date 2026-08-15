import { Form } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EmptyState } from "~/components/ui/states";

export function EvaluationUnifiedResults() {
  const { loaderData } = useEvaluationAdminModel();
  return (
    <section className="card pad">
      <div className="card-title">
        <div>
          <h2>All review targets</h2>
          <p className="subtle">
            Proposals and sessions share one round-scoped ranking. Target type
            remains explicit; scores are never compared across different rounds.
          </p>
        </div>
        <div className="page-actions right">
          <Form method="get" className="inline-form">
            {loaderData.unassignedOnly ? (
              <input type="hidden" name="filter" value="unassigned" />
            ) : null}
            <label className="label">
              Results round
              <select
                className="select"
                name="resultsRound"
                defaultValue={loaderData.resultsRoundId ?? ""}
              >
                {loaderData.plan?.rounds.map((round) => (
                  <option key={round.id} value={round.id}>
                    {round.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Sort results
              <select
                className="select"
                name="sort"
                defaultValue={loaderData.resultSort}
              >
                <option value="score_desc">Score, high to low</option>
                <option value="score_asc">Score, low to high</option>
                <option value="completion_desc">Review completion</option>
                <option value="title_asc">Title</option>
              </select>
            </label>
            <button className="btn small">Apply</button>
          </Form>
          {loaderData.resultsRoundId ? (
            <Form
              method="post"
              action={`/admin/review/results.csv?round=${encodeURIComponent(loaderData.resultsRoundId)}`}
              reloadDocument
              onSubmit={(event) => {
                const intent =
                  event.currentTarget.elements.namedItem("idempotencyKey");
                if (!(intent instanceof HTMLInputElement)) {
                  event.preventDefault();
                  throw new Error(
                    "The review-results export intent control is missing.",
                  );
                }
                intent.value = crypto.randomUUID();
              }}
            >
              <input
                type="hidden"
                name="idempotencyKey"
                defaultValue={loaderData.resultsExportIntent}
              />
              <button className="btn small">
                Download proposal results CSV
              </button>
            </Form>
          ) : null}
        </div>
      </div>
      {loaderData.results.length ? (
        <div
          className="table-wrap pc-responsive-table-wrap"
          role="region"
          aria-label="Unified evaluation results"
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.results.map((result) => (
                <tr key={`${result.targetType}:${result.id}`}>
                  <td className="pc-record-primary-cell" data-label="Target">
                    <div className="pc-record-stack">
                      <strong>{result.title}</strong>
                      <small className="subtle">{result.reference}</small>
                    </div>
                  </td>
                  <td data-label="Type">
                    <span className="status info">{result.targetType}</span>
                  </td>
                  <td data-label="State">
                    {result.state.replaceAll("_", " ")}
                  </td>
                  <td data-label="Reviews">
                    {result.completedReviewCount} / {result.assignmentCount}
                  </td>
                  <td data-label="Average">
                    {result.averageScore === null
                      ? "—"
                      : Number(result.averageScore).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No review targets"
          description="Assign a proposal or session in this round to start collecting results."
        />
      )}
    </section>
  );
}

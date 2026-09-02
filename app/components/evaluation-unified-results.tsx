import { useSearchParams } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EvaluationResultRow } from "~/components/evaluation-result-row";
import { EvaluationResultsToolbar } from "~/components/evaluation-results-toolbar";
import { ButtonLink } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";

export function EvaluationUnifiedResults() {
  const { loaderData } = useEvaluationAdminModel();
  const [searchParams] = useSearchParams();

  function pageHref(page: number) {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    next.set("view", "results");
    return `?${next.toString()}#evaluation-results`;
  }

  return (
    <section className="card pad pc-eval-results">
      <div className="card-title">
        <div>
          <h2>Unified evaluation results</h2>
        </div>
      </div>
      <EvaluationResultsToolbar />
      {loaderData.results.length ? (
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Unified evaluation results"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table pc-eval-table">
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Coverage</th>
                <th scope="col">Scores</th>
                <th scope="col">Recommendations</th>
                <th scope="col">Flags</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.results.map((result) => (
                <EvaluationResultRow
                  key={`${result.targetType}:${result.id}`}
                  result={result}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState
          title="No matching review targets"
          description="Change the preset or assign reviews in this round."
        />
      )}
      {loaderData.resultsPageCount > 1 ? (
        <nav className="page-actions mt" aria-label="Evaluation results pages">
          {loaderData.resultsPage > 1 ? (
            <ButtonLink size="small" to={pageHref(loaderData.resultsPage - 1)}>
              Previous
            </ButtonLink>
          ) : null}
          {loaderData.resultsPage < loaderData.resultsPageCount ? (
            <ButtonLink size="small" to={pageHref(loaderData.resultsPage + 1)}>
              Next
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

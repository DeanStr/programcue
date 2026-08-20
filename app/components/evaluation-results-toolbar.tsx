import { useSyncExternalStore } from "react";
import { Form } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

function subscribeDesktopFilters(onChange: () => void) {
  const media = window.matchMedia("(min-width: 761px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function EvaluationResultsToolbar() {
  const { loaderData } = useEvaluationAdminModel();
  const desktopFilters = useSyncExternalStore(
    subscribeDesktopFilters,
    () => window.matchMedia("(min-width: 761px)").matches,
    () => true,
  );

  return (
    <>
      <details
        className="pc-eval-filter-disclosure"
        open={desktopFilters ? true : undefined}
      >
        <summary>Filter and sort</summary>
        <Form method="get" className="inline-form pc-eval-toolbar">
          <input type="hidden" name="view" value="results" />
          <label className="label">
            View preset
            <select
              className="select"
              name="preset"
              defaultValue={loaderData.resultPreset}
            >
              <option value="all">All targets</option>
              <option value="coverage">Coverage</option>
              <option value="decision_ready">Decision-ready</option>
              <option value="moderation">Moderation</option>
            </select>
          </label>
          <label className="label">
            Coverage filter
            <select
              className="select"
              name="filter"
              defaultValue={loaderData.reviewFilter ?? ""}
            >
              <option value="">Any coverage</option>
              <option value="incomplete">Incomplete reviews</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
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
          <button type="submit" className="pc-eval-text-action">
            Apply
          </button>
        </Form>
      </details>
      <div className="help pc-eval-results-meta">
        Showing {loaderData.results.length} of {loaderData.resultsTotal}{" "}
        matching targets · page {loaderData.resultsPage} of{" "}
        {loaderData.resultsPageCount}
        {loaderData.resultsRoundId ? (
          <>
            {" · "}
            <Form
              method="post"
              className="pc-eval-inline-export"
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
              <button
                type="submit"
                className="pc-eval-text-action"
                aria-label="Download proposal results CSV"
              >
                Export CSV
              </button>
            </Form>
          </>
        ) : null}
      </div>
    </>
  );
}

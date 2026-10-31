import { useSyncExternalStore } from "react";
import { Form } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { useLiveFilters } from "~/components/use-live-filters";

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
  const liveFilters = useLiveFilters({
    preset: loaderData.resultPreset,
    filter: loaderData.reviewFilter ?? "",
    resultsRound: loaderData.resultsRoundId ?? "",
    sort: loaderData.resultSort,
  });

  return (
    <>
      <details
        className="pc-eval-filter-disclosure"
        open={desktopFilters ? true : undefined}
      >
        <summary>Filter and sort</summary>
        <Form {...liveFilters.form} className="inline-form pc-eval-toolbar">
          <input type="hidden" name="view" value="results" />
          <label className="label">
            View preset
            <select className="select" {...liveFilters.field("preset")}>
              <option value="all">All targets</option>
              <option value="coverage">Coverage</option>
              <option value="decision_ready">Decision-ready</option>
              <option value="moderation">Moderation</option>
            </select>
          </label>
          <label className="label">
            Coverage filter
            <select className="select" {...liveFilters.field("filter")}>
              <option value="">Any coverage</option>
              <option value="incomplete">Incomplete reviews</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label className="label">
            Results round
            <select className="select" {...liveFilters.field("resultsRound")}>
              {loaderData.plan?.rounds.map((round) => (
                <option key={round.id} value={round.id}>
                  {round.name}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Sort results
            <select className="select" {...liveFilters.field("sort")}>
              <option value="score_desc">Score, high to low</option>
              <option value="score_asc">Score, low to high</option>
              <option value="completion_desc">Review completion</option>
              <option value="title_asc">Title</option>
            </select>
          </label>
        </Form>
      </details>
      <div className="help pc-eval-results-meta">
        <span aria-live="polite" aria-atomic="true">
          Showing {loaderData.results.length} of {loaderData.resultsTotal}{" "}
          matching targets · page {loaderData.resultsPage} of{" "}
          {loaderData.resultsPageCount}
        </span>
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

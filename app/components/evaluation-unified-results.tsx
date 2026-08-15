import { Form, Link, useSearchParams } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { EventDateTime } from "~/components/ui/event-date-time";
import { EmptyState } from "~/components/ui/states";

const recommendationOrder = [
  "accept",
  "minor_changes",
  "conditional_accept",
  "waitlist",
  "reject",
];

function humanise(value: string) {
  return value.replaceAll("_", " ");
}

export function EvaluationUnifiedResults() {
  const {
    loaderData,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    setModerationSubmissionId,
  } = useEvaluationAdminModel();
  const [searchParams] = useSearchParams();

  function pageHref(page: number) {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    return `?${next.toString()}#evaluation-results`;
  }

  return (
    <section className="card pad">
      <div className="card-title">
        <div>
          <h2>Chair results workbench</h2>
          <p className="subtle">
            Proposals and sessions share one selected-round view. Coverage and
            moderation flags use visible counts and ranges, never an opaque
            disagreement score.
          </p>
        </div>
        <div className="page-actions right">
          <Form method="get" className="inline-form">
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
      <p className="help">
        Showing {loaderData.results.length} of {loaderData.resultsTotal}{" "}
        matching targets · page {loaderData.resultsPage} of{" "}
        {loaderData.resultsPageCount}. Decision-ready means every active,
        non-recused assignment is complete, at least one review exists and
        recommendations are not split.
      </p>
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
                <th scope="col">Coverage</th>
                <th scope="col">Scores</th>
                <th scope="col">Recommendations</th>
                <th scope="col">Flags</th>
                <th scope="col">Actions and detail</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.results.map((result) => {
                const recommendationEntries = recommendationOrder
                  .map(
                    (recommendation) =>
                      [
                        recommendation,
                        result.recommendations[recommendation] ?? 0,
                      ] as const,
                  )
                  .filter(([, count]) => count > 0);
                const focusName =
                  result.targetType === "proposal" ? "submission" : "session";
                return (
                  <tr key={`${result.targetType}:${result.id}`}>
                    <td className="pc-record-primary-cell" data-label="Target">
                      <div className="pc-record-stack">
                        <strong>{result.title}</strong>
                        <small className="subtle">
                          {result.reference} · {result.targetType} ·{" "}
                          {humanise(result.state)}
                        </small>
                      </div>
                    </td>
                    <td data-label="Coverage">
                      {result.completedReviewCount} / {result.assignmentCount}
                      {result.recusedCount ? (
                        <small className="subtle">
                          {result.recusedCount} recusal
                          {result.recusedCount === 1 ? "" : "s"}
                        </small>
                      ) : null}
                    </td>
                    <td data-label="Scores">
                      <strong>
                        {result.averageScore === null
                          ? "—"
                          : Number(result.averageScore).toFixed(2)}
                      </strong>
                      {result.minimumScore !== null &&
                      result.maximumScore !== null ? (
                        <small className="subtle">
                          Range {Number(result.minimumScore).toFixed(2)}–
                          {Number(result.maximumScore).toFixed(2)}
                        </small>
                      ) : null}
                    </td>
                    <td data-label="Recommendations">
                      {recommendationEntries.length
                        ? recommendationEntries
                            .map(
                              ([name, count]) => `${humanise(name)} ${count}`,
                            )
                            .join(" · ")
                        : "—"}
                    </td>
                    <td data-label="Flags">
                      <div className="stack">
                        {result.assignmentCount === 0 ? (
                          <span className="status warning">Unassigned</span>
                        ) : null}
                        {result.incomplete ? (
                          <span className="status warning">Incomplete</span>
                        ) : null}
                        {result.recusedCount ? (
                          <span className="status warning">
                            Recusal reduced coverage
                          </span>
                        ) : null}
                        {result.mixedRecommendations ? (
                          <span className="status warning">
                            Mixed recommendations
                          </span>
                        ) : null}
                        {result.decisionReady ? (
                          <span className="status success">Decision-ready</span>
                        ) : null}
                        {result.moderation?.status === "draft" ? (
                          <span className="status info">Moderation draft</span>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Actions and detail">
                      <div className="page-actions">
                        <Link
                          className="btn small"
                          to={`?resultsRound=${encodeURIComponent(loaderData.resultsRoundId ?? "")}&${focusName}=${encodeURIComponent(result.id)}#evaluation-${result.targetType === "proposal" ? "proposals" : "sessions"}`}
                        >
                          Assign / discuss
                        </Link>
                        {result.targetType === "proposal" ? (
                          <>
                            <button
                              className="btn small"
                              type="button"
                              onClick={() =>
                                setModerationSubmissionId(result.id)
                              }
                            >
                              Moderate
                            </button>
                            <button
                              className="btn small"
                              type="button"
                              onClick={() => {
                                setNoReviewOverrideConfirmed(false);
                                setDecisionId(result.id);
                              }}
                            >
                              Decide
                            </button>
                          </>
                        ) : null}
                      </div>
                      <details>
                        <summary>Review and decision detail</summary>
                        <div className="stack mt">
                          {result.reviews.length ? (
                            result.reviews.map((review) => (
                              <article
                                className="card pad"
                                key={review.assignmentId}
                              >
                                <strong>{review.evaluatorName}</strong>
                                <p className="help">
                                  {review.weightedScore === null
                                    ? "Unscored"
                                    : `${Number(review.weightedScore).toFixed(2)} / 5`}
                                  {review.recommendation
                                    ? ` · ${humanise(review.recommendation)}`
                                    : ""}
                                </p>
                                {Object.entries(review.scores).length ? (
                                  <dl>
                                    {Object.entries(review.scores).map(
                                      ([criterionId, value]) => (
                                        <div key={criterionId}>
                                          <dt>
                                            {loaderData.resultCriterionNames[
                                              criterionId
                                            ] ?? criterionId}
                                          </dt>
                                          <dd>
                                            {typeof value === "boolean"
                                              ? value
                                                ? "Yes"
                                                : "No"
                                              : String(value)}
                                          </dd>
                                        </div>
                                      ),
                                    )}
                                  </dl>
                                ) : null}
                                {review.privateNotes ? (
                                  <p>Private notes: {review.privateNotes}</p>
                                ) : null}
                                {review.submitterFeedback ? (
                                  <p>
                                    Applicant feedback:{" "}
                                    {review.submitterFeedback}
                                  </p>
                                ) : null}
                                <details className="pc-disclosure">
                                  <summary>
                                    {review.history.length} saved review
                                    revisions
                                  </summary>
                                  <div className="stack mt">
                                    {review.history.map((revision) => {
                                      const criterionNames = new Map(
                                        revision.criteria?.map((criterion) => [
                                          criterion.id,
                                          criterion.name,
                                        ]) ?? [],
                                      );
                                      return (
                                        <article
                                          className="card pad"
                                          key={revision.id}
                                        >
                                          <strong>
                                            Revision {revision.revisionNumber} ·{" "}
                                            {humanise(revision.saveKind)}
                                          </strong>
                                          <p className="help">
                                            {revision.savedByName} ·{" "}
                                            <EventDateTime
                                              epochSeconds={revision.createdAt}
                                              timeZone={
                                                loaderData.eventTimezone
                                              }
                                            />
                                            {revision.scorecardId &&
                                            revision.scorecardVersion
                                              ? ` · scorecard ${revision.scorecardId} v${revision.scorecardVersion}`
                                              : " · pre-contract scorecard labels unavailable"}
                                          </p>
                                          {Object.entries(revision.scores)
                                            .length ? (
                                            <dl>
                                              {Object.entries(
                                                revision.scores,
                                              ).map(([criterionId, value]) => (
                                                <div key={criterionId}>
                                                  <dt>
                                                    {revision.criteria === null
                                                      ? criterionId
                                                      : criterionNames.get(
                                                          criterionId,
                                                        )!}
                                                  </dt>
                                                  <dd>
                                                    {typeof value === "boolean"
                                                      ? value
                                                        ? "Yes"
                                                        : "No"
                                                      : String(value)}
                                                  </dd>
                                                </div>
                                              ))}
                                            </dl>
                                          ) : null}
                                          {revision.content.privateNotes ? (
                                            <p>
                                              Private notes:{" "}
                                              {revision.content.privateNotes}
                                            </p>
                                          ) : null}
                                          {revision.content
                                            .submitterFeedback ? (
                                            <p>
                                              Applicant feedback:{" "}
                                              {
                                                revision.content
                                                  .submitterFeedback
                                              }
                                            </p>
                                          ) : null}
                                          {revision.content.reopenReason ? (
                                            <p>
                                              Reopen reason:{" "}
                                              {revision.content.reopenReason}
                                            </p>
                                          ) : null}
                                        </article>
                                      );
                                    })}
                                  </div>
                                </details>
                              </article>
                            ))
                          ) : (
                            <p className="help">No submitted reviews.</p>
                          )}
                          <div>
                            <strong>Decision history</strong>
                            {result.decisionHistory.length ? (
                              <ul>
                                {result.decisionHistory.map((decision) => (
                                  <li key={decision.id}>
                                    Revision {decision.revisionNumber}:{" "}
                                    {humanise(decision.decision)} (
                                    {humanise(decision.status)}) by{" "}
                                    {decision.decidedByName} on{" "}
                                    <EventDateTime
                                      epochSeconds={decision.decidedAt}
                                      timeZone={loaderData.eventTimezone}
                                    />
                                    {decision.rationale
                                      ? ` · ${decision.rationale}`
                                      : ""}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="help">
                                No decision history for this round.
                              </p>
                            )}
                          </div>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No matching review targets"
          description="Change the preset or assign reviews in this round."
        />
      )}
      {loaderData.resultsPageCount > 1 ? (
        <nav className="page-actions mt" aria-label="Evaluation results pages">
          {loaderData.resultsPage > 1 ? (
            <Link
              className="btn small"
              to={pageHref(loaderData.resultsPage - 1)}
            >
              Previous
            </Link>
          ) : null}
          {loaderData.resultsPage < loaderData.resultsPageCount ? (
            <Link
              className="btn small"
              to={pageHref(loaderData.resultsPage + 1)}
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

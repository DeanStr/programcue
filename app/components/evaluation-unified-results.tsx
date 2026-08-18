import { useSyncExternalStore } from "react";
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

function providerStateLabel(status: string) {
  return status === "sent" ? "Provider accepted" : humanise(status);
}

function subscribeDesktopFilters(onChange: () => void) {
  const media = window.matchMedia("(min-width: 761px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function EvaluationUnifiedResults() {
  const {
    loaderData,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    setModerationSubmissionId,
  } = useEvaluationAdminModel();
  const [searchParams] = useSearchParams();
  const desktopFilters = useSyncExternalStore(
    subscribeDesktopFilters,
    () => window.matchMedia("(min-width: 761px)").matches,
    () => true,
  );

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
                      <div className="pc-eval-flags">
                        {result.assignmentCount === 0 ? (
                          <span className="pc-eval-flag is-warn">
                            Unassigned
                          </span>
                        ) : null}
                        {result.incomplete ? (
                          <span className="pc-eval-flag is-warn">
                            Incomplete
                          </span>
                        ) : null}
                        {result.recusedCount ? (
                          <span className="pc-eval-flag is-warn">
                            Recusal reduced coverage
                          </span>
                        ) : null}
                        {result.mixedRecommendations ? (
                          <span className="pc-eval-flag is-warn">
                            Mixed recommendations
                          </span>
                        ) : null}
                        {result.decisionReady ? (
                          <span className="pc-eval-flag is-ready">
                            Decision-ready
                          </span>
                        ) : null}
                        {result.moderation?.status === "draft" ? (
                          <span className="pc-eval-flag is-info">
                            Moderation draft
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Actions" className="pc-eval-overflow-cell">
                      {result.targetType === "proposal" ? (
                        <button
                          className="pc-eval-text-action is-primary"
                          type="button"
                          onClick={() => {
                            setNoReviewOverrideConfirmed(false);
                            setDecisionId(result.id);
                          }}
                        >
                          Decide
                        </button>
                      ) : (
                        <Link
                          className="pc-eval-text-action is-primary"
                          to={`?resultsRound=${encodeURIComponent(loaderData.resultsRoundId ?? "")}&${focusName}=${encodeURIComponent(result.id)}&view=assignments#evaluation-assignments`}
                        >
                          Assign
                        </Link>
                      )}
                      <details className="pc-eval-overflow">
                        <summary
                          aria-label={`More actions for ${result.title}`}
                        >
                          ⋯
                        </summary>
                        <div className="pc-eval-overflow-menu">
                          {result.targetType === "proposal" ? (
                            <Link
                              className="pc-eval-text-action"
                              to={`?resultsRound=${encodeURIComponent(loaderData.resultsRoundId ?? "")}&${focusName}=${encodeURIComponent(result.id)}&view=assignments#evaluation-assignments`}
                            >
                              Assign
                            </Link>
                          ) : null}
                          {result.targetType === "proposal" ? (
                            <button
                              className="pc-eval-text-action"
                              type="button"
                              onClick={() =>
                                setModerationSubmissionId(result.id)
                              }
                            >
                              Moderate
                            </button>
                          ) : null}
                        </div>
                      </details>
                      <details className="pc-eval-row-detail">
                        <summary>Review and decision detail</summary>
                        <div className="stack mt">
                          <article className="card pad">
                            <strong>Human review aggregate · canonical</strong>
                            <p>
                              {result.averageScore === null
                                ? "No scored human reviews."
                                : `${Number(result.averageScore).toFixed(2)} / 5 from ${result.completedReviewCount} completed human review${result.completedReviewCount === 1 ? "" : "s"}.`}
                            </p>
                            <p className="help">
                              This is the score used for review coverage,
                              disagreement, sorting and decision readiness.
                            </p>
                          </article>
                          {result.aiAssessment ? (
                            <>
                              <article className="card pad">
                                <strong>AI advisory · immutable</strong>
                                <p>
                                  <strong>
                                    {result.aiAssessment.score.toFixed(1)} / 5
                                  </strong>
                                </p>
                                <p>{result.aiAssessment.rationale}</p>
                                <p className="help">
                                  {result.aiAssessment.providerLabel} ·{" "}
                                  {result.aiAssessment.model} · submission
                                  revision{" "}
                                  {result.aiAssessment
                                    .submissionRevisionNumber ??
                                    "legacy source"}{" "}
                                  · generated{" "}
                                  <EventDateTime
                                    epochSeconds={
                                      result.aiAssessment.generatedAt
                                    }
                                    timeZone={loaderData.eventTimezone}
                                  />
                                </p>
                                {result.aiAssessment.sourceSnapshotSha256 ? (
                                  <p className="help">
                                    Submitted snapshot SHA-256:{" "}
                                    {result.aiAssessment.sourceSnapshotSha256}
                                  </p>
                                ) : null}
                              </article>
                              <article className="card pad">
                                <strong>
                                  Human assessment of the AI advisory ·
                                  non-canonical
                                </strong>
                                {result.aiAssessment.overridden ? (
                                  <>
                                    <p>
                                      <strong>
                                        {result.aiAssessment.overrideScore.toFixed(
                                          1,
                                        )}{" "}
                                        / 5
                                      </strong>{" "}
                                      · {result.aiAssessment.overrideByName}
                                    </p>
                                    <p>
                                      {result.aiAssessment.overrideRationale}
                                    </p>
                                    <p className="help">
                                      Recorded{" "}
                                      <EventDateTime
                                        epochSeconds={
                                          result.aiAssessment.overrideAt
                                        }
                                        timeZone={loaderData.eventTimezone}
                                      />
                                    </p>
                                  </>
                                ) : (
                                  <p className="help">
                                    No authorised human assessment has been
                                    recorded for this advisory.
                                  </p>
                                )}
                                <p className="help">
                                  Does not affect review averages, coverage,
                                  disagreement, sorting, or decision readiness.
                                </p>
                                {loaderData.canAssessAiAdvisories ? (
                                  <Form method="post" className="stack mt">
                                    <input
                                      type="hidden"
                                      name="intent"
                                      value="override-ai-review-assessment"
                                    />
                                    <input
                                      type="hidden"
                                      name="assessmentId"
                                      value={result.aiAssessment.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="expectedRevision"
                                      value={result.aiAssessment.revision}
                                    />
                                    <label className="label">
                                      Human assessment score
                                      <input
                                        className="input"
                                        name="score"
                                        type="number"
                                        min="1"
                                        max="5"
                                        step="0.1"
                                        defaultValue={
                                          result.aiAssessment.overrideScore ??
                                          result.aiAssessment.score
                                        }
                                        required
                                      />
                                    </label>
                                    <label className="label">
                                      Assessment rationale
                                      <textarea
                                        className="textarea"
                                        name="rationale"
                                        minLength={10}
                                        maxLength={2000}
                                        defaultValue={
                                          result.aiAssessment
                                            .overrideRationale ?? ""
                                        }
                                        required
                                      />
                                    </label>
                                    <label className="speaker-confirm">
                                      <input
                                        type="checkbox"
                                        name="confirmed"
                                        value="true"
                                        required
                                      />
                                      Save this as a separate, non-canonical
                                      human assessment without altering the AI
                                      artifact.
                                    </label>
                                    <button type="submit" className="btn small">
                                      Save human assessment
                                    </button>
                                  </Form>
                                ) : null}
                              </article>
                            </>
                          ) : null}
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
                                                        )}
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
                                    {decision.publishedAt !== null &&
                                    [
                                      "published",
                                      "superseded",
                                      "revoked",
                                    ].includes(decision.status) ? (
                                      <div className="card pad mt">
                                        <strong>
                                          Decision notification evidence
                                        </strong>
                                        {decision.notificationEvidenceState ===
                                        "available" ? (
                                          <dl>
                                            <div>
                                              <dt>Decision</dt>
                                              <dd>
                                                {humanise(decision.decision)}
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Recipient</dt>
                                              <dd>
                                                {decision.recipientName}{" "}
                                                {`<${decision.recipientAddress}>`}
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Template</dt>
                                              <dd>
                                                {decision.templateName} v
                                                {decision.templateVersionNumber}
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Rendered subject</dt>
                                              <dd>
                                                {decision.renderedSubject}
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Queue operation</dt>
                                              <dd>
                                                <Link
                                                  to={`/admin/operations?operation=${encodeURIComponent(decision.notificationOperationId)}`}
                                                >
                                                  {
                                                    decision.notificationOperationStatus
                                                  }
                                                </Link>{" "}
                                                <code>
                                                  {
                                                    decision.notificationOperationId
                                                  }
                                                </code>
                                                {decision.notificationOperationError
                                                  ? ` · ${decision.notificationOperationError}`
                                                  : ""}
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Communication</dt>
                                              <dd>
                                                {providerStateLabel(
                                                  decision.communicationStatus,
                                                )}{" "}
                                                <code>
                                                  {decision.communicationId}
                                                </code>
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Recipient delivery</dt>
                                              <dd>
                                                {providerStateLabel(
                                                  decision.deliveryStatus,
                                                )}{" "}
                                                via {decision.deliveryProvider}{" "}
                                                <code>
                                                  {decision.deliveryId}
                                                </code>
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>
                                                Rendered template body SHA-256
                                              </dt>
                                              <dd>
                                                <code>
                                                  {decision.renderedBodySha256}
                                                </code>
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Delivery state updated</dt>
                                              <dd>
                                                <EventDateTime
                                                  epochSeconds={
                                                    decision.deliveryUpdatedAt
                                                  }
                                                  timeZone={
                                                    loaderData.eventTimezone
                                                  }
                                                />
                                              </dd>
                                            </div>
                                            <div>
                                              <dt>Sender</dt>
                                              <dd>
                                                {decision.senderFromName}{" "}
                                                {`<${decision.senderFromEmail}>`}
                                              </dd>
                                            </div>
                                            {decision.failureMessage ? (
                                              <div>
                                                <dt>Provider failure</dt>
                                                <dd>
                                                  {decision.failureCode
                                                    ? `${decision.failureCode}: `
                                                    : ""}
                                                  {decision.failureMessage}
                                                </dd>
                                              </div>
                                            ) : null}
                                          </dl>
                                        ) : decision.notificationEvidenceState ===
                                          "retained" ? (
                                          <>
                                            <dl>
                                              <div>
                                                <dt>Queue operation</dt>
                                                <dd>
                                                  <Link
                                                    to={`/admin/operations?operation=${encodeURIComponent(decision.notificationOperationId)}`}
                                                  >
                                                    {
                                                      decision.notificationOperationStatus
                                                    }
                                                  </Link>{" "}
                                                  <code>
                                                    {
                                                      decision.notificationOperationId
                                                    }
                                                  </code>
                                                </dd>
                                              </div>
                                              <div>
                                                <dt>Communication</dt>
                                                <dd>
                                                  {providerStateLabel(
                                                    decision.communicationStatus,
                                                  )}{" "}
                                                  <code>
                                                    {decision.communicationId}
                                                  </code>
                                                </dd>
                                              </div>
                                              <div>
                                                <dt>Recipient delivery</dt>
                                                <dd>
                                                  {providerStateLabel(
                                                    decision.deliveryStatus,
                                                  )}{" "}
                                                  <code>
                                                    {decision.deliveryId}
                                                  </code>
                                                </dd>
                                              </div>
                                              <div>
                                                <dt>Delivery state updated</dt>
                                                <dd>
                                                  <EventDateTime
                                                    epochSeconds={
                                                      decision.deliveryUpdatedAt
                                                    }
                                                    timeZone={
                                                      loaderData.eventTimezone
                                                    }
                                                  />
                                                </dd>
                                              </div>
                                            </dl>
                                            <p className="help">
                                              Recipient and message evidence was
                                              redacted when participant
                                              retention completed.
                                            </p>
                                          </>
                                        ) : (
                                          <p className="help">
                                            Pre-migration released decision:
                                            exact linked recipient delivery
                                            evidence was never captured.
                                          </p>
                                        )}
                                        <p className="help">
                                          Queue acceptance is not proof of
                                          delivery. Message bodies are not
                                          shown.
                                        </p>
                                      </div>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="help">
                                No decision history for this round.
                              </p>
                            )}
                            {(() => {
                              const releasedDecision =
                                result.decisionHistory.find(
                                  (decision) => decision.status === "published",
                                );
                              if (
                                !releasedDecision ||
                                releasedDecision.decision === "accepted" ||
                                !loaderData.canManageEvaluationAccess
                              ) {
                                return null;
                              }
                              const hasLinkedNotification =
                                releasedDecision.notificationEvidenceState ===
                                  "available" ||
                                releasedDecision.notificationEvidenceState ===
                                  "retained";
                              const originalOutcomeAlreadyAccepted =
                                hasLinkedNotification &&
                                releasedDecision.notificationOperationStatus ===
                                  "completed";
                              const laterProviderFailure =
                                originalOutcomeAlreadyAccepted &&
                                ["failed", "bounced", "suppressed"].includes(
                                  releasedDecision.deliveryStatus ?? "",
                                );
                              const pendingNotificationCancellable =
                                hasLinkedNotification &&
                                [
                                  "queued",
                                  "queue_failed",
                                  "received",
                                  "retrying",
                                  "failed",
                                  "partially_failed",
                                ].includes(
                                  releasedDecision.notificationOperationStatus,
                                );
                              const notificationInProgress =
                                hasLinkedNotification &&
                                releasedDecision.notificationOperationStatus ===
                                  "running";
                              return (
                                <details className="mt">
                                  <summary className="btn small">
                                    Reopen released decision
                                  </summary>
                                  {notificationInProgress ? (
                                    <div className="validation-item warn mt">
                                      <strong>
                                        Decision email is still sending
                                      </strong>
                                      <span>
                                        Reopening is blocked while the original
                                        notification operation is running. Wait
                                        until delivery completes or the send
                                        fails, then reopen. Messages already
                                        sent cannot be recalled.
                                      </span>
                                    </div>
                                  ) : (
                                    <Form method="post" className="stack mt">
                                      <input
                                        type="hidden"
                                        name="intent"
                                        value="reopen-decision"
                                      />
                                      <input
                                        type="hidden"
                                        name="submissionId"
                                        value={result.id}
                                      />
                                      <div className="validation-item warn">
                                        <strong>
                                          {laterProviderFailure
                                            ? `The original decision email was later reported as ${releasedDecision.deliveryStatus}`
                                            : originalOutcomeAlreadyAccepted
                                              ? "The original decision email was already accepted by the provider"
                                              : "Prior messages cannot be recalled"}
                                        </strong>
                                        <span>
                                          Reopening supersedes the released{" "}
                                          {humanise(releasedDecision.decision)}{" "}
                                          outcome and returns this proposal to
                                          decision-ready state. You must release
                                          the corrected outcome separately.
                                          {laterProviderFailure
                                            ? " The provider accepted the original send and later reported a terminal failure. That evidence is retained and cannot be recalled."
                                            : originalOutcomeAlreadyAccepted
                                              ? " The original outcome was already accepted by the provider and cannot be recalled."
                                              : pendingNotificationCancellable
                                                ? " A pending notification will be cancelled; messages already sent cannot be recalled."
                                                : " No pending notification remains to cancel; messages already sent cannot be recalled."}
                                        </span>
                                      </div>
                                      <label className="label">
                                        Correction reason
                                        <textarea
                                          className="textarea"
                                          name="reason"
                                          minLength={10}
                                          maxLength={2_000}
                                          required
                                        />
                                      </label>
                                      <label className="speaker-confirm">
                                        <input
                                          type="checkbox"
                                          name="confirmed"
                                          value="true"
                                          required
                                        />
                                        {laterProviderFailure
                                          ? `I understand the original decision email was later reported as ${releasedDecision.deliveryStatus} and cannot be recalled.`
                                          : originalOutcomeAlreadyAccepted
                                            ? "I understand the original decision email was already accepted by the provider and cannot be recalled."
                                            : pendingNotificationCancellable
                                              ? "I understand a pending notification will be cancelled and messages already sent cannot be recalled."
                                              : "I understand there is no pending notification to cancel and messages already sent cannot be recalled."}
                                      </label>
                                      <button
                                        type="submit"
                                        className="btn small danger"
                                      >
                                        Confirm reopen
                                      </button>
                                    </Form>
                                  )}
                                </details>
                              );
                            })()}

                              </div>
                            </div>
                          </details>
                    </td>
                  </tr>
                );
              })}
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

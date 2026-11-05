import { Form, Link } from "react-router";

import {
  decisionActionId,
  hasReleasedDecision,
  ReleasedDecisionAction,
} from "~/components/evaluation-admin-dialogs";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { Button, ButtonLink } from "~/components/ui/button";
import { EventDateTime } from "~/components/ui/event-date-time";
import { statusPresentation } from "~/components/ui/status-presentation";

type EvaluationResult = ReturnType<
  typeof useEvaluationAdminModel
>["loaderData"]["results"][number];

function humanise(value: string) {
  return value.replaceAll("_", " ");
}

function providerStateLabel(status: string) {
  return status === "sent" ? "Provider accepted" : humanise(status);
}

export function EvaluationResultRow({ result }: { result: EvaluationResult }) {
  const {
    loaderData,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    setModerationSubmissionId,
  } = useEvaluationAdminModel();

  function assignmentHref(
    focusName: "submission" | "session",
    targetId: string,
  ) {
    return `?${new URLSearchParams({
      [focusName]: targetId,
      view: "assignments",
    })}#evaluation-assignments`;
  }

  const recommendationEntries = loaderData.resultRecommendationChoices
    .map(
      (choice) =>
        [choice.label, result.recommendations[choice.id] ?? 0] as const,
    )
    .filter(([, count]) => count > 0);
  const focusName = result.targetType === "proposal" ? "submission" : "session";
  // Actions follow the current released state; the decision history below
  // stays specific to the Results round.
  const released =
    result.targetType === "proposal" && hasReleasedDecision(result.state);
  return (
    <tr>
      <td className="pc-record-primary-cell" data-label="Target">
        <div className="pc-record-stack">
          <strong>{result.title}</strong>
          <small className="subtle">
            {result.targetType === "proposal"
              ? `${result.reference} · Proposal · ${statusPresentation("submission", result.state).label}`
              : `Session · ${statusPresentation("session", result.state).label}`}
          </small>
        </div>
      </td>
      <td data-label="Coverage">
        {result.completedReviewCount} / {result.assignmentCount}
        {result.recusedCount ? (
          <small className="subtle">
            {result.recusedCount} returned assignment
            {result.recusedCount === 1 ? "" : "s"}
          </small>
        ) : null}
      </td>
      <td data-label="Scores">
        <div className="pc-record-stack">
          <strong>
            {result.averageScore === null
              ? "—"
              : Number(result.averageScore).toFixed(2)}
          </strong>
          {result.minimumScore !== null && result.maximumScore !== null ? (
            <small className="subtle">
              Range {Number(result.minimumScore).toFixed(2)}–
              {Number(result.maximumScore).toFixed(2)}
            </small>
          ) : null}
        </div>
      </td>
      <td data-label="Recommendations">
        {recommendationEntries.length
          ? recommendationEntries
              .map(([name, count]) => `${name} ${count}`)
              .join(" · ")
          : "—"}
      </td>
      <td data-label="Flags">
        <div className="pc-eval-flags">
          {result.assignmentCount === 0 ? (
            <span className="pc-eval-flag is-warn">Unassigned</span>
          ) : null}
          {result.incomplete ? (
            <span className="pc-eval-flag is-warn">Incomplete</span>
          ) : null}
          {result.recusedCount ? (
            <span className="pc-eval-flag is-warn">
              Returned assignments reduced coverage
            </span>
          ) : null}
          {result.mixedRecommendations ? (
            <span className="pc-eval-flag is-warn">Mixed recommendations</span>
          ) : null}
          {result.decisionReady ? (
            <span className="pc-eval-flag is-ready">Decision-ready</span>
          ) : null}
          {result.moderation?.status === "draft" ? (
            <span className="pc-eval-flag is-info">Moderation draft</span>
          ) : null}
        </div>
      </td>
      <td data-label="Actions" className="pc-eval-overflow-cell">
        {result.targetType === "proposal" ? (
          released ? (
            <ReleasedDecisionAction
              submissionId={result.id}
              finalClassName="status success"
            />
          ) : (
            <Button
              id={decisionActionId(result.id)}
              type="button"
              size="small"
              onClick={() => {
                setNoReviewOverrideConfirmed(false);
                setDecisionId(result.id);
              }}
            >
              Decide
            </Button>
          )
        ) : (
          <ButtonLink size="small" to={assignmentHref(focusName, result.id)}>
            Assign
          </ButtonLink>
        )}
        {result.targetType === "proposal" ? (
          <details className="pc-eval-overflow">
            <summary aria-label={`More actions for ${result.title}`}>⋯</summary>
            <div className="pc-eval-overflow-menu">
              <Link
                className="pc-eval-text-action"
                to={assignmentHref(focusName, result.id)}
              >
                Assign
              </Link>
              {released ? null : (
                <button
                  className="pc-eval-text-action"
                  type="button"
                  onClick={() => setModerationSubmissionId(result.id)}
                >
                  Moderate
                </button>
              )}
            </div>
          </details>
        ) : null}
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
                This is the score used for review coverage, disagreement,
                sorting and decision readiness.
              </p>
            </article>
            {result.aiAssessment ? (
              <>
                <article className="card pad">
                  <strong>AI advisory · immutable</strong>
                  <p>
                    <strong>{result.aiAssessment.score.toFixed(1)} / 5</strong>
                  </p>
                  <p>{result.aiAssessment.rationale}</p>
                  <p className="help">
                    {result.aiAssessment.providerLabel} ·{" "}
                    {result.aiAssessment.model} · submission revision{" "}
                    {result.aiAssessment.submissionRevisionNumber ??
                      "legacy source"}{" "}
                    · generated{" "}
                    <EventDateTime
                      epochSeconds={result.aiAssessment.generatedAt}
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
                    Human assessment of the AI advisory · non-canonical
                  </strong>
                  {result.aiAssessment.overridden ? (
                    <>
                      <p>
                        <strong>
                          {result.aiAssessment.overrideScore.toFixed(1)} / 5
                        </strong>{" "}
                        · {result.aiAssessment.overrideByName}
                      </p>
                      <p>{result.aiAssessment.overrideRationale}</p>
                      <p className="help">
                        Recorded{" "}
                        <EventDateTime
                          epochSeconds={result.aiAssessment.overrideAt}
                          timeZone={loaderData.eventTimezone}
                        />
                      </p>
                    </>
                  ) : (
                    <p className="help">
                      No authorised human assessment has been recorded for this
                      advisory.
                    </p>
                  )}
                  <p className="help">
                    Does not affect review averages, coverage, disagreement,
                    sorting, or decision readiness.
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
                          className="field"
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
                            result.aiAssessment.overrideRationale ?? ""
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
                        Save this as a separate, non-canonical human assessment
                        without altering the AI artifact.
                      </label>
                      <Button type="submit" size="small">
                        Save human assessment
                      </Button>
                    </Form>
                  ) : null}
                </article>
              </>
            ) : null}
            {result.reviews.length ? (
              result.reviews.map((review) => (
                <article className="card pad" key={review.assignmentId}>
                  <strong>{review.evaluatorName}</strong>
                  <p className="help">
                    {review.weightedScore === null
                      ? "Unscored"
                      : `${Number(review.weightedScore).toFixed(2)} / 5`}
                    {review.recommendation
                      ? ` · ${review.recommendationLabel}`
                      : ""}
                  </p>
                  {Object.entries(review.scores).length ? (
                    <dl>
                      {Object.entries(review.scores).map(
                        ([criterionId, value]) => (
                          <div key={criterionId}>
                            <dt>
                              {loaderData.resultCriterionNames[criterionId] ??
                                criterionId}
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
                    <p>Applicant feedback: {review.submitterFeedback}</p>
                  ) : null}
                  <details className="pc-disclosure">
                    <summary>
                      {review.history.length} saved review revisions
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
                          <article className="card pad" key={revision.id}>
                            <strong>
                              Revision {revision.revisionNumber} ·{" "}
                              {humanise(revision.saveKind)}
                            </strong>
                            <p className="help">
                              {revision.savedByName} ·{" "}
                              <EventDateTime
                                epochSeconds={revision.createdAt}
                                timeZone={loaderData.eventTimezone}
                              />
                              {revision.scorecardId && revision.scorecardVersion
                                ? ` · scorecard ${revision.scorecardId} v${revision.scorecardVersion}`
                                : " · pre-contract scorecard labels unavailable"}
                            </p>
                            {revision.recommendationLabel ||
                            revision.content.confidence ? (
                              <p>
                                {revision.recommendationLabel
                                  ? `Recommendation: ${revision.recommendationLabel}`
                                  : "No recommendation"}
                                {revision.content.confidence
                                  ? ` · Confidence: ${revision.content.confidence} / 5`
                                  : ""}
                              </p>
                            ) : null}
                            {Object.entries(revision.scores).length ? (
                              <dl>
                                {Object.entries(revision.scores).map(
                                  ([criterionId, value]) => (
                                    <div key={criterionId}>
                                      <dt>
                                        {revision.criteria === null
                                          ? criterionId
                                          : criterionNames.get(criterionId)}
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
                            {revision.content.privateNotes ? (
                              <p>
                                Private notes: {revision.content.privateNotes}
                              </p>
                            ) : null}
                            {revision.content.submitterFeedback ? (
                              <p>
                                Applicant feedback:{" "}
                                {revision.content.submitterFeedback}
                              </p>
                            ) : null}
                            {revision.content.reopenReason ? (
                              <p>
                                Reopen reason: {revision.content.reopenReason}
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
                      {humanise(decision.decision)} ({humanise(decision.status)}
                      ) by {decision.decidedByName} on{" "}
                      <EventDateTime
                        epochSeconds={decision.decidedAt}
                        timeZone={loaderData.eventTimezone}
                      />
                      {decision.rationale ? ` · ${decision.rationale}` : ""}
                      {decision.publishedAt !== null &&
                      ["published", "superseded", "revoked"].includes(
                        decision.status,
                      ) ? (
                        <div className="card pad mt">
                          <strong>Decision notification evidence</strong>
                          {decision.notificationEvidenceState ===
                          "available" ? (
                            <dl>
                              <div>
                                <dt>Decision</dt>
                                <dd>{humanise(decision.decision)}</dd>
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
                                <dd>{decision.renderedSubject}</dd>
                              </div>
                              <div>
                                <dt>Queue operation</dt>
                                <dd>
                                  <Link
                                    to={`/admin/operations?operation=${encodeURIComponent(decision.notificationOperationId)}`}
                                  >
                                    {decision.notificationOperationStatus}
                                  </Link>{" "}
                                  <code>
                                    {decision.notificationOperationId}
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
                                  <code>{decision.communicationId}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>Recipient delivery</dt>
                                <dd>
                                  {providerStateLabel(decision.deliveryStatus)}{" "}
                                  via {decision.deliveryProvider}{" "}
                                  <code>{decision.deliveryId}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>Rendered template body SHA-256</dt>
                                <dd>
                                  <code>{decision.renderedBodySha256}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>Delivery state updated</dt>
                                <dd>
                                  <EventDateTime
                                    epochSeconds={decision.deliveryUpdatedAt}
                                    timeZone={loaderData.eventTimezone}
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
                                      {decision.notificationOperationStatus}
                                    </Link>{" "}
                                    <code>
                                      {decision.notificationOperationId}
                                    </code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Communication</dt>
                                  <dd>
                                    {providerStateLabel(
                                      decision.communicationStatus,
                                    )}{" "}
                                    <code>{decision.communicationId}</code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Recipient delivery</dt>
                                  <dd>
                                    {providerStateLabel(
                                      decision.deliveryStatus,
                                    )}{" "}
                                    <code>{decision.deliveryId}</code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Delivery state updated</dt>
                                  <dd>
                                    <EventDateTime
                                      epochSeconds={decision.deliveryUpdatedAt}
                                      timeZone={loaderData.eventTimezone}
                                    />
                                  </dd>
                                </div>
                              </dl>
                              <p className="help">
                                Recipient and message evidence was redacted when
                                participant retention completed.
                              </p>
                            </>
                          ) : (
                            <p className="help">
                              Pre-migration released decision: exact linked
                              recipient delivery evidence was never captured.
                            </p>
                          )}
                          <p className="help">
                            Queue acceptance is not proof of delivery. Message
                            bodies are not shown.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="help">No decision history for this round.</p>
              )}
            </div>
          </div>
        </details>
      </td>
    </tr>
  );
}

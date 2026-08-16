import { Form, Link } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { EventDateTime } from "~/components/ui/event-date-time";
import { EmptyState } from "~/components/ui/states";
import { shortReference } from "~/lib/short-reference";

export function EvaluationSubmissionQueue() {
  const {
    loaderData,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    setBulkAssignOpen,
    setBulkAssignPreview,
    setBulkAssignmentTarget,
    setBulkSubmissionIds,
    activeRound,
    assignmentTargets,
    bulkAssignableSubmissions,
    navigation,
  } = useEvaluationAdminModel();
  const { confirm, dialog } = useConfirm();
  const selectedResultsRound = loaderData.plan?.rounds.find(
    (round) => round.id === loaderData.resultsRoundId,
  );
  if (loaderData.resultsRoundId && !selectedResultsRound) {
    throw new Error("The selected evaluation results round is unavailable.");
  }
  const selectedResultsRoundName = () => {
    if (!selectedResultsRound) {
      throw new Error("The selected evaluation results round is unavailable.");
    }
    return selectedResultsRound.name;
  };
  return (
    <section className="card pad">
      {dialog}
      <div className="card-title">
        <div>
          <h2>Proposal assignments and decisions</h2>
          <p className="subtle">
            Assign proposal reviews, inspect evidence and release decisions.
          </p>
          {!loaderData.aiReviewAssessmentsSupported ? (
            <p className="help">
              AI first-pass assessments are unavailable while Airtable is the
              authoritative event repository.
            </p>
          ) : null}
        </div>
        <div className="page-actions right">
          {activeRound &&
          assignmentTargets.length > 0 &&
          bulkAssignableSubmissions.length > 0 ? (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setBulkSubmissionIds(new Set());
                setBulkAssignmentTarget(assignmentTargets[0]?.value ?? "");
                setBulkAssignPreview(false);
                setBulkAssignOpen(true);
              }}
            >
              Bulk assign
            </button>
          ) : null}
        </div>
      </div>
      {loaderData.submissions.length ? (
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Evaluation proposal queue"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Submission</th>
                <th scope="col">Status</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
                <th scope="col">Assign</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.submissions.map((submission) => {
                const aiAssessment = loaderData.aiReviewAssessments.find(
                  (assessment) =>
                    assessment.roundId === loaderData.resultsRoundId &&
                    assessment.submissionId === submission.id,
                );
                const aiAssessmentGenerationAttempt =
                  selectedResultsRound &&
                  loaderData.aiReviewAssessmentGenerationAttempts.find(
                    (attempt) =>
                      attempt.roundId === selectedResultsRound.id &&
                      attempt.submissionId === submission.id &&
                      attempt.roundRevision === selectedResultsRound.revision &&
                      attempt.scorecardId ===
                        selectedResultsRound.scorecardId &&
                      attempt.scorecardVersion ===
                        selectedResultsRound.scorecardVersion,
                  );
                const pendingAiGeneration =
                  navigation.state !== "idle" &&
                  [
                    "generate-ai-review-assessment",
                    "retry-ai-review-assessment",
                  ].includes(String(navigation.formData?.get("intent"))) &&
                  navigation.formData?.get("roundId") ===
                    selectedResultsRound?.id &&
                  navigation.formData?.get("submissionId") === submission.id;
                const pendingAiRetry =
                  pendingAiGeneration &&
                  navigation.formData?.get("intent") ===
                    "retry-ai-review-assessment";
                const pendingAiReconciliation =
                  navigation.state !== "idle" &&
                  navigation.formData?.get("intent") ===
                    "reconcile-ai-review-assessment" &&
                  navigation.formData?.get("operationId") ===
                    aiAssessmentGenerationAttempt?.operationId;
                const terminal = [
                  "accepted",
                  "waitlisted",
                  "rejected",
                ].includes(submission.status);
                const decidable =
                  !terminal && submission.status !== "withdrawn";
                const assignable = submission.reviewableInCurrentCycle;
                return (
                  <tr
                    key={submission.id}
                    id={`review-submission-${submission.id}`}
                    className={
                      loaderData.focusedSubmissionId === submission.id
                        ? "pc-focused-record"
                        : undefined
                    }
                  >
                    <td
                      className="pc-record-primary-cell"
                      data-label="Submission"
                    >
                      <div className="pc-record-stack">
                        <strong>{submission.title}</strong>
                        <small className="subtle">{submission.reference}</small>
                        <small className="subtle">
                          {submission.category ?? "Uncategorised"}
                        </small>
                        {submission.speakers.length ? (
                          <small className="subtle">
                            Participants:{" "}
                            {submission.speakers
                              .map(
                                (speaker) =>
                                  `${speaker.name} (${speaker.roleLabel ?? "Speaker"})`,
                              )
                              .join(", ")}
                          </small>
                        ) : null}
                        {submission.routedTeamName ? (
                          <small className="subtle">
                            Routed to {submission.routedTeamName}
                          </small>
                        ) : null}
                        {aiAssessment ? (
                          <details className="pc-disclosure mt">
                            <summary>
                              AI first pass · {aiAssessment.score.toFixed(1)} /
                              5
                              {aiAssessment.overridden
                                ? ` · human override ${aiAssessment.effectiveScore.toFixed(1)} / 5`
                                : ""}
                            </summary>
                            <div className="stack mt">
                              <p>{aiAssessment.rationale}</p>
                              <p className="help">
                                AI-generated advisory output ·{" "}
                                {aiAssessment.providerLabel}{" "}
                                {aiAssessment.model}
                              </p>
                              {aiAssessment.overridden ? (
                                <div className="validation-item ok">
                                  <strong>
                                    Human override ·{" "}
                                    {aiAssessment.overrideScore?.toFixed(1)} / 5
                                  </strong>
                                  <span>{aiAssessment.overrideRationale}</span>
                                </div>
                              ) : null}
                              {loaderData.canManageAiAssessments ? (
                                <Form method="post" className="stack">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="override-ai-review-assessment"
                                  />
                                  <input
                                    type="hidden"
                                    name="assessmentId"
                                    value={aiAssessment.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="expectedRevision"
                                    value={aiAssessment.revision}
                                  />
                                  <input
                                    type="hidden"
                                    name="confirmed"
                                    value="true"
                                  />
                                  <label className="label">
                                    Human override score
                                    <input
                                      className="input"
                                      name="score"
                                      type="number"
                                      min="1"
                                      max="5"
                                      step="0.1"
                                      defaultValue={
                                        aiAssessment.overrideScore ??
                                        aiAssessment.score
                                      }
                                      required
                                    />
                                  </label>
                                  <label className="label">
                                    Override rationale
                                    <textarea
                                      className="textarea"
                                      name="rationale"
                                      minLength={10}
                                      maxLength={2000}
                                      defaultValue={
                                        aiAssessment.overrideRationale ?? ""
                                      }
                                      required
                                    />
                                  </label>
                                  <button
                                    className="btn small"
                                    type="button"
                                    onClick={(event) => {
                                      const form = event.currentTarget.form;
                                      if (!form) {
                                        throw new Error(
                                          "The AI override form is missing.",
                                        );
                                      }
                                      const formData = new FormData(form);
                                      const score = formData.get("score");
                                      const rationale =
                                        formData.get("rationale");
                                      if (
                                        typeof score !== "string" ||
                                        typeof rationale !== "string"
                                      ) {
                                        throw new Error(
                                          "The AI override confirmation values are missing.",
                                        );
                                      }
                                      if (!form.reportValidity()) return;
                                      confirm(
                                        {
                                          title:
                                            "Save human AI-score override?",
                                          description:
                                            "The original AI result stays immutable. This saves a separate human score and rationale that becomes the effective advisory score.",
                                          records: [
                                            `${submission.title} · ${selectedResultsRoundName()}`,
                                            `Effective score: ${score} / 5`,
                                            `Rationale: ${rationale.trim()}`,
                                          ],
                                          confirmLabel: "Save override",
                                          tone: "primary",
                                        },
                                        () => form.requestSubmit(),
                                      );
                                    }}
                                  >
                                    Review human override
                                  </button>
                                </Form>
                              ) : null}
                            </div>
                          </details>
                        ) : (pendingAiGeneration ||
                            aiAssessmentGenerationAttempt?.status ===
                              "running") &&
                          loaderData.canManageAiAssessments &&
                          loaderData.resultsRoundId &&
                          selectedResultsRound &&
                          ["active", "closed"].includes(
                            selectedResultsRound.status,
                          ) &&
                          submission.reviewableInCurrentCycle ? (
                          <div className="stack mt">
                            <div className="validation-item info" role="status">
                              <strong>
                                {pendingAiReconciliation
                                  ? "Reconciling AI first pass"
                                  : pendingAiGeneration
                                    ? pendingAiRetry
                                      ? "Starting AI first pass retry"
                                      : "Starting AI first pass"
                                    : aiAssessmentGenerationAttempt?.status ===
                                          "running" &&
                                        aiAssessmentGenerationAttempt.retryOfOperationId
                                      ? "AI first pass retry running"
                                      : "AI first pass running"}
                              </strong>
                              <span>
                                {aiAssessmentGenerationAttempt?.status ===
                                "running"
                                  ? `Started by ${aiAssessmentGenerationAttempt.requestedByName}.`
                                  : "Submitting the request from this page."}
                              </span>
                              {aiAssessmentGenerationAttempt?.status ===
                              "running" ? (
                                <small>
                                  {aiAssessmentGenerationAttempt.providerLabel}{" "}
                                  {aiAssessmentGenerationAttempt.model} ·
                                  Started{" "}
                                  <EventDateTime
                                    epochSeconds={
                                      aiAssessmentGenerationAttempt.startedAt
                                    }
                                    timeZone={loaderData.eventTimezone}
                                  />
                                </small>
                              ) : null}
                            </div>
                            {aiAssessmentGenerationAttempt?.status ===
                            "running" ? (
                              <>
                                {aiAssessmentGenerationAttempt.recoveryRequired ? (
                                  <div
                                    className="validation-item warn"
                                    role="status"
                                  >
                                    <strong>
                                      AI attempt needs reconciliation
                                    </strong>
                                    <span>
                                      Recover its saved result or mark its
                                      expired provider claim failed before an
                                      explicit retry. Reconciliation never sends
                                      another provider request.
                                    </span>
                                  </div>
                                ) : null}
                                <div className="cluster">
                                  {aiAssessmentGenerationAttempt.recoveryRequired ? (
                                    <Form method="post">
                                      <input
                                        type="hidden"
                                        name="intent"
                                        value="reconcile-ai-review-assessment"
                                      />
                                      <input
                                        type="hidden"
                                        name="operationId"
                                        value={
                                          aiAssessmentGenerationAttempt.operationId
                                        }
                                      />
                                      <button
                                        className="btn small"
                                        type="submit"
                                        disabled={pendingAiReconciliation}
                                      >
                                        {pendingAiReconciliation
                                          ? "Reconciling…"
                                          : "Reconcile AI attempt"}
                                      </button>
                                    </Form>
                                  ) : null}
                                  <Link
                                    className="btn small"
                                    to={`/admin/operations?operation=${encodeURIComponent(aiAssessmentGenerationAttempt.operationId)}`}
                                  >
                                    View operation
                                  </Link>
                                </div>
                              </>
                            ) : null}
                          </div>
                        ) : aiAssessmentGenerationAttempt?.status ===
                            "failed" &&
                          loaderData.canManageAiAssessments &&
                          loaderData.resultsRoundId &&
                          selectedResultsRound &&
                          ["active", "closed"].includes(
                            selectedResultsRound.status,
                          ) &&
                          submission.reviewableInCurrentCycle ? (
                          <div className="stack mt">
                            <div className="validation-item warn">
                              <strong>AI first pass failed</strong>
                              <span>
                                {aiAssessmentGenerationAttempt.lastError}
                              </span>
                              <small>
                                {aiAssessmentGenerationAttempt.providerLabel}{" "}
                                {aiAssessmentGenerationAttempt.model}
                                {aiAssessmentGenerationAttempt.providerRequestId
                                  ? ` · Provider request ${aiAssessmentGenerationAttempt.providerRequestId}`
                                  : ""}
                              </small>
                            </div>
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="retry-ai-review-assessment"
                              />
                              <input
                                type="hidden"
                                name="generationIntentId"
                                value={submission.aiAssessmentGenerationIntent}
                              />
                              <input
                                type="hidden"
                                name="failedOperationId"
                                value={
                                  aiAssessmentGenerationAttempt.operationId
                                }
                              />
                              <input
                                type="hidden"
                                name="roundId"
                                value={loaderData.resultsRoundId}
                              />
                              <input
                                type="hidden"
                                name="submissionId"
                                value={submission.id}
                              />
                              <input
                                type="hidden"
                                name="duplicateRiskAcknowledged"
                                value="true"
                              />
                              <input
                                type="hidden"
                                name="confirmed"
                                value="true"
                              />
                              <button
                                className="btn small"
                                type="button"
                                onClick={(event) => {
                                  const form = event.currentTarget.form;
                                  if (!form) {
                                    throw new Error(
                                      "The failed AI assessment retry form is missing.",
                                    );
                                  }
                                  confirm(
                                    {
                                      title:
                                        "Retry failed AI first-pass assessment?",
                                      description:
                                        "This creates a separate provider attempt and retains the failed operation. The earlier request may have been accepted or charged even though Program Cue received no usable result, so another provider charge or duplicate result is possible.",
                                      records: [
                                        `${submission.title} · ${selectedResultsRound.name}`,
                                        `Failed attempt ${shortReference(aiAssessmentGenerationAttempt.operationId)}`,
                                      ],
                                      confirmLabel: "Retry first pass",
                                      tone: "primary",
                                    },
                                    () => form.requestSubmit(),
                                  );
                                }}
                              >
                                Retry failed AI first pass
                              </button>
                            </Form>
                          </div>
                        ) : loaderData.canManageAiAssessments &&
                          loaderData.resultsRoundId &&
                          selectedResultsRound &&
                          ["active", "closed"].includes(
                            selectedResultsRound.status,
                          ) &&
                          submission.reviewableInCurrentCycle ? (
                          <Form method="post" className="mt">
                            <input
                              type="hidden"
                              name="intent"
                              value="generate-ai-review-assessment"
                            />
                            <input
                              type="hidden"
                              name="generationIntentId"
                              value={submission.aiAssessmentGenerationIntent}
                            />
                            <input
                              type="hidden"
                              name="roundId"
                              value={loaderData.resultsRoundId}
                            />
                            <input
                              type="hidden"
                              name="submissionId"
                              value={submission.id}
                            />
                            <input
                              type="hidden"
                              name="confirmed"
                              value="true"
                            />
                            <button
                              className="btn small"
                              type="button"
                              onClick={(event) => {
                                const form = event.currentTarget.form;
                                if (!form) {
                                  throw new Error(
                                    "The AI assessment form is missing.",
                                  );
                                }
                                confirm(
                                  {
                                    title: "Generate AI first-pass assessment?",
                                    description:
                                      "Program Cue sends a fixed copy of this proposal and its rubric to the AI provider, then saves the advisory score and rationale it returns. The request to the provider cannot be undone.",
                                    records: [
                                      `${submission.title} · ${selectedResultsRound.name}`,
                                    ],
                                    confirmLabel: "Generate first pass",
                                    tone: "primary",
                                  },
                                  () => form.requestSubmit(),
                                );
                              }}
                            >
                              Review AI first pass
                            </button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Status">
                      <span
                        className={`status ${terminal ? "success" : "info"}`}
                      >
                        {submission.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td data-label="Reviews">
                      {submission.completedReviewCount} /{" "}
                      {submission.assignmentCount}
                      {loaderData.resultsRoundId ? (
                        <small>
                          <Link
                            to={`/admin/review?${new URLSearchParams({
                              resultsRound: loaderData.resultsRoundId,
                              submission: submission.id,
                              sort: loaderData.resultSort,
                              ...(loaderData.reviewFilter
                                ? { filter: loaderData.reviewFilter }
                                : {}),
                            })}#evaluation-discussion`}
                          >
                            Open discussion
                          </Link>
                        </small>
                      ) : null}
                    </td>
                    <td data-label="Average">
                      {submission.averageScore === null
                        ? "—"
                        : Number(submission.averageScore).toFixed(2)}
                    </td>
                    <td data-label="Assign" className="pc-record-action-cell">
                      {assignable && activeRound && assignmentTargets.length ? (
                        <Form method="post" className="inline-form">
                          <input type="hidden" name="intent" value="assign" />
                          <input
                            type="hidden"
                            name="roundId"
                            value={activeRound.id}
                          />
                          <input
                            type="hidden"
                            name="targetType"
                            value="submission"
                          />
                          <input
                            type="hidden"
                            name="targetId"
                            value={submission.id}
                          />
                          <select
                            className="select"
                            name="assignmentTarget"
                            aria-label={`Evaluator or team for ${submission.title}`}
                          >
                            {(["Teams", "Individuals"] as const).map((kind) => {
                              const targets = assignmentTargets.filter(
                                (target) => target.kind === kind,
                              );
                              return targets.length ? (
                                <optgroup label={kind} key={kind}>
                                  {targets.map((target) => (
                                    <option
                                      value={target.value}
                                      key={target.value}
                                    >
                                      {target.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ) : null;
                            })}
                          </select>
                          <button type="submit" className="btn small">
                            Assign
                          </button>
                        </Form>
                      ) : (
                        <span className="help">
                          {!assignable
                            ? "Review closed"
                            : !activeRound
                              ? "No active round"
                              : "Add an evaluator or active team"}
                        </span>
                      )}
                    </td>
                    <td data-label="Decision" className="pc-record-action-cell">
                      {!decidable ? (
                        <span className="status neutral">
                          {terminal ? "Final" : "Unavailable"}
                        </span>
                      ) : (
                        <button
                          className="btn small primary"
                          type="button"
                          onClick={() => {
                            setNoReviewOverrideConfirmed(false);
                            setDecisionId(submission.id);
                          }}
                        >
                          Decide
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState
          title="No submitted proposals"
          description="Published form submissions will appear here."
        />
      )}
    </section>
  );
}

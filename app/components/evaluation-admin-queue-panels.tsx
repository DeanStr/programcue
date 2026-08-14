import { Form, Link } from "react-router";

import { EventDateTime } from "~/components/ui/event-date-time";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { EmptyState } from "~/components/ui/states";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { encodeScorecardSelection } from "~/modules/evaluations/evaluation-scorecard-selection";

export function EvaluationProgressionPanel() {
  const {
    loaderData,
    navigation,
    setAdvanceOpen,
    activeRound,
    nextRound,
    unfinishedAssignmentCount,
    advanceableSubmissions,
    nextRoundAssignmentTargets,
  } = useEvaluationAdminModel();
  const plan = loaderData.plan;
  if (!plan) return null;
  return (
    <section className="card pad mb">
      <div className="card-title">
        <div>
          <h2>Round progression</h2>
          <p className="subtle">
            Add a protected next round by cloning an existing rubric, then
            advance a reviewed shortlist atomically.
          </p>
        </div>
      </div>
      {plan.rounds.length < 10 ? (
        <Form method="post" className="stack mb">
          <input type="hidden" name="intent" value="add-next-round" />
          <input type="hidden" name="planId" value={plan.id} />
          <input type="hidden" name="planRevision" value={plan.revision} />
          <input
            className="input"
            name="name"
            placeholder={`Round ${plan.rounds.length + 1} name`}
            aria-label="Next round name"
            required
          />
          <select
            className="select"
            name="cloneRoundId"
            aria-label="Rubric to clone"
            defaultValue={activeRound?.id ?? plan.rounds.at(-1)?.id}
          >
            {plan.rounds.map((round) => (
              <option key={round.id} value={round.id}>
                Clone {round.name}
              </option>
            ))}
          </select>
          <label className="label">
            Scorecard to use
            <select
              className="select"
              name="scorecardSelection"
              aria-label="Scorecard to use"
              defaultValue=""
            >
              <option value="">Create a new scorecard (v1)</option>
              {plan.rounds.map((round) => (
                <option
                  key={`${round.scorecardId}:${round.scorecardVersion}`}
                  value={encodeScorecardSelection(
                    round.scorecardId,
                    round.scorecardVersion,
                  )}
                >
                  Reuse {round.name} scorecard (v{round.scorecardVersion})
                </option>
              ))}
            </select>
            <span className="help">
              The default keeps this round on its own scorecard; the rubric
              above is still cloned separately.
            </span>
          </label>
          <div className="grid grid-2">
            <label className="label">
              Opens ({loaderData.eventTimezone})
              <input
                className="input"
                type="datetime-local"
                name="roundOpensAt"
              />
            </label>
            <label className="label">
              Closes ({loaderData.eventTimezone})
              <input
                className="input"
                type="datetime-local"
                name="roundClosesAt"
              />
            </label>
          </div>
          <label className="validation-item">
            <input type="checkbox" name="anonymous" value="true" />
            <span>
              Hide author and co-author identity from reviewers in this round
            </span>
          </label>
          <button className="btn" disabled={navigation.state !== "idle"}>
            Add next round
          </button>
        </Form>
      ) : null}
      {activeRound && nextRound ? (
        <div className="validation-item warn">
          <span>
            <strong>
              {unfinishedAssignmentCount === 0
                ? `${advanceableSubmissions.length} reviewed submission${advanceableSubmissions.length === 1 ? "" : "s"} can be shortlisted for ${nextRound.name}.`
                : `${unfinishedAssignmentCount} assignment${unfinishedAssignmentCount === 1 ? " remains" : "s remain"} unfinished in ${activeRound.name}.`}
            </strong>
            Advancing closes and locks the current round, activates the next
            round and creates the new assignments together.
          </span>
          <button
            type="button"
            className="btn small primary"
            disabled={
              unfinishedAssignmentCount > 0 ||
              advanceableSubmissions.length === 0 ||
              nextRoundAssignmentTargets.length === 0
            }
            onClick={() => setAdvanceOpen(true)}
          >
            Review advancement
          </button>
          {nextRoundAssignmentTargets.length === 0 ? (
            <small className="subtle">
              Add at least one reviewer to {nextRound.name}'s pool before
              advancing.
            </small>
          ) : null}
        </div>
      ) : activeRound ? (
        <p className="help">Add the next round before advancing a shortlist.</p>
      ) : (
        <p className="help">There is no active evaluation round.</p>
      )}
    </section>
  );
}

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
          <h2>Submission results and assignments</h2>
          <p className="subtle">
            Sort the aggregate review results or download the round-by-round
            review record.
          </p>
          {!loaderData.aiReviewAssessmentsSupported ? (
            <p className="help">
              AI first-pass assessments are unavailable while Airtable is the
              authoritative event repository.
            </p>
          ) : null}
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
                <option value="title_asc">Submission title</option>
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
                    "The Abstract results export intent control is missing.",
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
              <button className="btn small">Download results CSV</button>
            </Form>
          ) : null}
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
        <div className="table-wrap pc-responsive-table-wrap">
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
                                        `Failed attempt: ${aiAssessmentGenerationAttempt.operationId}`,
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
                                      "Program Cue sends the authorised immutable proposal projection and persisted rubric to the configured AI provider, then saves its advisory score and rationale. The provider request cannot be undone.",
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
                          <button className="btn small">Assign</button>
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
        </div>
      ) : (
        <EmptyState
          title="No submitted proposals"
          description="Published form submissions will appear here."
        />
      )}
    </section>
  );
}

export function AcceptedSpeakerInvitationsPanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  return loaderData.acceptedSpeakerInvitations.length ? (
    <section className="card pad mt">
      <div className="card-title">
        <div>
          <h2>Speaker access invitations</h2>
          <p className="subtle">
            Renew an unaccepted speaker link explicitly. Renewal rotates the
            one-time token, invalidates every earlier link and starts a new
            seven-day window.
          </p>
        </div>
      </div>
      <div className="table-wrap pc-responsive-table-wrap">
        <table className="data-table pc-responsive-table">
          <thead>
            <tr>
              <th scope="col">Speaker</th>
              <th scope="col">Accepted session</th>
              <th scope="col">Access state</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.acceptedSpeakerInvitations.map((invitation) => (
              <tr key={invitation.membershipId}>
                <td className="pc-record-primary-cell" data-label="Speaker">
                  <div className="pc-record-stack">
                    <strong>{invitation.name}</strong>
                    <small className="subtle">{invitation.email}</small>
                  </div>
                </td>
                <td data-label="Accepted session">{invitation.sessionTitle}</td>
                <td data-label="Access state">
                  <span
                    className={`status ${invitation.status === "expired" ? "danger" : "info"}`}
                  >
                    {invitation.status}
                  </span>{" "}
                  <EventDateTime
                    epochSeconds={invitation.expiresAt}
                    timeZone={loaderData.eventTimezone}
                  >
                    {invitation.status === "expired"
                      ? "expired link"
                      : "pending link"}
                  </EventDateTime>
                </td>
                <td className="pc-record-action-cell" data-label="Action">
                  {loaderData.acceptedSpeakerInvitationResendEnabled ? (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="resend-accepted-speaker"
                      />
                      <input
                        type="hidden"
                        name="decisionId"
                        value={invitation.decisionId}
                      />
                      <input
                        type="hidden"
                        name="membershipId"
                        value={invitation.membershipId}
                      />
                      <input
                        type="hidden"
                        name="expectedExpiresAt"
                        value={invitation.expiresAt}
                      />
                      <button
                        className="btn small"
                        disabled={navigation.state !== "idle"}
                      >
                        Renew invitation
                      </button>
                    </Form>
                  ) : (
                    <span className="help">Demo mode sends no email</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ) : null;
}

export function EvaluationSessionQueue() {
  const {
    loaderData,
    setReopenAssignmentId,
    activeRound,
    sessionReviewAssignments,
    assignmentTargets,
  } = useEvaluationAdminModel();
  return (
    <section className="card pad mt">
      <div className="card-title">
        <div>
          <h2>Session queue</h2>
          <p className="subtle">
            Assign existing sessions directly. Reviewers receive a frozen copy
            of the session details and speakers at assignment time.
          </p>
        </div>
      </div>
      {loaderData.sessions.length ? (
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Programme state</th>
                <th scope="col">Reviews</th>
                <th scope="col">Average</th>
                <th scope="col">Assign</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.sessions.map((session) => (
                <tr key={session.id}>
                  <td data-label="Session" className="pc-record-primary-cell">
                    <div className="pc-record-stack">
                      <strong>{session.title}</strong>
                      <small className="subtle">
                        {session.reference} ·{" "}
                        {session.format.replaceAll("_", " ")} ·{" "}
                        {session.durationMinutes} min
                      </small>
                      {session.trackName ? (
                        <small className="subtle">{session.trackName}</small>
                      ) : null}
                    </div>
                  </td>
                  <td data-label="Programme state">
                    <span className="status info">
                      {session.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td data-label="Reviews">
                    {session.completedReviewCount} / {session.assignmentCount}
                  </td>
                  <td data-label="Average">
                    {session.averageScore === null
                      ? "—"
                      : Number(session.averageScore).toFixed(2)}
                  </td>
                  <td data-label="Assign" className="pc-record-action-cell">
                    {activeRound && assignmentTargets.length ? (
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
                          value="session"
                        />
                        <input
                          type="hidden"
                          name="targetId"
                          value={session.id}
                        />
                        <select
                          className="select"
                          name="assignmentTarget"
                          aria-label={`Evaluator or team for ${session.title}`}
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
                        <button className="btn small">Assign</button>
                      </Form>
                    ) : (
                      <span className="help">
                        {!activeRound
                          ? "No active round"
                          : "Add an evaluator or active team"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No direct sessions"
          description="Create a session before assigning it for review."
        />
      )}
      {sessionReviewAssignments.length ? (
        <div className="stack mt">
          <strong>Active-round session reviews</strong>
          <ul className="list-clean">
            {sessionReviewAssignments.map((assignment) => (
              <li key={assignment.id}>
                <span>
                  <strong>{assignment.targetTitle}</strong>
                  <small className="subtle">
                    {assignment.evaluatorName} ·{" "}
                    {assignment.status.replaceAll("_", " ")}
                    {assignment.weightedScore === null
                      ? ""
                      : ` · ${Number(assignment.weightedScore).toFixed(2)} / 5`}
                  </small>
                </span>
                {assignment.reviewStatus === "submitted" ||
                assignment.reviewStatus === "locked" ? (
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => setReopenAssignmentId(assignment.id)}
                  >
                    Reopen review
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function EvaluationModerationPanel() {
  const {
    loaderData,
    setModerationSubmissionId,
    setReopenAssignmentId,
    activeRound,
    activeRoundAssignments,
  } = useEvaluationAdminModel();
  return activeRound ? (
    <section className="card pad mt">
      <div className="card-title">
        <div>
          <h2>Moderation and review control</h2>
          <p className="subtle">
            Compare submitted reviewer outcomes, record the chair's moderation
            and explicitly reopen a locked review when a correction is required.
          </p>
        </div>
        <span className="status info right">{activeRound.name}</span>
      </div>
      <div className="stack">
        {loaderData.submissions.map((submission) => {
          const assignments = activeRoundAssignments.filter(
            (assignment) => assignment.submissionId === submission.id,
          );
          const completed = assignments.filter(
            (assignment) =>
              assignment.reviewStatus === "submitted" ||
              assignment.reviewStatus === "locked",
          );
          const moderation = loaderData.moderations.find(
            (candidate) =>
              candidate.roundId === activeRound.id &&
              candidate.submissionId === submission.id,
          );
          if (assignments.length === 0) return null;
          return (
            <details className="card pad pc-disclosure" key={submission.id}>
              <summary>
                <strong>{submission.title}</strong> · {completed.length}/
                {assignments.length} submitted
                {moderation ? ` · moderation ${moderation.status}` : ""}
              </summary>
              <div className="stack mt">
                {assignments.map((assignment) => (
                  <div className="validation-item" key={assignment.id}>
                    <span>
                      <strong>{assignment.evaluatorName}</strong>
                      {assignment.teamName ? ` · ${assignment.teamName}` : ""}
                      <small className="subtle">
                        {assignment.status.replaceAll("_", " ")}
                        {assignment.weightedScore === null
                          ? ""
                          : ` · ${Number(assignment.weightedScore).toFixed(2)} / 5`}
                        {assignment.recommendation
                          ? ` · ${assignment.recommendation.replaceAll("_", " ")}`
                          : ""}
                      </small>
                      {assignment.conflictNotes ? (
                        <small className="subtle">
                          Conflict: {assignment.conflictNotes}
                        </small>
                      ) : null}
                    </span>
                    {assignment.status === "submitted" &&
                    (assignment.reviewStatus === "submitted" ||
                      assignment.reviewStatus === "locked") ? (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => setReopenAssignmentId(assignment.id)}
                      >
                        Reopen review
                      </button>
                    ) : null}
                  </div>
                ))}
                {completed.length ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setModerationSubmissionId(submission.id)}
                  >
                    {moderation ? "Review moderation" : "Moderate reviews"}
                  </button>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  ) : null;
}

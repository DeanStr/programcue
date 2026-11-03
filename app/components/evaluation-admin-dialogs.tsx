import { useEffect, useMemo, useRef, useState } from "react";
import { Form, useRevalidator } from "react-router";

import { Dialog } from "~/components/dialog";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { Button } from "~/components/ui/button";
import {
  fillKnownMergeFields,
  recipientMergeValues,
} from "~/modules/communications/merge-template";

export function BulkAssignmentDialog() {
  const [trackFilter, setTrackFilter] = useState("");
  const {
    navigation,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreview,
    setBulkAssignPreview,
    bulkAssignmentTarget,
    setBulkAssignmentTarget,
    bulkSubmissionIds,
    setBulkSubmissionIds,
    activeRound,
    assignmentTargets,
    bulkAssignableSubmissions,
    bulkSelectedSubmissions,
    bulkAssignmentTargetLabel,
  } = useEvaluationAdminModel();
  const trackOptions = useMemo(
    () =>
      Array.from(
        new Map(
          bulkAssignableSubmissions
            .flatMap((submission) => submission.tracks)
            .map((track) => [track.id, track] as const),
        ).values(),
      ).sort((left, right) => left.name.localeCompare(right.name)),
    [bulkAssignableSubmissions],
  );
  const visibleSubmissions = trackFilter
    ? bulkAssignableSubmissions.filter((submission) =>
        submission.tracks.some((track) => track.id === trackFilter),
      )
    : bulkAssignableSubmissions;
  const close = () => {
    setBulkAssignOpen(false);
    setBulkAssignPreview(false);
    setTrackFilter("");
  };
  return bulkAssignOpen && activeRound ? (
    <Dialog
      title={
        bulkAssignPreview ? "Confirm bulk assignment" : "Bulk assign reviewers"
      }
      onClose={close}
      size="lg"
      footer={
        bulkAssignPreview ? (
          <>
            <Button type="button" onClick={() => setBulkAssignPreview(false)}>
              Back
            </Button>
            <Button
              type="submit"
              form="evaluation-bulk-assign-form"
              variant="primary"
              disabled={navigation.state !== "idle"}
            >
              Confirm assignments
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={
              bulkSubmissionIds.size === 0 || !bulkAssignmentTargetLabel
            }
            onClick={() => setBulkAssignPreview(true)}
          >
            Preview {bulkSubmissionIds.size} assignment target
            {bulkSubmissionIds.size === 1 ? "" : "s"}
          </Button>
        )
      }
    >
      {bulkAssignPreview ? (
        <Form
          id="evaluation-bulk-assign-form"
          method="post"
          className="stack"
          onSubmit={close}
        >
          <input type="hidden" name="intent" value="assign" />
          <input type="hidden" name="roundId" value={activeRound.id} />
          <input type="hidden" name="targetType" value="submission" />
          <input
            type="hidden"
            name="assignmentTarget"
            value={bulkAssignmentTarget}
          />
          {bulkSelectedSubmissions.map((submission) => (
            <input
              key={submission.id}
              type="hidden"
              name="targetId"
              value={submission.id}
            />
          ))}
          <div className="validation-item warn">
            <strong>
              Assign {bulkAssignmentTargetLabel} to{" "}
              {bulkSelectedSubmissions.length} submission
              {bulkSelectedSubmissions.length === 1 ? "" : "s"}
            </strong>
            <span>
              One assignment is created per eligible reviewer and proposal.
              Existing matching assignments stay unchanged. New untouched
              assignments can be undone for five minutes.
            </span>
          </div>
          <ul>
            {bulkSelectedSubmissions.map((submission) => (
              <li key={submission.id}>
                <strong>{submission.title}</strong> · {submission.reference}
              </li>
            ))}
          </ul>
        </Form>
      ) : (
        <div className="stack">
          <label className="label">
            Evaluator or team
            <select
              className="select"
              value={bulkAssignmentTarget}
              onChange={(event) =>
                setBulkAssignmentTarget(event.currentTarget.value)
              }
            >
              {(["Teams", "Individuals"] as const).map((kind) => {
                const targets = assignmentTargets.filter(
                  (target) => target.kind === kind,
                );
                return targets.length ? (
                  <optgroup label={kind} key={kind}>
                    {targets.map((target) => (
                      <option key={target.value} value={target.value}>
                        {target.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          {trackOptions.length ? (
            <label className="label">
              Filter submissions by track
              <select
                className="select"
                value={trackFilter}
                onChange={(event) => {
                  setTrackFilter(event.currentTarget.value);
                  setBulkSubmissionIds(new Set());
                }}
              >
                <option value="">All tracks</option>
                {trackOptions.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <fieldset className="stack">
            <legend className="label">Affected submissions</legend>
            <div className="page-actions">
              <Button
                type="button"
                size="small"
                onClick={() =>
                  setBulkSubmissionIds(
                    new Set(
                      visibleSubmissions.map((submission) => submission.id),
                    ),
                  )
                }
              >
                Select visible
              </Button>
              <Button
                type="button"
                size="small"
                onClick={() => setBulkSubmissionIds(new Set())}
              >
                Clear
              </Button>
            </div>
            {visibleSubmissions.map((submission) => (
              <label key={submission.id} className="pc-eval-bulk-row">
                <input
                  type="checkbox"
                  checked={bulkSubmissionIds.has(submission.id)}
                  onChange={(event) => {
                    const next = new Set(bulkSubmissionIds);
                    if (event.currentTarget.checked) next.add(submission.id);
                    else next.delete(submission.id);
                    setBulkSubmissionIds(next);
                  }}
                />
                <span>
                  <strong>{submission.title}</strong>
                  <small className="subtle">
                    {submission.reference} ·{" "}
                    {submission.status.replaceAll("_", " ")}
                    {submission.tracks.length
                      ? ` · ${submission.tracks.map((track) => track.name).join(", ")}`
                      : " · No track"}
                  </small>
                </span>
              </label>
            ))}
            {visibleSubmissions.length === 0 ? (
              <p className="subtle">
                No reviewable submissions use this track.
              </p>
            ) : null}
          </fieldset>
        </div>
      )}
    </Dialog>
  ) : null;
}

export function RoundAdvancementDialog() {
  const {
    navigation,
    advanceOpen,
    setAdvanceOpen,
    activeRound,
    nextRound,
    advanceableSubmissions,
    nextRoundAssignmentTargets,
  } = useEvaluationAdminModel();
  return advanceOpen && activeRound && nextRound ? (
    <Dialog
      title={`Advance to ${nextRound.name}`}
      onClose={() => setAdvanceOpen(false)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setAdvanceOpen(false)}
      >
        <input type="hidden" name="intent" value="advance-round" />
        <input type="hidden" name="fromRoundId" value={activeRound.id} />
        <input
          type="hidden"
          name="fromRoundRevision"
          value={activeRound.revision}
        />
        <input type="hidden" name="toRoundId" value={nextRound.id} />
        <input
          type="hidden"
          name="toRoundRevision"
          value={nextRound.revision}
        />
        <input type="hidden" name="confirmed" value="true" />
        <fieldset className="stack">
          <legend className="label">Shortlist to advance</legend>
          {advanceableSubmissions.map((submission) => (
            <label key={submission.id} className="validation-item">
              <input
                type="checkbox"
                name="submissionId"
                value={submission.id}
              />
              <span>
                <strong>{submission.title}</strong>
                <small className="subtle">
                  {submission.reference} · average{" "}
                  {submission.averageScore === null
                    ? "not calculated"
                    : `${Number(submission.averageScore).toFixed(2)} / 5`}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="label">
          Next-round reviewers
          <select className="select" name="assignmentTarget" required>
            {(["Teams", "Individuals"] as const).map((kind) => {
              const targets = nextRoundAssignmentTargets.filter(
                (target) => target.kind === kind,
              );
              return targets.length ? (
                <optgroup label={kind} key={kind}>
                  {targets.map((target) => (
                    <option key={target.value} value={target.value}>
                      {target.label}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <div className="validation-item warn">
          <strong>This closes {activeRound.name}</strong>
          <span>
            All submitted reviews in the current round become locked. The next
            round becomes active and only the selected submissions receive new
            assignments. Other current-round proposals leave active review ready
            for a final outcome. This is not an undo action.
          </span>
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={navigation.state !== "idle"}
        >
          Close round and advance shortlist
        </Button>
      </Form>
    </Dialog>
  ) : null;
}

export function ModerationDialog() {
  const {
    navigation,
    setModerationSubmissionId,
    activeRound,
    activeRoundAssignments,
    moderationSubmission,
    currentModeration,
  } = useEvaluationAdminModel();
  return moderationSubmission && activeRound ? (
    <Dialog
      title={`Moderation · ${moderationSubmission.title}`}
      onClose={() => setModerationSubmissionId(null)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setModerationSubmissionId(null)}
      >
        <input type="hidden" name="intent" value="moderate" />
        <input type="hidden" name="roundId" value={activeRound.id} />
        <input
          type="hidden"
          name="submissionId"
          value={moderationSubmission.id}
        />
        <input
          type="hidden"
          name="expectedModerationId"
          value={currentModeration?.id ?? ""}
        />
        <div className="card pad">
          <strong>Submitted reviewer outcomes</strong>
          <ul>
            {activeRoundAssignments
              .filter(
                (assignment) =>
                  assignment.submissionId === moderationSubmission.id &&
                  (assignment.reviewStatus === "submitted" ||
                    assignment.reviewStatus === "locked"),
              )
              .map((assignment) => (
                <li key={assignment.id}>
                  <strong>{assignment.evaluatorName}</strong>:{" "}
                  {assignment.weightedScore === null
                    ? "unscored"
                    : `${Number(assignment.weightedScore).toFixed(2)} / 5`}
                  {assignment.recommendationLabel
                    ? ` · ${assignment.recommendationLabel}`
                    : ""}
                  {assignment.confidence
                    ? ` · confidence ${assignment.confidence} / 5`
                    : ""}
                  {assignment.privateNotes ? (
                    <small className="subtle">
                      Private notes: {assignment.privateNotes}
                    </small>
                  ) : null}
                  {assignment.submitterFeedback ? (
                    <small className="subtle">
                      Applicant feedback: {assignment.submitterFeedback}
                    </small>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
        <label className="label">
          Moderated recommendation
          <select
            className="select"
            name="recommendation"
            defaultValue={currentModeration?.recommendation ?? "advance"}
          >
            <option value="advance">Advance to next round</option>
            <option value="accept">Accept</option>
            <option value="waitlist">Waitlist</option>
            <option value="reject">Reject</option>
          </select>
        </label>
        <label className="label">
          Moderated score (optional)
          <input
            className="field"
            type="number"
            name="moderatedScore"
            min="1"
            max="5"
            step="0.01"
            defaultValue={currentModeration?.moderatedScore ?? ""}
          />
        </label>
        <label className="label">
          Moderation notes
          <textarea
            className="textarea"
            name="notes"
            required
            defaultValue={currentModeration?.notes ?? ""}
          />
        </label>
        <div className="validation-item warn">
          <strong>Confirmation locks the moderation outcome</strong>
          <span>
            It marks this submission decision-ready. A later correction requires
            another explicitly confirmed moderation or reopening a review, which
            supersedes this outcome.
          </span>
        </div>
        <label className="label">
          <span>
            <input type="checkbox" name="confirmed" value="true" /> I confirm
            this moderation outcome should be locked.
          </span>
        </label>
        <div className="page-actions">
          {currentModeration?.status === "confirmed" ? null : (
            <Button
              type="submit"
              name="moderationStatus"
              value="draft"
              disabled={navigation.state !== "idle"}
            >
              Save draft
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            name="moderationStatus"
            value="confirmed"
            disabled={navigation.state !== "idle"}
          >
            Confirm moderation
          </Button>
        </div>
      </Form>
    </Dialog>
  ) : null;
}

export function ReviewReopenDialog() {
  const { navigation, setReopenAssignmentId, reopenAssignment } =
    useEvaluationAdminModel();
  return reopenAssignment ? (
    <Dialog
      title={`Reopen ${reopenAssignment.evaluatorName}'s review`}
      onClose={() => setReopenAssignmentId(null)}
      footer={null}
    >
      <Form
        method="post"
        className="stack"
        onSubmit={() => setReopenAssignmentId(null)}
      >
        <input type="hidden" name="intent" value="reopen-review" />
        <input type="hidden" name="assignmentId" value={reopenAssignment.id} />
        <input type="hidden" name="confirmed" value="true" />
        <label className="label">
          Reason for reopening
          <textarea
            className="textarea"
            name="reason"
            minLength={10}
            required
          />
        </label>
        <div className="validation-item warn">
          <strong>The submitted snapshot remains immutable</strong>
          <span>
            Reopening creates a new review revision
            {reopenAssignment.targetType === "submission"
              ? " and supersedes any current moderation for this submission."
              : ". The frozen session source remains unchanged."}
          </span>
        </div>
        <Button
          type="submit"
          variant="danger"
          disabled={navigation.state !== "idle"}
        >
          Reopen review
        </Button>
      </Form>
    </Dialog>
  ) : null;
}

/** The email release sends, with the subject merged from what is known
 *  before release. Fields only known at release stay as written. */
function DecisionEmailSummary({
  decision,
}: {
  decision: "accepted" | "waitlisted" | "rejected";
}) {
  const { loaderData, selected } = useEvaluationAdminModel();
  const email = loaderData.decisionEmail;
  if (!selected) return null;
  if (!email) {
    return (
      <div className="validation-item warn" role="status">
        <strong>No decision email is published</strong>
        <span>
          Release stops until one is published in Communications. Saving a draft
          does not need one.
        </span>
      </div>
    );
  }
  const recipientName =
    selected.decisionRecipientName ?? selected.decisionRecipientAddress;
  const subject = fillKnownMergeFields(email.subjectTemplate, {
    ...email.eventMergeValues,
    ...(recipientName ? recipientMergeValues(recipientName) : {}),
    "submission.title": selected.title,
    "decision.outcome": decision,
  });
  return (
    <section
      className="card pad decision-email-summary"
      aria-labelledby="decision-email-heading"
    >
      <strong id="decision-email-heading">Email sent on release</strong>
      <dl>
        <div>
          <dt>To</dt>
          <dd>
            {selected.decisionRecipientAddress ??
              "No applicant email address, so release stops."}
          </dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{subject}</dd>
        </div>
        <div>
          <dt>Template</dt>
          <dd>
            {email.name} · version {email.versionNumber}
          </dd>
        </div>
      </dl>
      {email.starterWording ? (
        <p className="help">
          It still uses starter wording; check it in Communications before
          releasing.
        </p>
      ) : null}
    </section>
  );
}

export function DecisionDialog() {
  const {
    actionData,
    loaderData,
    navigation,
    setDecisionId,
    noReviewOverrideConfirmed,
    setNoReviewOverrideConfirmed,
    selected,
    selectedHasCompletedReview,
  } = useEvaluationAdminModel();
  const [decision, setDecision] = useState<
    "accepted" | "waitlisted" | "rejected"
  >("accepted");
  const [sessionTrackId, setSessionTrackId] = useState("");
  const [sessionFormatKey, setSessionFormatKey] = useState("");
  const [sessionDurationMinutes, setSessionDurationMinutes] = useState("60");
  const defaultSessionTrackId =
    selected?.tracks.length === 1 ? selected.tracks[0].id : "";
  const selectedSessionTrack = selected?.tracks.find(
    (track) => track.id === sessionTrackId,
  );
  const sessionTrackSelectionUnavailable = Boolean(
    sessionTrackId && !selectedSessionTrack,
  );
  const matchingSubmittedFormat = loaderData.sessionFormats.find(
    (format) =>
      format.key === selected?.format?.trim().toLowerCase() ||
      format.label.trim().toLowerCase() ===
        selected?.format?.trim().toLowerCase(),
  );
  const selectedSessionFormat = loaderData.sessionFormats.find(
    (format) => format.key === sessionFormatKey,
  );
  const revalidator = useRevalidator();
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decisionErrorRef = useRef<HTMLDivElement>(null);
  const decisionSubmitted = useRef(false);
  const submittingDecision =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "decide";
  const closeDecision = () => {
    setDecisionId(null);
    setNoReviewOverrideConfirmed(false);
    setDecisionError(null);
  };
  // The dialog closes only once the server accepts the decision, so a refusal
  // keeps what the organiser entered. React Router does not reload loader
  // data after a 4xx action, so reload it here: the email summary and the
  // version the next release expects then show what changed.
  useEffect(() => {
    if (submittingDecision) {
      decisionSubmitted.current = true;
      setDecisionError(null);
      return;
    }
    if (!decisionSubmitted.current || navigation.state !== "idle") return;
    decisionSubmitted.current = false;
    if (actionData?.ok === true || actionData?.committed === true) {
      setDecisionId(null);
      setNoReviewOverrideConfirmed(false);
      return;
    }
    const message = actionData?.error ?? actionData?.message;
    if (!message) return;
    setDecisionError(message);
    revalidator.revalidate();
  }, [
    actionData,
    navigation.state,
    revalidator,
    setDecisionId,
    setNoReviewOverrideConfirmed,
    submittingDecision,
  ]);
  useEffect(() => {
    if (decisionError) decisionErrorRef.current?.focus();
  }, [decisionError]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection identity and saved-draft revision deliberately reset the dialog even when the next values happen to match. A reloaded format list does not, so reloading after a refused release keeps the chosen outcome.
  useEffect(() => {
    const draft = selected?.decisionDraft;
    setDecision(draft?.decision ?? "accepted");
    setSessionTrackId(
      draft ? (draft.sessionTrackId ?? "") : defaultSessionTrackId,
    );
    const nextFormatKey = draft
      ? (draft.sessionFormatKey ?? "")
      : (matchingSubmittedFormat?.key ?? "");
    setSessionFormatKey(nextFormatKey);
    const formatDuration = loaderData.sessionFormats.find(
      (format) => format.key === nextFormatKey,
    )?.defaultDurationMinutes;
    setSessionDurationMinutes(
      draft
        ? String(draft.sessionDurationMinutes ?? formatDuration ?? 60)
        : String(formatDuration ?? 60),
    );
  }, [
    defaultSessionTrackId,
    matchingSubmittedFormat?.key,
    selected?.decisionDraft?.decision,
    selected?.decisionDraft?.revisionNumber,
    selected?.decisionDraft?.sessionDurationMinutes,
    selected?.decisionDraft?.sessionFormatKey,
    selected?.decisionDraft?.sessionTrackId,
    selected?.id,
  ]);
  return selected ? (
    <Dialog
      title={`Decision · ${selected.title}`}
      onClose={closeDecision}
      dismissible={!submittingDecision}
      size="lg"
      footer={
        <>
          <Button
            type="submit"
            form="evaluation-decision-form"
            name="release"
            value="false"
            disabled={
              navigation.state !== "idle" || revalidator.state !== "idle"
            }
          >
            Save draft
          </Button>
          {loaderData.canReleaseDecisions ? (
            <Button
              type="submit"
              form="evaluation-decision-form"
              variant="primary"
              name="release"
              value="true"
              disabled={
                navigation.state !== "idle" ||
                revalidator.state !== "idle" ||
                (!selectedHasCompletedReview && !noReviewOverrideConfirmed)
              }
            >
              Release decision
            </Button>
          ) : null}
        </>
      }
    >
      <Form
        id="evaluation-decision-form"
        key={`${selected.id}:${selected.decisionDraft?.revisionNumber ?? "new"}`}
        method="post"
        className="stack"
      >
        {decisionError ? (
          <div
            ref={decisionErrorRef}
            tabIndex={-1}
            className="validation-item error"
            role="alert"
          >
            {decisionError}
          </div>
        ) : null}
        <input type="hidden" name="intent" value="decide" />
        <input type="hidden" name="submissionId" value={selected.id} />
        <input
          type="hidden"
          name="decisionEmailVersionId"
          value={loaderData.decisionEmail?.versionId ?? ""}
        />
        {selected.decisionDraft ? (
          <div className="validation-item info" role="status">
            <strong>
              Resuming decision draft revision{" "}
              {selected.decisionDraft.revisionNumber}
            </strong>
            <span>Saving creates the next audited draft revision.</span>
          </div>
        ) : null}
        {selected.decisionDraft?.decision === "accepted" &&
        selected.decisionDraft.sessionFormatKey === null ? (
          <div className="validation-item warn" role="alert">
            <strong>Choose the current session format again</strong>
            <span>
              This legacy draft did not record an explicit programme format.
              Select the current format before saving or releasing it.
            </span>
          </div>
        ) : null}
        <label className="label">
          Decision
          <select
            className="select"
            name="decision"
            value={decision}
            onChange={(event) =>
              setDecision(
                event.target.value as "accepted" | "waitlisted" | "rejected",
              )
            }
          >
            <option value="accepted">Accept</option>
            <option value="waitlisted">Maybe</option>
            <option value="rejected">Reject</option>
          </select>
        </label>
        <label className="label">
          Acceptance session format
          <select
            className="select"
            name="sessionFormatKey"
            value={sessionFormatKey}
            onChange={(event) => {
              const nextKey = event.target.value;
              setSessionFormatKey(nextKey);
              const formatDuration = loaderData.sessionFormats.find(
                (format) => format.key === nextKey,
              )?.defaultDurationMinutes;
              if (formatDuration) {
                setSessionDurationMinutes(String(formatDuration));
              }
            }}
            required={decision === "accepted"}
            disabled={decision !== "accepted"}
          >
            <option value="">Choose the current session format</option>
            {loaderData.sessionFormats.map((format) => (
              <option key={format.key} value={format.key}>
                {format.label} · {format.defaultDurationMinutes} minutes
              </option>
            ))}
          </select>
          <span className={matchingSubmittedFormat ? "help" : "field-error"}>
            {matchingSubmittedFormat
              ? `Submitted as ${selected.format}. Confirm the current programme format.`
              : `Submitted as ${selected.format || "an unspecified format"}, which no longer matches the event configuration. Map it explicitly before accepting.`}
          </span>
        </label>
        <label className="label">
          Acceptance programme track
          <select
            className="select"
            name="sessionTrackId"
            value={sessionTrackSelectionUnavailable ? "" : sessionTrackId}
            onChange={(event) => setSessionTrackId(event.target.value)}
            required={decision === "accepted"}
            disabled={decision !== "accepted"}
            aria-invalid={sessionTrackSelectionUnavailable || undefined}
            aria-describedby="acceptance-track-help"
          >
            <option value="">Choose the accepted session track</option>
            {selected.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
                {track.name === track.submittedName
                  ? ""
                  : ` (submitted as ${track.submittedName})`}
              </option>
            ))}
          </select>
          <span
            className={
              sessionTrackSelectionUnavailable ? "field-error" : "help"
            }
            id="acceptance-track-help"
            role={sessionTrackSelectionUnavailable ? "alert" : undefined}
          >
            {sessionTrackSelectionUnavailable
              ? "The previously selected programme track is no longer available. Choose an available track again."
              : "The accepted session uses this confirmed programme track. Only tracks submitted with the proposal are available."}
          </span>
        </label>
        <label className="label">
          Rationale
          <textarea
            className="textarea"
            name="rationale"
            defaultValue={selected.decisionDraft?.rationale ?? ""}
            aria-describedby="decision-rationale-audience"
          />
          <span className="help" id="decision-rationale-audience">
            {loaderData.decisionEmail?.includesRationale ? (
              <>
                <strong>Sent to the applicant.</strong> The decision email
                includes the rationale.
              </>
            ) : loaderData.decisionEmail ? (
              "Internal. The decision email does not include the rationale."
            ) : (
              "Internal unless the decision email you publish includes {{decision.rationale}}."
            )}
          </span>
        </label>
        <label className="speaker-confirm">
          <input
            type="checkbox"
            name="includeReviewerFeedback"
            value="true"
            defaultChecked={
              selected.decisionDraft?.includeReviewerFeedback === true &&
              selectedHasCompletedReview
            }
            disabled={!selectedHasCompletedReview}
          />{" "}
          Include submitted reviewer feedback in the decision email
        </label>
        <span className="help">
          Only applicant-facing feedback from submitted or locked reviews in the
          latest completed round is included. Private reviewer notes are never
          sent.
          {loaderData.decisionEmail &&
          !loaderData.decisionEmail.includesFeedback
            ? " The decision email does not include reviewer feedback, so nothing is added."
            : null}
        </span>
        <DecisionEmailSummary decision={decision} />
        <label className="label">
          Acceptance session duration (minutes)
          <input
            className="field"
            type="number"
            name="sessionDurationMinutes"
            min="5"
            max="1440"
            value={sessionDurationMinutes}
            onChange={(event) => setSessionDurationMinutes(event.target.value)}
            required
          />
          <span className="help">
            Used only when an accepted decision is released. This explicit value
            becomes the unscheduled session duration.
          </span>
        </label>
        <div className="card pad">
          <strong>Effect preview</strong>
          <ul>
            <li>
              {selectedHasCompletedReview
                ? "A released decision is linked to the latest completed review round; reviewer scores and moderation remain unchanged."
                : "A released decision is recorded as an audited administrator override without round-level review evidence."}
            </li>
            <li>
              Releasing an acceptance creates a linked unscheduled session,
              speaker relationships and the configured automatic onboarding task
              plan; saving a decision draft does not.
            </li>
            <li>
              {decision === "accepted" && sessionTrackSelectionUnavailable
                ? "The previously selected programme track is no longer available. Choose an available track again."
                : decision === "accepted" && selectedSessionTrack
                  ? `The accepted session will use ${selectedSessionTrack.name}.`
                  : decision === "accepted"
                    ? "Choose the programme track before saving or releasing this acceptance."
                    : "This outcome does not create a programme session."}
            </li>
            <li>
              {decision === "accepted" && selectedSessionFormat
                ? `The accepted session will use the current ${selectedSessionFormat.label} format.`
                : decision === "accepted"
                  ? "Choose the current session format before saving or releasing this acceptance."
                  : "No session format is needed for this outcome."}
            </li>
            <li>
              Release cancels every unfinished reviewer assignment for this
              submission. Submitted and locked review evidence remains in the
              audit history.
            </li>
            <li>
              Release updates applicant-visible state and durably records
              notification work before delivery. Saving a draft does neither.
            </li>
          </ul>
        </div>
        {selectedHasCompletedReview ? null : (
          <label className="validation-item warn">
            <input
              type="checkbox"
              name="confirmedWithoutReview"
              value="true"
              checked={noReviewOverrideConfirmed}
              onChange={(event) =>
                setNoReviewOverrideConfirmed(event.currentTarget.checked)
              }
            />
            <span className="pc-validation-item-copy">
              <strong>Confirm review-evidence override</strong>
              <span>
                No completed review is linked. Releasing now will be audited
                without round-level review evidence.
              </span>
            </span>
          </label>
        )}
        {selected.unclaimedSpeakerCount > 0 ? (
          <div className="validation-item warn">
            <strong>Co-speaker claim required</strong>
            <span>
              {selected.unclaimedSpeakerCount} co-speaker
              {selected.unclaimedSpeakerCount === 1 ? " has" : "s have"} not
              claimed access. Acceptance cannot be released until every speaker
              is linked to an identity.
            </span>
          </div>
        ) : null}
        {loaderData.canReleaseDecisions ? null : (
          <div className="validation-item warn">
            <strong>Release restricted</strong>
            <span>
              This plan reserves final decisions for owners and administrators.
              You can save a draft for review.
            </span>
          </div>
        )}
      </Form>
    </Dialog>
  ) : null;
}

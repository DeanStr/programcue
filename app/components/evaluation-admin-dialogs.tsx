import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const { setReopenAssignmentId, reopenAssignment } = useEvaluationAdminModel();
  const close = useCallback(
    () => setReopenAssignmentId(null),
    [setReopenAssignmentId],
  );
  // A refused reopen keeps the dialog and the typed reason.
  const reopen = useDialogSubmission(
    "reopen-review",
    reopenAssignment?.id ?? null,
    close,
  );
  return reopenAssignment ? (
    <Dialog
      title={`Reopen ${reopenAssignment.evaluatorName}'s review`}
      onClose={close}
      dismissible={!reopen.submitting}
      footer={null}
    >
      <Form method="post" className="stack">
        <DialogSubmissionError submission={reopen} />
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
        <Button type="submit" variant="danger" disabled={reopen.busy}>
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

/** The id of a proposal's decision action (Decide, Change decision or Final)
 *  in the queue and in Results. Only one of those views renders at a time. */
export function decisionActionId(submissionId: string) {
  return `decision-action-${submissionId}`;
}

/** Whether a proposal's decision is released, from any round: its status is
 *  the released outcome until the decision is reopened, as the server
 *  checks before deciding or reopening. */
export function hasReleasedDecision(status: string) {
  return ["accepted", "waitlisted", "rejected"].includes(status);
}

/** A released decision's action. Owners and administrators can change a
 *  released rejection or waitlisting through the reopen workflow; a released
 *  acceptance owns programme records, so it stays final. */
export function ReleasedDecisionAction({
  submissionId,
  finalClassName,
}: {
  submissionId: string;
  finalClassName: string;
}) {
  const { loaderData, setReopenDecisionId } = useEvaluationAdminModel();
  const reopenable =
    loaderData.canManageEvaluationAccess &&
    loaderData.submissions.some(
      (submission) =>
        submission.id === submissionId && submission.reopenableDecision,
    );
  return reopenable ? (
    <Button
      id={decisionActionId(submissionId)}
      type="button"
      size="small"
      onClick={() => setReopenDecisionId(submissionId)}
    >
      Change decision
    </Button>
  ) : (
    <span
      id={decisionActionId(submissionId)}
      tabIndex={-1}
      className={finalClassName}
    >
      Final
    </span>
  );
}

/** Focuses a proposal's decision action once a dialog that changed it has
 *  closed: the button that opened the dialog is replaced. */
function focusDecisionAction(submissionId: string) {
  window.requestAnimationFrame(() =>
    document.getElementById(decisionActionId(submissionId))?.focus(),
  );
}

/** Keeps a dialog open until the server accepts what it submitted, so a
 *  refusal keeps what the organiser entered. React Router does not reload
 *  loader data after a 4xx action, so a refusal reloads it here to show what
 *  changed. `targetId` identifies what the dialog is open for; opening it for
 *  another target clears the previous refusal. */
function useDialogSubmission(
  intent: string,
  targetId: string | null,
  onSuccess: () => void,
) {
  const { actionData, navigation } = useEvaluationAdminModel();
  const revalidator = useRevalidator();
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const submitted = useRef(false);
  const submitting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === intent;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening the dialog for another target clears the previous refusal.
  useEffect(() => {
    setError(null);
  }, [targetId]);
  useEffect(() => {
    if (submitting) {
      submitted.current = true;
      setError(null);
      return;
    }
    if (!submitted.current || navigation.state !== "idle") return;
    submitted.current = false;
    if (actionData?.ok === true || actionData?.committed === true) {
      onSuccess();
      return;
    }
    const message = actionData?.error ?? actionData?.message;
    if (!message) return;
    setError(message);
    revalidator.revalidate();
  }, [actionData, navigation.state, onSuccess, revalidator, submitting]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return {
    submitting,
    busy: navigation.state !== "idle" || revalidator.state !== "idle",
    error,
    errorRef,
  };
}

function DialogSubmissionError({
  submission,
}: {
  submission: ReturnType<typeof useDialogSubmission>;
}) {
  return submission.error ? (
    <div
      ref={submission.errorRef}
      tabIndex={-1}
      className="validation-item error"
      role="alert"
    >
      {submission.error}
    </div>
  ) : null;
}

export function DecisionDialog() {
  const {
    loaderData,
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
  const closeDecision = useCallback(() => {
    setDecisionId(null);
    setNoReviewOverrideConfirmed(false);
  }, [setDecisionId, setNoReviewOverrideConfirmed]);
  const selectedId = selected?.id ?? null;
  const decided = useCallback(() => {
    closeDecision();
    if (selectedId) focusDecisionAction(selectedId);
  }, [closeDecision, selectedId]);
  // A refused release keeps the dialog open and reloads the page data, so
  // the email summary and the version the next release expects show what
  // changed.
  const submission = useDialogSubmission("decide", selectedId, decided);
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
      dismissible={!submission.submitting}
      size="lg"
      footer={
        <>
          <Button
            type="submit"
            form="evaluation-decision-form"
            name="release"
            value="false"
            disabled={submission.busy}
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
                submission.busy ||
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
        <DialogSubmissionError submission={submission} />
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
                : "No review of this proposal is complete, so the audit history records the release as decided without review."}
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
              <strong>Release without a completed review</strong>
              <span>
                No review of this proposal is complete. The audit history
                records that you released this decision without one.
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

/** Reopening a released decision, opened from the queue or Results with
 *  "Change decision". Reopening returns the proposal to Decide, where the
 *  organiser releases the new outcome. */
export function ReopenDecisionDialog() {
  const { loaderData, reopenDecisionId, setReopenDecisionId } =
    useEvaluationAdminModel();
  const submission = loaderData.submissions.find(
    (candidate) => candidate.id === reopenDecisionId,
  );
  const close = useCallback(
    () => setReopenDecisionId(null),
    [setReopenDecisionId],
  );
  const submissionId = submission?.id ?? null;
  const reopened = useCallback(() => {
    close();
    if (submissionId) focusDecisionAction(submissionId);
  }, [close, submissionId]);
  const reopen = useDialogSubmission("reopen-decision", submissionId, reopened);
  const released = submission?.reopenableDecision;
  if (!submission || !released) return null;
  const outcome = released.decision.replaceAll("_", " ");
  const hasLinkedNotification =
    released.notificationEvidenceState === "available" ||
    released.notificationEvidenceState === "retained";
  const originalOutcomeAlreadyAccepted =
    hasLinkedNotification &&
    released.notificationOperationStatus === "completed";
  const laterProviderFailure =
    originalOutcomeAlreadyAccepted &&
    ["failed", "bounced", "suppressed"].includes(released.deliveryStatus ?? "");
  const pendingNotificationCancellable =
    hasLinkedNotification &&
    [
      "queued",
      "queue_failed",
      "received",
      "retrying",
      "failed",
      "partially_failed",
    ].includes(released.notificationOperationStatus ?? "");
  const notificationInProgress =
    hasLinkedNotification && released.notificationOperationStatus === "running";
  return (
    <Dialog
      title={`Change decision · ${submission.title}`}
      description={`The released outcome is ${outcome}. Reopen it here, then decide and release the new outcome.`}
      onClose={close}
      dismissible={!reopen.submitting}
      footer={null}
    >
      <DialogSubmissionError submission={reopen} />
      {notificationInProgress ? (
        <div className="validation-item warn">
          <span className="pc-validation-item-copy">
            <strong>Decision email is still sending</strong>
            <span>
              Reopening is blocked while the original notification operation is
              running. Wait until delivery completes or the send fails, then
              reopen. Messages already sent cannot be recalled.
            </span>
          </span>
        </div>
      ) : (
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="reopen-decision" />
          <input type="hidden" name="submissionId" value={submission.id} />
          <div className="validation-item warn">
            <span className="pc-validation-item-copy">
              <strong>
                {laterProviderFailure
                  ? `The original decision email was later reported as ${released.deliveryStatus}`
                  : originalOutcomeAlreadyAccepted
                    ? "The original decision email was already accepted by the provider"
                    : "Prior messages cannot be recalled"}
              </strong>
              <span>
                Reopening supersedes the released {outcome} outcome and returns
                this proposal to decision-ready state. You must release the
                corrected outcome separately.
                {laterProviderFailure
                  ? " The provider accepted the original send and later reported a terminal failure. That evidence is retained and cannot be recalled."
                  : originalOutcomeAlreadyAccepted
                    ? " The original outcome was already accepted by the provider and cannot be recalled."
                    : pendingNotificationCancellable
                      ? " A pending notification will be cancelled; messages already sent cannot be recalled."
                      : " No pending notification remains to cancel; messages already sent cannot be recalled."}
              </span>
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
            <input type="checkbox" name="confirmed" value="true" required />
            {laterProviderFailure
              ? `I understand the original decision email was later reported as ${released.deliveryStatus} and cannot be recalled.`
              : originalOutcomeAlreadyAccepted
                ? "I understand the original decision email was already accepted by the provider and cannot be recalled."
                : pendingNotificationCancellable
                  ? "I understand a pending notification will be cancelled and messages already sent cannot be recalled."
                  : "I understand there is no pending notification to cancel and messages already sent cannot be recalled."}
          </label>
          <Button
            type="submit"
            variant="danger"
            size="small"
            disabled={reopen.busy}
          >
            Confirm reopen
          </Button>
        </Form>
      )}
    </Dialog>
  );
}

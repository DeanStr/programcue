import { useEffect, useMemo, useState } from "react";
import { Form } from "react-router";

import { Dialog } from "~/components/dialog";
import { EventDateTime } from "~/components/ui/event-date-time";
import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";

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
      footer={null}
    >
      {bulkAssignPreview ? (
        <Form method="post" className="stack" onSubmit={close}>
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
          <div className="page-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setBulkAssignPreview(false)}
            >
              Back
            </button>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              Confirm assignments
            </button>
          </div>
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
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  setBulkSubmissionIds(
                    new Set(
                      visibleSubmissions.map((submission) => submission.id),
                    ),
                  )
                }
              >
                Select visible
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => setBulkSubmissionIds(new Set())}
              >
                Clear
              </button>
            </div>
            {visibleSubmissions.map((submission) => (
              <label key={submission.id} className="validation-item">
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
          <button
            type="button"
            className="btn primary"
            disabled={
              bulkSubmissionIds.size === 0 || !bulkAssignmentTargetLabel
            }
            onClick={() => setBulkAssignPreview(true)}
          >
            Preview {bulkSubmissionIds.size} assignment target
            {bulkSubmissionIds.size === 1 ? "" : "s"}
          </button>
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
        <button className="btn primary" disabled={navigation.state !== "idle"}>
          Close round and advance shortlist
        </button>
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
                  {assignment.recommendation
                    ? ` · ${assignment.recommendation.replaceAll("_", " ")}`
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
            className="input"
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
            <button
              className="btn"
              name="moderationStatus"
              value="draft"
              disabled={navigation.state !== "idle"}
            >
              Save draft
            </button>
          )}
          <button
            className="btn primary"
            name="moderationStatus"
            value="confirmed"
            disabled={navigation.state !== "idle"}
          >
            Confirm moderation
          </button>
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
              ? " and supersedes any current moderation for this submission. Released decisions cannot be reopened here."
              : ". The frozen session source remains unchanged."}
          </span>
        </div>
        <button className="btn danger" disabled={navigation.state !== "idle"}>
          Reopen review
        </button>
      </Form>
    </Dialog>
  ) : null;
}

export function DecisionDialog() {
  const {
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
  const defaultSessionTrackId =
    selected?.tracks.length === 1 ? selected.tracks[0]!.id : "";
  const selectedSessionTrack = selected?.tracks.find(
    (track) => track.id === sessionTrackId,
  );
  const sessionTrackSelectionUnavailable = Boolean(
    sessionTrackId && !selectedSessionTrack,
  );
  useEffect(() => {
    setDecision("accepted");
    setSessionTrackId(defaultSessionTrackId);
  }, [defaultSessionTrackId, selected?.id]);
  return selected ? (
    <Dialog
      title={`Decision · ${selected.title}`}
      onClose={() => {
        setDecisionId(null);
        setNoReviewOverrideConfirmed(false);
      }}
      footer={null}
    >
      <Form
        method="post"
        onSubmit={() => setDecisionId(null)}
        className="stack"
      >
        <input type="hidden" name="intent" value="decide" />
        <input type="hidden" name="submissionId" value={selected.id} />
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
          <textarea className="textarea" name="rationale" />
        </label>
        <label className="speaker-confirm">
          <input
            type="checkbox"
            name="includeReviewerFeedback"
            value="true"
            disabled={!selectedHasCompletedReview}
          />{" "}
          Include submitted reviewer feedback in the decision email
        </label>
        <span className="help">
          Only applicant-facing feedback from submitted or locked reviews in the
          latest completed round is included. Private reviewer notes are never
          sent. Decision templates can render the rationale and selected
          feedback with {"{{decision.rationale}}"} and {"{{decision.feedback}}"}
          .
        </span>
        <label className="label">
          Acceptance session duration (minutes)
          <input
            className="input"
            type="number"
            name="sessionDurationMinutes"
            min="5"
            max="1440"
            defaultValue="60"
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
            <span>
              <strong>Confirm review-evidence override</strong>
              No completed review is linked. Releasing now will be audited
              without round-level review evidence.
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
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            className="btn"
            name="release"
            value="false"
            disabled={navigation.state !== "idle"}
          >
            Save draft
          </button>
          {loaderData.canReleaseDecisions ? (
            <button
              className="btn primary"
              name="release"
              value="true"
              disabled={
                navigation.state !== "idle" ||
                (!selectedHasCompletedReview && !noReviewOverrideConfirmed)
              }
            >
              Release decision
            </button>
          ) : null}
        </div>
      </Form>
    </Dialog>
  ) : null;
}

import { Form } from "react-router";

export function bindEvalDateTime(event: React.FormEvent<HTMLInputElement>) {
  event.currentTarget.toggleAttribute("data-empty", !event.currentTarget.value);
}

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
    <section className="card pad mb pc-eval-progression">
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
                className="input pc-eval-datetime"
                type="datetime-local"
                name="roundOpensAt"
                data-empty=""
                onInput={bindEvalDateTime}
              />
            </label>
            <label className="label">
              Closes ({loaderData.eventTimezone})
              <input
                className="input pc-eval-datetime"
                type="datetime-local"
                name="roundClosesAt"
                data-empty=""
                onInput={bindEvalDateTime}
              />
            </label>
          </div>
          <label className="validation-item">
            <input type="checkbox" name="anonymous" value="true" />
            <span>
              Hide author and co-author identity from reviewers in this round
            </span>
          </label>
          <button
            type="submit"
            className="btn"
            disabled={navigation.state !== "idle"}
          >
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

import { Form, Link } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { RecommendationChoiceFields } from "~/components/evaluation-recommendation-choice-fields";
import { RubricFields } from "~/components/evaluation-rubric-fields";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { EventDateTime } from "~/components/ui/event-date-time";
import { communicationScheduledLocalValue } from "~/modules/communications/communication-time";

export function EvaluationRoundsPanel() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  const { confirm, dialog } = useConfirm();
  const plan = loaderData.plan;
  if (!plan) return null;
  const roundGridClass =
    plan.rounds.length === 1
      ? "grid mb"
      : plan.rounds.length === 2
        ? "grid grid-2 mb"
        : "grid grid-3 mb";
  return (
    <>
      {dialog}
      <div className={roundGridClass}>
        {plan.rounds.map((round) => (
          <section
            id={`evaluation-round-${round.id}`}
            className="card pad pc-eval-round"
            key={round.id}
            tabIndex={round.id === loaderData.focusedRoundId ? -1 : undefined}
          >
            <div className="card-title">
              <h2>Round {round.roundNumber}</h2>
              <span
                className={`status ${round.status === "active" ? "success" : "info"}`}
              >
                {round.status}
              </span>
            </div>
            <h3>{round.name}</h3>
            <p className="subtle">
              Opens:{" "}
              {round.opensAt ? (
                <EventDateTime
                  epochSeconds={round.opensAt}
                  timeZone={loaderData.eventTimezone}
                  showTimeZone
                />
              ) : (
                "immediately"
              )}{" "}
              {" · "} Closes:{" "}
              {round.closesAt ? (
                <EventDateTime
                  epochSeconds={round.closesAt}
                  timeZone={loaderData.eventTimezone}
                  showTimeZone
                />
              ) : (
                "no closing date"
              )}{" "}
              {" · "}
              {round.anonymous ? "blind review" : "identity visible"} {" · "}
              Scorecard v{round.scorecardVersion}
            </p>
            {round.criteria.map((criterion) => (
              <div className="progress-row" key={criterion.id}>
                <span>
                  <span>{criterion.name}</span>
                  <small className="subtle">
                    {" · Response: "}
                    {criterion.inputType === "scale_5"
                      ? "Score 1–5"
                      : criterion.inputType === "scale_10"
                        ? "Score 1–10"
                        : criterion.inputType === "yes_no"
                          ? "Yes / no"
                          : criterion.inputType === "dropdown"
                            ? `Dropdown: ${criterion.options.join(", ")}`
                            : "Free text"}
                  </small>
                </span>
                {criterion.weightPercent > 0 ? (
                  <>
                    <div className="progress">
                      <span style={{ width: `${criterion.weightPercent}%` }} />
                    </div>
                    <b>{criterion.weightPercent}%</b>
                  </>
                ) : (
                  <span className="help">unweighted</span>
                )}
              </div>
            ))}
            <p className="help">
              Overall recommendation:{" "}
              {round.recommendationChoices
                .map((choice) => choice.label)
                .join(" · ")}
            </p>
            {Number(round.runningAiAssessmentCount) > 0 ? (
              <div className="validation-item warn mt" role="status">
                <strong>AI assessment in progress</strong>
                <span>
                  Wait for the running assessment to finish before editing or
                  deleting this round.
                </span>
              </div>
            ) : null}
            {(round.status === "draft" || round.status === "active") &&
            !loaderData.assignments.some(
              (assignment) => assignment.roundId === round.id,
            ) &&
            !loaderData.aiReviewAssessments.some(
              (assessment) => assessment.roundId === round.id,
            ) &&
            Number(round.runningAiAssessmentCount) === 0 ? (
              <details className="mt pc-disclosure">
                <summary>Edit unassigned round and rubric</summary>
                <Form method="post" className="stack mt">
                  <input
                    type="hidden"
                    name="intent"
                    value="update-draft-round"
                  />
                  <input type="hidden" name="roundId" value={round.id} />
                  <input
                    type="hidden"
                    name="roundRevision"
                    value={round.revision}
                  />
                  <label className="label">
                    Round name
                    <input
                      className="input"
                      name="name"
                      defaultValue={round.name}
                      required
                    />
                  </label>
                  <div className="grid grid-2">
                    <label className="label">
                      Opens ({loaderData.eventTimezone})
                      <input
                        className="input pc-eval-datetime"
                        type="datetime-local"
                        name="roundOpensAt"
                        defaultValue={communicationScheduledLocalValue(
                          round.opensAt,
                          loaderData.eventTimezone,
                        )}
                      />
                    </label>
                    <label className="label">
                      Closes ({loaderData.eventTimezone})
                      <input
                        className="input pc-eval-datetime"
                        type="datetime-local"
                        name="roundClosesAt"
                        defaultValue={communicationScheduledLocalValue(
                          round.closesAt,
                          loaderData.eventTimezone,
                        )}
                      />
                    </label>
                  </div>
                  <input
                    type="hidden"
                    name="scorecardId"
                    value={round.scorecardId}
                  />
                  <input
                    type="hidden"
                    name="scorecardVersion"
                    value={round.scorecardVersion}
                  />
                  <label className="validation-item">
                    <input
                      type="checkbox"
                      name="anonymous"
                      value="true"
                      defaultChecked={round.anonymous}
                    />
                    <span>
                      Hide author and co-author identity from reviewers in this
                      round
                    </span>
                  </label>
                  <RecommendationChoiceFields
                    key={`${round.id}:${round.revision}`}
                    choices={round.recommendationChoices}
                  />
                  <RubricFields criteria={round.criteria} />
                  <button
                    type="submit"
                    className="btn"
                    disabled={navigation.state !== "idle"}
                  >
                    Save round
                  </button>
                </Form>
              </details>
            ) : null}
            {round.status === "draft" &&
            round.roundNumber === plan.rounds.at(-1)?.roundNumber &&
            plan.rounds.length > 1 &&
            Number(round.runningAiAssessmentCount) === 0 ? (
              <Form method="post" className="mt">
                <input type="hidden" name="intent" value="delete-draft-round" />
                <input type="hidden" name="roundId" value={round.id} />
                <input
                  type="hidden"
                  name="roundRevision"
                  value={round.revision}
                />
                <input
                  type="hidden"
                  name="planRevision"
                  value={plan.revision}
                />
                {round.reviewers.map((reviewer) => (
                  <input
                    key={reviewer.personId}
                    type="hidden"
                    name="expectedReviewerPersonIds"
                    value={reviewer.personId}
                  />
                ))}
                <input type="hidden" name="confirmed" value="true" />
                <button
                  className="btn small danger"
                  type="button"
                  disabled={navigation.state !== "idle"}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (!form) return;
                    confirm(
                      {
                        title: "Delete unused final round?",
                        description:
                          "Only this unassigned draft round will be removed. Earlier rounds and review history are preserved.",
                        records: [
                          `${round.name} · ${round.criteria.length} criteria · ${round.reviewers.length} reviewers`,
                        ],
                        confirmLabel: "Delete round",
                      },
                      () => form.requestSubmit(),
                    );
                  }}
                >
                  Delete unused round
                </button>
              </Form>
            ) : null}
            <div className="divider" />
            <div className="card-title">
              <div>
                <h3>Round reviewer pool</h3>
                <p className="help">
                  Event evaluator access does not add anyone here automatically.
                </p>
              </div>
              <span className="status info">{round.reviewers.length}</span>
            </div>
            {round.reviewers.length ? (
              <ul className="list-clean">
                {round.reviewers.map((reviewer) => (
                  <li key={reviewer.personId}>
                    <span>
                      <strong>{reviewer.name}</strong>
                      <small className="subtle">{reviewer.email}</small>
                    </span>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="change-round-reviewer"
                      />
                      <input type="hidden" name="roundId" value={round.id} />
                      <input
                        type="hidden"
                        name="personId"
                        value={reviewer.personId}
                      />
                      <input type="hidden" name="operation" value="remove" />
                      <input type="hidden" name="confirmed" value="true" />
                      <button
                        className="btn small"
                        disabled={navigation.state !== "idle"}
                        type="button"
                        onClick={(event) => {
                          const form = event.currentTarget.form;
                          if (!form) return;
                          confirm(
                            {
                              title: "Remove reviewer from this round?",
                              description:
                                "Unfinished assignments in this round will be cancelled and must be reassigned.",
                              records: [`${reviewer.name} · ${round.name}`],
                              confirmLabel: "Remove reviewer",
                            },
                            () => form.requestSubmit(),
                          );
                        }}
                      >
                        Remove
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="help">No reviewers are in this round pool.</p>
            )}
            {loaderData.evaluators.length ? (
              <Form method="post" className="inline-form mt">
                <input
                  type="hidden"
                  name="intent"
                  value="change-round-reviewer"
                />
                <input type="hidden" name="roundId" value={round.id} />
                <select
                  className="select"
                  name="personId"
                  aria-label={`Reviewer for ${round.name}`}
                >
                  {loaderData.evaluators.map((evaluator) => (
                    <option key={evaluator.id} value={evaluator.id}>
                      {evaluator.name} · {evaluator.email}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="btn small"
                  name="operation"
                  value="add"
                  disabled={navigation.state !== "idle"}
                >
                  Add reviewer
                </button>
              </Form>
            ) : null}
            <div className="divider" />
            <div className="card-title">
              <div>
                <h3>Reviewer progress</h3>
                <p className="help">
                  Round-scoped completion updates as reviews are submitted.
                </p>
              </div>
            </div>
            {loaderData.reviewerProgress.some(
              (progress) => progress.roundId === round.id,
            ) ? (
              <Form method="post" className="stack">
                <input
                  type="hidden"
                  name="intent"
                  value="prepare-reviewer-reminder"
                />
                <input type="hidden" name="roundId" value={round.id} />
                <ul className="list-clean">
                  {loaderData.reviewerProgress
                    .filter((progress) => progress.roundId === round.id)
                    .map((progress) => {
                      const outstanding =
                        progress.pendingCount + progress.inProgressCount;
                      const percentage = progress.assignedCount
                        ? Math.round(
                            (progress.completedCount / progress.assignedCount) *
                              100,
                          )
                        : 0;
                      return (
                        <li key={progress.reviewerPersonId}>
                          <span>
                            <strong>{progress.reviewerName}</strong>
                            <small className="subtle">
                              {" · "}
                              {progress.assignedCount} assigned ·{" "}
                              {progress.completedCount} complete · {percentage}%
                              {progress.recusedCount
                                ? ` · ${progress.recusedCount} recused`
                                : ""}
                            </small>
                          </span>
                          {loaderData.canPrepareReviewerReminders &&
                          outstanding > 0 ? (
                            <label className="validation-item">
                              <input
                                type="checkbox"
                                name="reviewerPersonId"
                                value={progress.reviewerPersonId}
                                aria-label={`Include ${progress.reviewerName} in reminder`}
                              />
                              <span>Include in reminder</span>
                            </label>
                          ) : null}
                        </li>
                      );
                    })}
                </ul>
                {loaderData.canPrepareReviewerReminders &&
                loaderData.reviewerProgress.some(
                  (progress) =>
                    progress.roundId === round.id &&
                    progress.pendingCount + progress.inProgressCount > 0,
                ) ? (
                  loaderData.reviewerReminderTemplates.length ? (
                    <div className="inline-form">
                      <select
                        className="select"
                        name="templateVersionId"
                        aria-label={`Reminder template for ${round.name}`}
                        required
                      >
                        {loaderData.reviewerReminderTemplates.map(
                          (template) => (
                            <option key={template.id} value={template.id}>
                              {template.name} · v{template.versionNumber}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        type="submit"
                        className="btn small"
                        disabled={navigation.state !== "idle"}
                      >
                        Prepare selected reminders
                      </button>
                    </div>
                  ) : (
                    <p className="help">
                      <Link to="/admin/communications">
                        Publish an ad hoc email template
                      </Link>{" "}
                      before preparing reviewer reminders.
                    </p>
                  )
                ) : null}
              </Form>
            ) : (
              <p className="help">
                Add reviewers to this round pool to track their progress.
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

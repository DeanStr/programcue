import { useState } from "react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/evaluation-admin";
import { Dialog } from "~/components/dialog";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
} from "~/modules/evaluations/evaluation-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { CommittedRealtimeFailure } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Evaluation · Program Cue" }];

export function decisionActionOutcome(
  notificationStatus: "not_requested" | "queued" | "queue_failed",
  released: boolean,
  realtimeFailure: CommittedRealtimeFailure | null,
) {
  const warnings = [
    notificationStatus === "queue_failed"
      ? "Decision released. Its notification is saved but needs a queue retry."
      : null,
    realtimeFailure?.message ?? null,
  ].filter((warning): warning is string => Boolean(warning));
  if (warnings.length > 0) {
    return { partial: true as const, message: warnings.join(" ") };
  }
  return {
    partial: false as const,
    message: released
      ? "Decision released and notification queued."
      : "Decision draft saved.",
  };
}

export function canReleaseEvaluationDecisions(
  role: string,
  plan: { status: string; decisionRole: string } | null,
) {
  return (
    role === "owner" ||
    role === "administrator" ||
    (role === "committee_chair" &&
      plan?.status === "active" &&
      plan.decisionRole === "committee_chair")
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  await ensureDemoEvaluationData(env);
  const workspace = await new EvaluationService(env).getAdminWorkspace(viewer);
  const unassignedOnly =
    new URL(request.url).searchParams.get("filter") === "unassigned";
  return {
    ...workspace,
    canReleaseDecisions: canReleaseEvaluationDecisions(
      viewer.role,
      workspace.plan,
    ),
    submissions: unassignedOnly
      ? workspace.submissions.filter(
          (submission) => submission.assignmentCount === 0,
        )
      : workspace.submissions,
    unassignedOnly,
    totalSubmissionCount: workspace.submissions.length,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  const values = await request.formData();
  const service = new EvaluationService(env);
  try {
    if (values.get("intent") === "create-default-plan") {
      const planId = await service.savePlan(viewer, {
        revision: 0,
        name: "Programme committee review",
        status: "active",
        rounds: [
          {
            id: `round-${viewer.eventId}-initial`,
            name: "Initial review",
            anonymous: false,
            criteria: [
              {
                id: `criterion-${viewer.eventId}-relevance`,
                name: "Relevance",
                description: "Fit for this event and audience",
                weightPercent: 25,
                position: 0,
              },
              {
                id: `criterion-${viewer.eventId}-originality`,
                name: "Originality",
                description: "Distinctive perspective",
                weightPercent: 20,
                position: 1,
              },
              {
                id: `criterion-${viewer.eventId}-quality`,
                name: "Content quality",
                description: "Clarity and substance",
                weightPercent: 25,
                position: 2,
              },
              {
                id: `criterion-${viewer.eventId}-practical`,
                name: "Practical application",
                description: "Useful attendee outcomes",
                weightPercent: 20,
                position: 3,
              },
              {
                id: `criterion-${viewer.eventId}-expertise`,
                name: "Expertise",
                description: "Credible speaker experience",
                weightPercent: 10,
                position: 4,
              },
            ],
          },
        ],
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_plan",
        entityId: planId,
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Evaluation plan created." };
    }
    if (values.get("intent") === "assign") {
      await service.assign(viewer, {
        roundId: values.get("roundId"),
        submissionIds: [values.get("submissionId")],
        evaluatorPersonIds: [values.get("evaluatorPersonId")],
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluator_assignment",
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Evaluator assigned." };
    }
    if (values.get("intent") === "decide") {
      const released = values.get("release") === "true";
      const result = await service.decide(viewer, {
        submissionId: values.get("submissionId"),
        decision: values.get("decision"),
        rationale: values.get("rationale"),
        release: released,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "submission_decision",
        entityId: result.decisionId,
        changeType: released ? "published" : "updated",
      });
      const outcome = decisionActionOutcome(
        result.notificationStatus,
        released,
        realtimeFailure,
      );
      if (outcome.partial) {
        return data(
          {
            ok: false,
            committed: true,
            entityId: result.decisionId,
            message: outcome.message,
          },
          { status: 207 },
        );
      }
      return {
        ok: true,
        message: outcome.message,
      };
    }
    return data(
      { ok: false, error: "Unsupported evaluation action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError)
      return data(
        {
          ok: false,
          error: error.issues[0]?.message ?? "Invalid evaluation input.",
        },
        { status: 422 },
      );
    if (error instanceof EvaluationRevisionConflictError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationDecisionFinalError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationDecisionAuthorityError)
      return data({ ok: false, error: error.message }, { status: 403 });
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function EvaluationAdmin({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const selected = loaderData.submissions.find(
    (submission) => submission.id === decisionId,
  );
  const activeRound = loaderData.plan?.rounds.find(
    (round) => round.status === "active",
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Evaluation</h1>
          <p>
            Configure review, assign evaluators and release programme decisions.
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href="/review/workbench">
            Open reviewer workspace
          </a>
        </div>
      </div>
      {loaderData.unassignedOnly ? (
        <div className="validation-item warn card pad mb" role="status">
          <strong>Unassigned proposals</strong>
          <span>
            Showing {loaderData.submissions.length} of{" "}
            {loaderData.totalSubmissionCount} submitted records.{" "}
            <a href="/admin/review">Clear filter</a>
          </span>
        </div>
      ) : null}
      {actionData &&
      ("error" in actionData || ("ok" in actionData && !actionData.ok)) ? (
        <div className="validation-item error mb" role="alert">
          {"error" in actionData ? actionData.error : actionData.message}
        </div>
      ) : actionData?.message ? (
        <div className="validation-item ok mb" role="status">
          {actionData.message}
        </div>
      ) : null}
      {!loaderData.plan ? (
        <section className="card pad">
          <h2>Create the evaluation plan</h2>
          <p className="subtle">
            Start with a balanced five-criterion rubric. Rounds and rubrics
            become protected once assignments exist.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="create-default-plan" />
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              Create review plan
            </button>
          </Form>
        </section>
      ) : (
        <>
          <div className="grid grid-4 mb">
            <section className="card metric">
              <span className="label">Plan</span>
              <strong className="value" style={{ fontSize: 18 }}>
                {loaderData.plan.name}
              </strong>
            </section>
            <section className="card metric">
              <span className="label">Rounds</span>
              <strong className="value">{loaderData.plan.rounds.length}</strong>
            </section>
            <section className="card metric">
              <span className="label">Evaluators</span>
              <strong className="value">{loaderData.evaluators.length}</strong>
            </section>
            <section className="card metric">
              <span className="label">Submissions</span>
              <strong className="value">{loaderData.submissions.length}</strong>
            </section>
          </div>
          <div className="grid grid-3 mb">
            {loaderData.plan.rounds.map((round) => (
              <section className="card pad" key={round.id}>
                <div className="card-title">
                  <h2>Round {round.roundNumber}</h2>
                  <span
                    className={`status ${round.status === "active" ? "success" : "info"}`}
                  >
                    {round.status}
                  </span>
                </div>
                <h3>{round.name}</h3>
                {round.criteria.map((criterion) => (
                  <div className="progress-row" key={criterion.id}>
                    <span>{criterion.name}</span>
                    <div className="progress">
                      <span style={{ width: `${criterion.weightPercent}%` }} />
                    </div>
                    <b>{criterion.weightPercent}%</b>
                  </div>
                ))}
              </section>
            ))}
          </div>
          <section className="card pad">
            <div className="card-title">
              <h2>Submission queue</h2>
              <span className="help right">
                Assignments and decisions are audited
              </span>
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
                      const terminal = [
                        "accepted",
                        "waitlisted",
                        "rejected",
                      ].includes(submission.status);
                      const assignable = [
                        "submitted",
                        "assigned",
                        "in_review",
                      ].includes(submission.status);
                      return (
                        <tr key={submission.id}>
                          <td
                            className="pc-record-primary-cell"
                            data-label="Submission"
                          >
                            <div className="pc-record-stack">
                              <strong>{submission.title}</strong>
                              <small className="subtle">
                                {submission.reference}
                              </small>
                              <small className="subtle">
                                {submission.category ?? "Uncategorised"}
                              </small>
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
                          <td
                            data-label="Assign"
                            className="pc-record-action-cell"
                          >
                            {assignable &&
                            activeRound &&
                            loaderData.evaluators.length ? (
                              <Form method="post" className="inline-form">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="assign"
                                />
                                <input
                                  type="hidden"
                                  name="roundId"
                                  value={activeRound.id}
                                />
                                <input
                                  type="hidden"
                                  name="submissionId"
                                  value={submission.id}
                                />
                                <select
                                  className="select"
                                  name="evaluatorPersonId"
                                  aria-label={`Evaluator for ${submission.title}`}
                                >
                                  {loaderData.evaluators.map((evaluator) => (
                                    <option
                                      value={evaluator.id}
                                      key={evaluator.id}
                                    >
                                      {evaluator.name}
                                    </option>
                                  ))}
                                </select>
                                <button className="btn small">Assign</button>
                              </Form>
                            ) : (
                              <span className="help">
                                {!assignable
                                  ? "Review closed"
                                  : !activeRound
                                    ? "No active round"
                                    : "Add an evaluator"}
                              </span>
                            )}
                          </td>
                          <td
                            data-label="Decision"
                            className="pc-record-action-cell"
                          >
                            {terminal ? (
                              <span className="status neutral">Final</span>
                            ) : (
                              <button
                                className="btn small primary"
                                type="button"
                                onClick={() => setDecisionId(submission.id)}
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
              <div className="empty">
                <h2>No submitted proposals</h2>
                <p>Published form submissions will appear here.</p>
              </div>
            )}
          </section>
        </>
      )}
      {selected ? (
        <Dialog
          title={`Decision · ${selected.title}`}
          onClose={() => setDecisionId(null)}
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
              <select className="select" name="decision">
                <option value="accepted">Accept</option>
                <option value="waitlisted">Waitlist</option>
                <option value="rejected">Reject</option>
              </select>
            </label>
            <label className="label">
              Rationale
              <textarea className="textarea" name="rationale" />
            </label>
            <div className="card pad">
              <strong>Effect preview</strong>
              <ul>
                <li>
                  Acceptance creates a linked draft session and speaker
                  relationships.
                </li>
                <li>Release updates applicant-visible state.</li>
                <li>
                  A notification operation is durably recorded before delivery.
                </li>
              </ul>
            </div>
            {selected.unclaimedSpeakerCount > 0 ? (
              <div className="validation-item warn">
                <strong>Co-speaker claim required</strong>
                <span>
                  {selected.unclaimedSpeakerCount} co-speaker
                  {selected.unclaimedSpeakerCount === 1 ? " has" : "s have"} not
                  claimed access. Acceptance cannot be released until every
                  speaker is linked to an identity.
                </span>
              </div>
            ) : null}
            {loaderData.canReleaseDecisions ? null : (
              <div className="validation-item warn">
                <strong>Release restricted</strong>
                <span>
                  This plan reserves final decisions for administrators. You can
                  save a draft for review.
                </span>
              </div>
            )}
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
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
                  disabled={navigation.state !== "idle"}
                >
                  Release decision
                </button>
              ) : null}
            </div>
          </Form>
        </Dialog>
      ) : null}
    </>
  );
}

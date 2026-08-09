import { useEffect, useRef, useState } from "react";
import { data, Link, useFetcher, useNavigate } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/review-workbench";
import { Dialog } from "~/components/dialog";
import { ReviewerShell } from "~/components/reviewer-shell";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Review Workbench · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  await ensureDemoEvaluationData(env);
  const event = await env.DB.prepare(
    "SELECT name FROM events WHERE id = ? AND organisation_id = ?",
  )
    .bind(viewer.eventId, viewer.organisationId)
    .first<{ name: string }>();
  if (!event) throw new Response("Event not found", { status: 404 });
  const selected = new URL(request.url).searchParams.get("assignment");
  const workspace = await new EvaluationService(env).getReviewerWorkspace(
    viewer,
    selected ?? undefined,
  );
  if (selected !== null && workspace.selected?.id !== selected) {
    throw new Response("Review assignment not found", { status: 404 });
  }
  return { viewer, eventName: event.name, workspace };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  const values = await request.formData();
  const service = new EvaluationService(env);
  const intent = String(values.get("intent") ?? "");
  if (intent !== "conflict" && intent !== "save" && intent !== "submit") {
    return data(
      { ok: false, error: "Unsupported review action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "conflict") {
      await service.declareConflict(viewer, {
        assignmentId: values.get("assignmentId"),
        reason: values.get("reason"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluator_assignment",
        entityId: String(values.get("assignmentId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return {
        ok: true,
        message:
          "Conflict declared. The assignment was returned for reassignment.",
      };
    }
    const scores: Record<string, FormDataEntryValue> = {};
    for (const [name, value] of values)
      if (name.startsWith("score:")) scores[name.slice(6)] = value;
    const result = await service.saveReview(viewer, {
      assignmentId: values.get("assignmentId"),
      revision: values.get("revision"),
      scores,
      recommendation: values.get("recommendation") || null,
      confidence: values.get("confidence") || null,
      submitterFeedback: values.get("submitterFeedback"),
      privateNotes: values.get("privateNotes"),
      intent,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "review",
      entityId: result.reviewId,
      changeType: intent === "submit" ? "published" : "updated",
    });
    if (realtimeFailure)
      return data(
        { ...realtimeFailure, revision: result.revision },
        { status: 207 },
      );
    return {
      ok: true,
      message:
        intent === "submit"
          ? `Review submitted with a weighted score of ${result.weightedScore}.`
          : "Review saved.",
      revision: result.revision,
    };
  } catch (error) {
    if (error instanceof ZodError)
      return data(
        { ok: false, error: error.issues[0]?.message ?? "Invalid review." },
        { status: 422 },
      );
    if (error instanceof EvaluationRevisionConflictError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationValidationError)
      return data({ ok: false, error: error.message }, { status: 422 });
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function ReviewWorkbench({ loaderData }: Route.ComponentProps) {
  const { viewer, eventName, workspace } = loaderData;
  const assignmentKey = workspace.selected?.id ?? "no-assignment";
  const fetcher = useFetcher<typeof action>({
    key: `review-workbench:${assignmentKey}`,
  });
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<{
    href: string;
    sawSaveInFlight: boolean;
  } | null>(null);
  const readOnly = workspace.selected?.status === "submitted";
  const revision =
    fetcher.data && "revision" in fetcher.data
      ? fetcher.data.revision
      : (workspace.review?.revision ?? 0);
  const committedWarning = Boolean(
    fetcher.data &&
    "committed" in fetcher.data &&
    fetcher.data.committed === true,
  );
  const saveFailed = Boolean(
    fetcher.data &&
    !committedWarning &&
    ("error" in fetcher.data || ("ok" in fetcher.data && !fetcher.data.ok)),
  );

  useEffect(() => {
    if (
      readOnly ||
      conflictOpen ||
      saveFailed ||
      !dirty ||
      fetcher.state !== "idle"
    )
      return;
    if (!formRef.current) return;
    saveTimer.current = setTimeout(() => {
      if (!formRef.current) return;
      const values = new FormData(formRef.current);
      values.set("intent", "save");
      values.set("revision", String(revision));
      setDirty(false);
      void fetcher.submit(values, { method: "post" });
    }, 1_000);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [
    conflictOpen,
    dirty,
    editVersion,
    fetcher,
    fetcher.state,
    readOnly,
    revision,
    saveFailed,
  ]);

  useEffect(() => {
    if (saveFailed && !readOnly) setDirty(true);
  }, [readOnly, saveFailed]);

  useEffect(() => {
    if (!pendingNavigation) return;
    if (fetcher.state !== "idle") {
      if (!pendingNavigation.sawSaveInFlight) {
        setPendingNavigation((current) =>
          current ? { ...current, sawSaveInFlight: true } : null,
        );
      }
      return;
    }
    if (!pendingNavigation.sawSaveInFlight) return;
    if (saveFailed) {
      setPendingNavigation(null);
      return;
    }
    if (dirty) {
      const started = flushAutosave();
      if (started) {
        setPendingNavigation((current) =>
          current ? { ...current, sawSaveInFlight: false } : null,
        );
      }
      return;
    }
    const href = pendingNavigation.href;
    setPendingNavigation(null);
    void navigate(href);
  }, [dirty, fetcher.state, navigate, pendingNavigation, saveFailed]);

  function clearAutosaveTimer() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }

  function cancelAutosave() {
    clearAutosaveTimer();
    setDirty(false);
  }

  function flushAutosave() {
    if (!dirty || saveFailed || fetcher.state !== "idle" || !formRef.current)
      return false;
    const values = new FormData(formRef.current);
    values.set("intent", "save");
    values.set("revision", String(revision));
    cancelAutosave();
    void fetcher.submit(values, { method: "post" });
    return true;
  }

  function markDirty() {
    if (saveFailed) fetcher.reset();
    setDirty(true);
    setEditVersion((current) => current + 1);
  }

  return (
    <ReviewerShell viewer={viewer} eventName={eventName}>
      <div className="page-head review-page-head">
        <div>
          <h1>Review Workbench</h1>
          <p>Review assigned proposals without losing queue context.</p>
        </div>
        <div className="page-actions">
          <span
            className={`status ${dirty || committedWarning ? "warning" : saveFailed ? "danger" : fetcher.state === "idle" ? "success" : "info"}`}
          >
            {readOnly
              ? "Submitted"
              : fetcher.state !== "idle"
                ? "Saving…"
                : committedWarning
                  ? "Saved · live update delayed"
                  : saveFailed
                    ? "Save failed"
                    : dirty
                      ? "Unsaved changes"
                      : "Saved"}
          </span>
        </div>
      </div>
      {fetcher.data &&
      !committedWarning &&
      ("error" in fetcher.data ||
        ("ok" in fetcher.data && !fetcher.data.ok)) ? (
        <div className="validation-item error mb" role="alert">
          {"error" in fetcher.data ? fetcher.data.error : fetcher.data.message}
        </div>
      ) : fetcher.data && "message" in fetcher.data && fetcher.data.message ? (
        <div
          className={`validation-item ${committedWarning ? "warn" : "ok"} mb`}
          role="status"
        >
          {fetcher.data.message}
        </div>
      ) : null}
      {!workspace.selected || !workspace.submission ? (
        <section className="card pad">
          <div className="empty">
            <h2>No assigned reviews</h2>
            <p>Your active assignments will appear here.</p>
          </div>
        </section>
      ) : (
        <div className="review-layout">
          <aside
            className="card pad review-queue"
            aria-labelledby="review-queue-title"
          >
            <div className="card-title">
              <h2 id="review-queue-title">My queue</h2>
              <span className="status info right">
                {workspace.assignments.length}
              </span>
            </div>
            <nav className="review-queue-list" aria-label="Assigned proposals">
              {workspace.assignments.map((assignment) => {
                const href = `/review/workbench?assignment=${assignment.id}`;
                return (
                  <Link
                    to={href}
                    key={assignment.id}
                    className={`queue-card${assignment.id === workspace.selected?.id ? " active" : ""}`}
                    aria-current={
                      assignment.id === workspace.selected?.id
                        ? "page"
                        : undefined
                    }
                    onClick={(event) => {
                      if (saveFailed) {
                        event.preventDefault();
                        return;
                      }
                      if (dirty || fetcher.state !== "idle") {
                        event.preventDefault();
                        setPendingNavigation({
                          href,
                          sawSaveInFlight: fetcher.state !== "idle",
                        });
                        if (fetcher.state === "idle") flushAutosave();
                      }
                    }}
                  >
                    <span className="pill track">
                      {assignment.category ?? "Uncategorised"}
                    </span>
                    <h3>{assignment.title}</h3>
                    <small className="subtle">
                      {assignment.reference} <span aria-hidden="true">·</span>{" "}
                      {assignment.status.replaceAll("_", " ")}
                    </small>
                  </Link>
                );
              })}
            </nav>
          </aside>
          <article
            className="card pad review-detail"
            aria-labelledby="review-submission-title"
          >
            <span className="status info">
              {workspace.selected.status.replaceAll("_", " ")}
            </span>
            <h2 className="mt" id="review-submission-title">
              {workspace.submission.title}
            </h2>
            <p className="subtle">
              {workspace.submission.blindedReviewing
                ? "Speaker identity hidden"
                : workspace.submission.speakerNames.join(", ") ||
                  "Speaker pending"}{" "}
              <span aria-hidden="true">·</span> {workspace.submission.format}
            </p>
            <div className="divider" />
            <h3>Proposal</h3>
            <dl className="review-answer-list">
              {Object.entries(
                workspace.submission.answers as Record<string, unknown>,
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label.replaceAll("_", " ")}</dt>
                  <dd>
                    {Array.isArray(value)
                      ? value.join(", ")
                      : String(value ?? "")}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
          <section
            className="card review-score"
            aria-labelledby="review-score-title"
          >
            <fetcher.Form
              key={assignmentKey}
              method="post"
              ref={formRef}
              onChange={() => {
                if (!readOnly) markDirty();
              }}
              onSubmit={cancelAutosave}
              className="review-score-form"
            >
              <input
                type="hidden"
                name="assignmentId"
                value={workspace.selected.id}
              />
              <input type="hidden" name="revision" value={revision} />
              <div className="pad review-score-body">
                <div className="card-title review-score-head">
                  <h2 id="review-score-title">Score submission</h2>
                  {!readOnly ? (
                    <button
                      className="btn small danger"
                      type="button"
                      onClick={() => {
                        clearAutosaveTimer();
                        setConflictOpen(true);
                      }}
                    >
                      Declare conflict
                    </button>
                  ) : null}
                </div>
                <div className="review-rubric">
                  {workspace.criteria.map((criterion) => {
                    const inputId = `criterion-${criterion.id}`;
                    const descriptionId = `${inputId}-description`;
                    const weightId = `${inputId}-weight`;
                    return (
                      <div className="review-rubric-row" key={criterion.id}>
                        <div className="review-criterion">
                          <label htmlFor={inputId}>{criterion.name}</label>
                          <small className="subtle" id={descriptionId}>
                            {criterion.description}
                          </small>
                        </div>
                        <span className="review-weight" id={weightId}>
                          {criterion.weightPercent}%
                          <span className="sr-only"> weight</span>
                        </span>
                        <select
                          className="select review-score-select"
                          id={inputId}
                          name={`score:${criterion.id}`}
                          defaultValue={
                            workspace.review?.scores[criterion.id] ?? ""
                          }
                          aria-describedby={`${descriptionId} ${weightId}`}
                          required
                          disabled={readOnly}
                        >
                          <option value="">Score</option>
                          {[1, 2, 3, 4, 5].map((score) => (
                            <option value={score} key={score}>
                              {score} / 5
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
                <div className="review-overall-fields">
                  <label className="label">
                    Recommendation
                    <select
                      className="select"
                      name="recommendation"
                      defaultValue={workspace.review?.recommendation ?? ""}
                      disabled={readOnly}
                    >
                      <option value="">Choose…</option>
                      <option value="accept">Accept</option>
                      <option value="minor_changes">Minor changes</option>
                      <option value="conditional_accept">
                        Conditional accept
                      </option>
                      <option value="waitlist">Waitlist</option>
                      <option value="reject">Reject</option>
                    </select>
                  </label>
                  <label className="label">
                    Confidence
                    <select
                      className="select"
                      name="confidence"
                      defaultValue={workspace.review?.confidence ?? ""}
                      disabled={readOnly}
                    >
                      <option value="">Choose…</option>
                      {[1, 2, 3, 4, 5].map((score) => (
                        <option key={score} value={score}>
                          {score} / 5
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="review-notes">
                  <label className="label">
                    Applicant feedback
                    <textarea
                      className="textarea"
                      name="submitterFeedback"
                      defaultValue={workspace.review?.submitterFeedback ?? ""}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="label">
                    Private notes
                    <textarea
                      className="textarea"
                      name="privateNotes"
                      defaultValue={workspace.review?.privateNotes ?? ""}
                      disabled={readOnly}
                    />
                  </label>
                </div>
              </div>
              <div className="sticky-actions review-actions">
                {readOnly ? (
                  <span className="subtle" role="status">
                    This review is submitted and locked.
                  </span>
                ) : (
                  <>
                    <span className="subtle">
                      Drafts save after one second of inactivity.
                    </span>
                    <span className="spacer" />
                    <button
                      className="btn"
                      type="submit"
                      name="intent"
                      value="save"
                      formNoValidate
                      disabled={fetcher.state !== "idle"}
                    >
                      Save draft
                    </button>
                    <button
                      className="btn primary"
                      type="submit"
                      name="intent"
                      value="submit"
                      disabled={fetcher.state !== "idle"}
                    >
                      Submit review
                    </button>
                  </>
                )}
              </div>
            </fetcher.Form>
          </section>
        </div>
      )}
      {conflictOpen && workspace.selected && !readOnly ? (
        <Dialog
          title="Declare a conflict"
          onClose={() => setConflictOpen(false)}
          footer={null}
        >
          <fetcher.Form
            method="post"
            className="stack"
            onSubmit={() => {
              cancelAutosave();
              setConflictOpen(false);
            }}
          >
            <input type="hidden" name="intent" value="conflict" />
            <input
              type="hidden"
              name="assignmentId"
              value={workspace.selected.id}
            />
            <label className="label">
              Reason
              <textarea
                className="textarea"
                name="reason"
                minLength={10}
                required
              />
            </label>
            <p className="help">
              The review will be recused and returned to the committee for
              reassignment.
            </p>
            <button className="btn danger" disabled={fetcher.state !== "idle"}>
              {fetcher.state === "submitting"
                ? "Declaring…"
                : "Declare and recuse"}
            </button>
          </fetcher.Form>
        </Dialog>
      ) : null}
    </ReviewerShell>
  );
}

import { CheckCircle2, History, RotateCcw } from "lucide-react";
import { data, Form, Link, useActionData } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-content-session";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const historyCursor = new URL(request.url).searchParams.get("history");
  return new ContentManagementService(env).getSession(
    viewer,
    params.sessionId,
    historyCursor,
  );
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new ContentManagementService(env);
  try {
    const result =
      intent === "change-status"
        ? await service.changeStatus(viewer, {
            scheduleVersionId: form.get("scheduleVersionId"),
            sessionId: params.sessionId,
            scheduleRevision: form.get("scheduleRevision"),
            contentRevision: form.get("contentRevision"),
            status: form.get("status"),
            confirmed: form.get("confirmed"),
          })
        : intent === "restore-revision"
          ? await service.restoreRevision(viewer, {
              sessionId: params.sessionId,
              revisionId: form.get("revisionId"),
              scheduleVersionId: form.get("scheduleVersionId"),
              scheduleRevision: form.get("scheduleRevision"),
              contentRevision: form.get("contentRevision"),
              confirmed: form.get("confirmed"),
            })
          : null;
    if (!result) {
      return data(
        { ok: false as const, message: "Unsupported content action." },
        { status: 400 },
      );
    }
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "session",
      entityId: params.sessionId,
      changeType: "updated",
    });
    return data(
      {
        ok: true as const,
        message:
          intent === "restore-revision"
            ? "The selected revision was restored as a new draft revision."
            : `Content status changed to ${"status" in result ? result.status.replaceAll("_", " ") : "draft"}.`,
        warning: realtimeFailure?.message ?? null,
      },
      { status: realtimeFailure ? 207 : 200 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the content action.",
        },
        { status: 422 },
      );
    }
    if (error instanceof ContentManagementStateError) {
      return data(
        { ok: false as const, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Content history · Program Cue" }];

export default function AdminContentSession({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const current = loaderData.current;
  const editable = current.scheduleVersionStatus === "draft";
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Attributed revision history</span>
          <h1>{current.title}</h1>
          <p>
            Review exact prior content, control public approval and restore
            without rewriting history.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/content">
            Content &amp; files
          </Link>
          <Link
            className="btn"
            to={`/admin/schedule?session=${encodeURIComponent(current.sessionId)}`}
          >
            Edit current content
          </Link>
        </div>
      </div>

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>
            {actionData.ok ? "Content updated" : "Action blocked"}
          </strong>
          <span>{actionData.message}</span>
          {actionData.ok && actionData.warning ? (
            <span>{actionData.warning}</span>
          ) : null}
        </div>
      ) : null}

      <section className="card pad mb" aria-labelledby="approval-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">
              Schedule version {current.scheduleVersionNumber}
            </span>
            <h2 id="approval-title">Content approval</h2>
          </div>
          <DomainStatusBadge domain="content" status={current.contentStatus} />
        </div>
        <p>
          {current.description || "No public description has been written."}
        </p>
        <p className="help">
          Public programme, embeds, API and calendar output include only
          approved content from the published schedule snapshot. Saving an edit
          returns this status to Draft.
        </p>
        {current.approvedAt ? (
          <p className="help">
            Approved by {current.approvedByName ?? "a previous administrator"}{" "}
            <EventDateTime
              epochSeconds={current.approvedAt}
              timeZone={current.timezone}
            />
          </p>
        ) : null}
        {editable ? (
          <Form method="post" className="stack mt">
            <input type="hidden" name="intent" value="change-status" />
            <input
              type="hidden"
              name="scheduleVersionId"
              value={current.scheduleVersionId}
            />
            <input
              type="hidden"
              name="scheduleRevision"
              value={current.scheduleRevision}
            />
            <input
              type="hidden"
              name="contentRevision"
              value={current.contentRevision}
            />
            <label className="label">
              Next status
              <select
                className="select"
                name="status"
                defaultValue={current.contentStatus}
              >
                <option value="draft">Draft</option>
                <option value="in_review">In review</option>
                <option value="approved">Approved</option>
                <option value="changes_requested">Changes requested</option>
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" name="confirmed" value="true" required />
              Apply this exact status to the current content revision
            </label>
            <button className="btn primary">
              <CheckCircle2 aria-hidden size={15} /> Change status
            </button>
          </Form>
        ) : (
          <div className="validation-item info mt">
            This published snapshot is immutable. Create the next draft before
            changing approval or restoring content.
          </div>
        )}
      </section>

      <section className="card pad" aria-labelledby="history-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Append-only evidence</span>
            <h2 id="history-title">Content history</h2>
          </div>
          <span className="pill">
            Showing {loaderData.revisions.length} revisions
          </span>
        </div>
        {loaderData.revisions.length ? (
          <ol className="stack">
            {loaderData.revisions.map((revision) => (
              <li className="card inset pad" key={revision.id}>
                <div className="card-title">
                  <div>
                    <strong>
                      Schedule v{revision.scheduleVersionNumber} · content r
                      {revision.revisionNumber}
                    </strong>
                    <small className="subtle">
                      {revision.changeKind.replaceAll("_", " ")} by{" "}
                      {revision.editorName ?? "System baseline"} ·{" "}
                      <EventDateTime
                        epochSeconds={revision.createdAt}
                        timeZone={current.timezone}
                      />
                    </small>
                  </div>
                  <DomainStatusBadge
                    domain="content"
                    status={revision.contentStatus}
                  />
                </div>
                <details>
                  <summary>Inspect exact revision</summary>
                  <dl className="stack mt">
                    <div>
                      <dt>Title</dt>
                      <dd>{revision.title}</dd>
                    </div>
                    <div>
                      <dt>Description</dt>
                      <dd>{revision.description || "No description"}</dd>
                    </div>
                    <div>
                      <dt>Track and format</dt>
                      <dd>
                        {revision.trackName ?? "No track"} · {revision.format} ·{" "}
                        {revision.durationMinutes} minutes
                      </dd>
                    </div>
                    <div>
                      <dt>Visibility</dt>
                      <dd>{revision.visibility}</dd>
                    </div>
                  </dl>
                </details>
                {editable &&
                !(
                  revision.scheduleVersionId === current.scheduleVersionId &&
                  revision.revisionNumber === current.contentRevision
                ) ? (
                  <details className="mt">
                    <summary>Restore this revision</summary>
                    <Form method="post" className="stack mt">
                      <input
                        type="hidden"
                        name="intent"
                        value="restore-revision"
                      />
                      <input
                        type="hidden"
                        name="revisionId"
                        value={revision.id}
                      />
                      <input
                        type="hidden"
                        name="scheduleVersionId"
                        value={current.scheduleVersionId}
                      />
                      <input
                        type="hidden"
                        name="scheduleRevision"
                        value={current.scheduleRevision}
                      />
                      <input
                        type="hidden"
                        name="contentRevision"
                        value={current.contentRevision}
                      />
                      <p className="help">
                        Restoration creates a new Draft revision. It never
                        deletes later history and requires a fresh approval.
                      </p>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          name="confirmed"
                          value="true"
                          required
                        />
                        Restore exactly this title, description, track, format,
                        duration, visibility and resource set
                      </label>
                      <button className="btn">
                        <RotateCcw aria-hidden size={15} /> Restore as new draft
                      </button>
                    </Form>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <div className="pc-empty-state">
            <History aria-hidden className="pc-state-icon" />
            <h3>No recorded revisions</h3>
            <p className="subtle">
              The current baseline and subsequent edits should always be
              recorded. Refresh if this state persists.
            </p>
          </div>
        )}
        {loaderData.nextHistoryCursor ? (
          <div className="page-actions mt">
            <Link
              className="btn"
              to={`?history=${encodeURIComponent(loaderData.nextHistoryCursor)}`}
            >
              Older revisions
            </Link>
          </div>
        ) : null}
      </section>
    </>
  );
}

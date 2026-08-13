import { data, Form, Link, useActionData } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/submissions-admin";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { SubmissionDataGrid } from "~/components/submission-data-grid";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ActionNotice,
  ManualEntryPanels,
  SubmissionAdminDetailPanel,
} from "./submissions-admin-panels";
import type { SubmissionsAdminActionResult } from "./submissions-admin-types";

export const meta: Route.MetaFunction = () => [
  { title: "Submissions · Program Cue" },
];

async function getViewer(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return {
    env,
    viewer: await requireCurrentEventRole(request, env, [
      "owner",
      "administrator",
    ]),
  };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await getViewer(request, context);
  const service = new SubmissionService(env);
  if (params.submissionId) {
    const submission = await service.getAdminSubmission(
      viewer,
      params.submissionId,
    );
    if (!submission)
      throw new Response("Submission not found", { status: 404 });
    return { mode: "detail" as const, submission };
  }
  const url = new URL(request.url);
  const filters = {
    status: url.searchParams.get("status") ?? "",
    category: url.searchParams.get("category") ?? "",
    query: url.searchParams.get("query") ?? "",
  };
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const [submissionPage, routingTeams, routingTracks, sessionFormats] =
    await Promise.all([
      service.listAdminSubmissionPage(viewer, filters, requestedPage),
      service.listRoutingTeams(viewer),
      service.listRoutingTracks(viewer),
      service.getConfiguredSessionFormats(viewer),
    ]);
  return {
    mode: "list" as const,
    ...submissionPage,
    routingTeams,
    routingTracks,
    sessionFormats,
    filters,
    manualApplicationIdempotencyKey: crypto.randomUUID(),
    directSessionIdempotencyKey: crypto.randomUUID(),
  };
}

class InvalidAdminPayloadError extends Error {}

function speakersFrom(formData: FormData) {
  const rawSpeakers = formData.get("speakers");
  if (typeof rawSpeakers !== "string" || rawSpeakers.trim() === "") {
    throw new InvalidAdminPayloadError(
      "The speaker details are missing. Refresh and try again.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(rawSpeakers);
    if (!Array.isArray(parsed)) throw new Error("Speakers must be a list.");
    return parsed;
  } catch {
    throw new InvalidAdminPayloadError(
      "The speaker details are invalid. Refresh and try again.",
    );
  }
}

async function queueAdminWebhook(
  env: CloudflareEnvironment,
  viewer: Awaited<ReturnType<typeof getViewer>>["viewer"],
  input: {
    eventType:
      "submission.created" | "submission.submitted" | "session.created";
    entityType: "submission" | "session";
    entityId: string;
    idempotencyKey: string;
    data: Record<string, unknown>;
  },
) {
  try {
    const deliveries = await new WebhookService(env).queueEvent(viewer, {
      ...input,
      correlationId: crypto.randomUUID(),
    });
    return deliveries.some((delivery) => delivery.status === "queue_failed")
      ? "One or more outbound webhook deliveries require a retry."
      : null;
  } catch (error) {
    console.error("Failed to record submission administration webhook", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return "The outbound webhook event could not be recorded.";
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await getViewer(request, context);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  const service = new SubmissionService(env);
  try {
    if (intent === "create_direct_session") {
      const speakers = speakersFrom(formData);
      const duplicateCheck = await new PersonDuplicateService(
        env,
      ).findLikelyDuplicates(viewer, speakers);
      if (
        duplicateCheck.matches.length &&
        formData.get("confirmDuplicatePeople") !== "yes"
      ) {
        return data<SubmissionsAdminActionResult>(
          {
            ok: false,
            message:
              "Review the likely existing people before creating this direct session.",
            duplicateCheck: {
              intent: "create_direct_session",
              matches: duplicateCheck.matches,
              truncated: duplicateCheck.truncated,
            },
          },
          { status: 409 },
        );
      }
      const created = await service.createDirectSession(viewer, {
        idempotencyKey: formData.get("idempotencyKey"),
        title: formData.get("title"),
        description: formData.get("description"),
        trackId: formData.get("trackId"),
        format: formData.get("format"),
        durationMinutes: formData.get("durationMinutes"),
        speakers,
      });
      const warning = [created.invitationWarning, created.webhookWarning]
        .filter(Boolean)
        .join(" ");
      return data<SubmissionsAdminActionResult>(
        {
          ok: !warning,
          partial: Boolean(warning),
          message: warning
            ? `Direct session created in the unscheduled programme. Speaker participation must be confirmed before publication; portal invitation acceptance is separate. ${warning}`
            : "Direct session created in the unscheduled programme. Speaker participation must be confirmed before publication; portal invitation acceptance is separate.",
        },
        { status: warning ? 207 : 200 },
      );
    }
    if (intent === "create_manual_application") {
      const routedTeamIds = formData
        .getAll("routedTeamIds")
        .map(String)
        .filter(Boolean);
      const speakers = speakersFrom(formData);
      const duplicateCheck = await new PersonDuplicateService(
        env,
      ).findLikelyDuplicates(viewer, [
        {
          name: formData.get("submitterName"),
          email: formData.get("submitterEmail"),
        },
        ...speakers,
      ]);
      if (
        duplicateCheck.matches.length &&
        formData.get("confirmDuplicatePeople") !== "yes"
      ) {
        return data<SubmissionsAdminActionResult>(
          {
            ok: false,
            message:
              "Review the likely existing people before creating this manual application.",
            duplicateCheck: {
              intent: "create_manual_application",
              matches: duplicateCheck.matches,
              truncated: duplicateCheck.truncated,
            },
          },
          { status: 409 },
        );
      }
      const submissionId = await service.createManualApplication(viewer, {
        idempotencyKey: formData.get("idempotencyKey"),
        title: formData.get("title"),
        description: formData.get("description"),
        trackIds: formData.getAll("trackIds").map(String),
        format: formData.get("format"),
        submitterName: formData.get("submitterName"),
        submitterEmail: formData.get("submitterEmail"),
        routedTeamIds,
        speakers,
      });
      const warnings = await Promise.all([
        queueAdminWebhook(env, viewer, {
          eventType: "submission.created",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.created:${submissionId}`,
          data: {
            source: "administrator_manual_entry",
            status: "submitted",
            routedTeamIds,
          },
        }),
        queueAdminWebhook(env, viewer, {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.submitted:${submissionId}`,
          data: {
            source: "administrator_manual_entry",
            status: "submitted",
            routedTeamIds,
          },
        }),
      ]);
      const warning = warnings.filter(Boolean).join(" ");
      return data<SubmissionsAdminActionResult>(
        {
          ok: !warning,
          partial: Boolean(warning),
          message: warning
            ? `Manual application created with an immutable source snapshot. ${warning}`
            : "Manual application created with an immutable source snapshot.",
        },
        { status: warning ? 207 : 200 },
      );
    }
    if (intent === "resend_co_speaker") {
      const result = await service.resendCoSpeakerInvitation(
        viewer,
        String(formData.get("invitationId") ?? ""),
      );
      return data<SubmissionsAdminActionResult>(
        {
          ok: result.status === "queued",
          partial: result.status === "queue_failed",
          operationId: result.operationId,
          message:
            result.status === "queued"
              ? "A new expiring co-speaker invitation was queued. The previous link is invalid."
              : "The invitation intent was saved, but Queue dispatch failed. Retry the linked operation.",
        },
        { status: result.status === "queued" ? 200 : 207 },
      );
    }
    return data<SubmissionsAdminActionResult>(
      { ok: false, message: "Unsupported submission action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data<SubmissionsAdminActionResult>(
        {
          ok: false,
          message:
            error.issues[0]?.message ?? "Review the submitted record details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof InvalidAdminPayloadError) {
      return data<SubmissionsAdminActionResult>(
        { ok: false, message: error.message },
        { status: 400 },
      );
    }
    if (
      error instanceof SubmissionStateError ||
      error instanceof SubmissionRevisionConflictError ||
      error instanceof EvaluationStateError
    ) {
      return data<SubmissionsAdminActionResult>(
        { ok: false, message: error.message },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SubmissionsAdmin({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    SubmissionsAdminActionResult | undefined;
  if (loaderData.mode === "detail")
    return (
      <SubmissionAdminDetailPanel
        submission={loaderData.submission}
        actionResult={actionData}
      />
    );
  const { submissions, routingTeams, filters, page, hasNext } = loaderData;
  const submitted = submissions.filter(
    (submission) => submission.status === "submitted",
  ).length;
  const drafts = submissions.filter(
    (submission) => submission.status === "draft",
  ).length;
  const categories = loaderData.categories;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Submissions</h1>
          <p>
            Track applications from private draft through programme decision.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/submissions/form">
            Form Builder
          </Link>
        </div>
      </div>
      <ActionNotice result={actionData} />
      <div className="grid grid-4 mb">
        <section className="card metric">
          <div className="label">Visible records</div>
          <div className="value">{submissions.length}</div>
        </section>
        <section className="card metric">
          <div className="label">Submitted</div>
          <div className="value">{submitted}</div>
        </section>
        <section className="card metric">
          <div className="label">Private drafts</div>
          <div className="value">{drafts}</div>
        </section>
        <section className="card metric">
          <div className="label">Reviewer teams</div>
          <div className="value">
            {
              new Set(
                submissions.flatMap((submission) => submission.routedTeamIds),
              ).size
            }
          </div>
        </section>
      </div>
      <section className="card pad mb">
        <Form method="get" className="form-row" role="search">
          <label className="label">
            Search
            <input
              className="field"
              name="query"
              defaultValue={filters.query}
              placeholder="Title, submitter or email"
            />
          </label>
          <label className="label">
            Status
            <select
              className="select"
              name="status"
              defaultValue={filters.status}
            >
              <option value="">All statuses</option>
              {[
                "draft",
                "submitted",
                "assigned",
                "in_review",
                "decision_ready",
                "accepted",
                "waitlisted",
                "rejected",
                "withdrawn",
              ].map((status) => (
                <option key={status} value={status}>
                  {statusPresentation("submission", status).label}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Track
            <select
              className="select"
              name="category"
              defaultValue={filters.category}
            >
              <option value="">All tracks</option>
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <div className="page-actions" style={{ alignSelf: "end" }}>
            <button className="btn primary" type="submit">
              Apply filters
            </button>
            <Link className="btn" to="/admin/submissions">
              Clear
            </Link>
          </div>
        </Form>
      </section>
      <section className="card pad mb">
        <div className="card-title">
          <h2>Application queue</h2>
          <span className="help right">D1 · tenant scoped · newest first</span>
        </div>
        <SubmissionDataGrid
          key={`${page}:${filters.status}:${filters.category}:${filters.query}`}
          submissions={submissions}
        />
        {page > 1 || hasNext ? (
          <nav className="page-actions mt" aria-label="Submission pages">
            {page > 1 ? (
              <Link
                className="btn"
                to={`?${new URLSearchParams({
                  ...filters,
                  page: String(page - 1),
                })}`}
              >
                ← Newer
              </Link>
            ) : null}
            <span className="pill">Page {page}</span>
            {hasNext ? (
              <Link
                className="btn"
                to={`?${new URLSearchParams({
                  ...filters,
                  page: String(page + 1),
                })}`}
              >
                Older →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
      <ManualEntryPanels
        routingTeams={routingTeams}
        routingTracks={loaderData.routingTracks}
        sessionFormats={loaderData.sessionFormats}
        manualApplicationIdempotencyKey={
          loaderData.manualApplicationIdempotencyKey
        }
        directSessionIdempotencyKey={loaderData.directSessionIdempotencyKey}
        actionResult={actionData}
      />
    </>
  );
}

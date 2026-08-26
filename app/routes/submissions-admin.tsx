import { data, Form, useActionData } from "react-router";
import { SubmissionDataGrid } from "~/components/submission-data-grid";
import { Button, ButtonLink } from "~/components/ui/button";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { adminRecordBreadcrumbLabelAtPath } from "~/modules/administration/admin-route-breadcrumb";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import {
  type AdminSubmissionView,
  adminSubmissionSearchParams,
  parseAdminSubmissionView,
} from "~/modules/submissions/submission-admin-view";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/submissions-admin";
import {
  ActionNotice,
  SubmissionAdminDetailPanel,
} from "./submissions-admin-panels";
import type {
  SubmissionAdminQueueNavigation,
  SubmissionsAdminActionResult,
} from "./submissions-admin-types";

export const handle = {
  adminRecordBreadcrumbLabel(data: unknown) {
    if (!data || typeof data !== "object" || !("mode" in data)) {
      throw new Error("The applications route did not provide its mode.");
    }
    if ((data as { mode: unknown }).mode === "list") return null;
    if ((data as { mode: unknown }).mode !== "detail") {
      throw new Error("The applications route provided an invalid mode.");
    }
    return adminRecordBreadcrumbLabelAtPath(data, ["submission", "title"]);
  },
};

export const meta: Route.MetaFunction = ({ loaderData }) => [
  {
    title:
      loaderData?.mode === "detail"
        ? `${loaderData.submission.title} · Application · Program Cue`
        : "Applications · Program Cue",
  },
];

function queueSearchParams(view: AdminSubmissionView, page: number) {
  const search = listSearchParams(view, page);
  search.set("queue", "1");
  return search;
}

function listSearchParams(view: AdminSubmissionView, page: number) {
  return adminSubmissionSearchParams(view, page);
}

function detailHref(
  submissionId: string,
  view: AdminSubmissionView,
  page: number,
) {
  return `/admin/submissions/${encodeURIComponent(submissionId)}?${queueSearchParams(view, page)}`;
}

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
    const url = new URL(request.url);
    const queueValues = url.searchParams.getAll("queue");
    const createdValues = url.searchParams.getAll("created");
    const attentionValues = url.searchParams.getAll("attention");
    if (
      queueValues.length > 1 ||
      createdValues.length > 1 ||
      attentionValues.length > 1 ||
      (queueValues[0] !== undefined && queueValues[0] !== "1") ||
      (createdValues[0] !== undefined && createdValues[0] !== "1") ||
      (attentionValues[0] !== undefined && attentionValues[0] !== "1") ||
      (attentionValues[0] === "1" && createdValues[0] !== "1")
    ) {
      throw new Response("Invalid application detail context", {
        status: 400,
      });
    }
    const fromQueue = queueValues[0] === "1";
    const view = parseAdminSubmissionView(url);
    const { filters, page } = view;
    const [submission, queueContext] = await Promise.all([
      service.getAdminSubmission(viewer, params.submissionId),
      fromQueue
        ? service.getAdminSubmissionQueueContext(
            viewer,
            params.submissionId,
            filters,
            page,
          )
        : Promise.resolve(null),
    ]);
    if (!submission)
      throw new Response("Submission not found", { status: 404 });
    let queueNavigation: SubmissionAdminQueueNavigation | null = null;
    if (fromQueue) {
      if (!queueContext) {
        throw new Error("Submission queue context was not resolved.");
      }
      queueNavigation = {
        backHref: `/admin/submissions?${listSearchParams(view, page)}`,
        previous: queueContext.previous
          ? {
              title: queueContext.previous.title,
              href: detailHref(
                queueContext.previous.id,
                view,
                queueContext.previous.page,
              ),
            }
          : null,
        next: queueContext.next
          ? {
              title: queueContext.next.title,
              href: detailHref(
                queueContext.next.id,
                view,
                queueContext.next.page,
              ),
            }
          : null,
      };
    }
    return { mode: "detail" as const, submission, queueNavigation };
  }
  const url = new URL(request.url);
  const view = parseAdminSubmissionView(url);
  const { filters, page: requestedPage } = view;
  const submissionPage = await service.listAdminSubmissionPage(
    viewer,
    filters,
    requestedPage,
  );
  return {
    mode: "list" as const,
    ...submissionPage,
    filters,
    view,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await getViewer(request, context);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  const service = new SubmissionService(env);
  try {
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
    | SubmissionsAdminActionResult
    | undefined;
  if (loaderData.mode === "detail")
    return (
      <SubmissionAdminDetailPanel
        submission={loaderData.submission}
        actionResult={actionData}
        queueNavigation={loaderData.queueNavigation}
      />
    );
  const { filters, view, summary, results } = loaderData;
  const { submissions, page, totalPages, matchingTotal, firstItem, lastItem } =
    results;
  const categories = loaderData.categories;
  return (
    <div className="submissions-workspace">
      <div className="page-head">
        <div>
          <h1>Applications</h1>
          <p>
            Track applications from private draft through programme decision.
          </p>
        </div>
        <div className="page-actions">
          <ButtonLink to="/admin/submissions/form">Form Builder</ButtonLink>
          <ButtonLink variant="primary" to="/admin/submissions/new">
            New
          </ButtonLink>
        </div>
      </div>
      <ActionNotice result={actionData} />
      <p className="submissions-pulse-line">
        {[
          `${summary.eventTotal} ${summary.eventTotal === 1 ? "application" : "applications"}`,
          ...(
            [
              "assigned",
              "waitlisted",
              "submitted",
              "draft",
              "in_review",
              "decision_ready",
              "accepted",
              "rejected",
              "withdrawn",
            ] as const
          )
            .filter((status) => summary.byStatus[status] > 0)
            .map(
              (status) =>
                `${summary.byStatus[status]} ${statusPresentation("submission", status).label.toLowerCase()}`,
            ),
          matchingTotal === 0
            ? "no matching rows"
            : `${firstItem}–${lastItem} shown`,
        ].join(" · ")}
      </p>
      <section className="submissions-board">
        <Form method="get" className="submissions-toolbar" role="search">
          <input type="hidden" name="columns" value={view.columns.join(",")} />
          <label className="submissions-filter">
            <span>Search</span>
            <input
              className="field"
              name="query"
              defaultValue={filters.query}
              placeholder="Title, submitter or email"
            />
          </label>
          <label className="submissions-filter">
            <span>Routing</span>
            <select
              className="select"
              name="routing"
              defaultValue={filters.routing}
            >
              <option value="">All routing states</option>
              <option value="missing_automatic">
                No automatic review-team route
              </option>
              <option value="manual_override">Manual routing override</option>
            </select>
          </label>
          <label className="submissions-filter">
            <span>Status</span>
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
          <label className="submissions-filter">
            <span>Track</span>
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
          <label className="submissions-filter submissions-filter-sort">
            <span>Sort</span>
            <select
              className="select"
              name="sort"
              defaultValue={filters.sort ?? "submittedAt-desc"}
            >
              <option value="submittedAt-desc">Newest activity</option>
              <option value="submittedAt-asc">Oldest activity</option>
              <option value="title-asc">Application title A–Z</option>
              <option value="title-desc">Application title Z–A</option>
            </select>
          </label>
          <label className="submissions-filter">
            <span>Density</span>
            <select
              className="select"
              name="density"
              defaultValue={view.density}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <div className="submissions-filter-actions">
            <Button variant="primary" size="small" type="submit">
              Apply
            </Button>
            <ButtonLink size="small" to="/admin/submissions">
              Clear
            </ButtonLink>
          </div>
        </Form>
        <SubmissionDataGrid
          key={`${page}:${filters.status}:${filters.category}:${filters.query}:${filters.routing}:${filters.sort}:${view.columns.join(",")}:${view.density}`}
          submissions={submissions}
          columns={view.columns}
          density={view.density}
          sort={filters.sort ?? "submittedAt-desc"}
          detailSearchParams={queueSearchParams(view, page).toString()}
        />
        {totalPages > 1 ? (
          <nav className="submissions-pager" aria-label="Submission pages">
            {page > 1 ? (
              <ButtonLink
                size="small"
                to={`?${listSearchParams(view, page - 1)}`}
              >
                ← Previous
              </ButtonLink>
            ) : null}
            <span className="pill">
              Page {page} of {totalPages}
            </span>
            {page < totalPages ? (
              <ButtonLink
                size="small"
                to={`?${listSearchParams(view, page + 1)}`}
              >
                Next →
              </ButtonLink>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}

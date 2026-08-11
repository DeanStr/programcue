import { useState } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/submissions-admin";
import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { DuplicatePersonMatch } from "~/modules/people/person-duplicate-service.server";
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

export const meta: Route.MetaFunction = () => [
  { title: "Submissions · Program Cue" },
];

type ActionResult = {
  ok: boolean;
  partial?: boolean;
  message: string;
  operationId?: string;
  duplicateCheck?: {
    intent: "create_direct_session" | "create_manual_application";
    matches: DuplicatePersonMatch[];
    truncated: boolean;
  };
};

type SpeakerInput = { name: string; email: string; biography: string };

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
  const [submissionPage, routingTeams, sessionFormats] = await Promise.all([
    service.listAdminSubmissionPage(viewer, filters, requestedPage),
    service.listRoutingTeams(viewer),
    service.getConfiguredSessionFormats(viewer),
  ]);
  return {
    mode: "list" as const,
    ...submissionPage,
    routingTeams,
    sessionFormats,
    filters,
    manualApplicationIdempotencyKey: crypto.randomUUID(),
    directSessionIdempotencyKey: crypto.randomUUID(),
  };
}

class InvalidAdminPayloadError extends Error {}

function speakersFrom(formData: FormData) {
  try {
    const parsed: unknown = JSON.parse(
      String(formData.get("speakers") ?? "[]"),
    );
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
        return data<ActionResult>(
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
      const sessionId = await service.createDirectSession(viewer, {
        idempotencyKey: formData.get("idempotencyKey"),
        title: formData.get("title"),
        description: formData.get("description"),
        format: formData.get("format"),
        durationMinutes: formData.get("durationMinutes"),
        speakers,
      });
      const warning = await queueAdminWebhook(env, viewer, {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}`,
        data: { source: "administrator_direct_entry" },
      });
      return data<ActionResult>(
        {
          ok: !warning,
          partial: Boolean(warning),
          message: warning
            ? `Direct session created in the unscheduled programme. ${warning}`
            : "Direct session created in the unscheduled programme.",
        },
        { status: warning ? 207 : 200 },
      );
    }
    if (intent === "create_manual_application") {
      const routedTeamId = String(formData.get("routedTeamId") ?? "") || null;
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
        return data<ActionResult>(
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
        category: formData.get("category"),
        format: formData.get("format"),
        submitterName: formData.get("submitterName"),
        submitterEmail: formData.get("submitterEmail"),
        routedTeamId,
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
            status: routedTeamId ? "assigned" : "submitted",
          },
        }),
        queueAdminWebhook(env, viewer, {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.submitted:${submissionId}`,
          data: {
            source: "administrator_manual_entry",
            status: routedTeamId ? "assigned" : "submitted",
          },
        }),
      ]);
      const warning = warnings.filter(Boolean).join(" ");
      return data<ActionResult>(
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
      return data<ActionResult>(
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
    return data<ActionResult>(
      { ok: false, message: "Unsupported submission action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data<ActionResult>(
        {
          ok: false,
          message:
            error.issues[0]?.message ?? "Review the submitted record details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof InvalidAdminPayloadError) {
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: 400 },
      );
    }
    if (
      error instanceof SubmissionStateError ||
      error instanceof SubmissionRevisionConflictError
    ) {
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

type SubmissionDetail = NonNullable<
  Awaited<ReturnType<SubmissionService["getAdminSubmission"]>>
>;

function ActionNotice({ result }: { result?: ActionResult }) {
  if (!result) return null;
  return (
    <div
      className={`validation-item ${result.ok ? "ok" : result.partial ? "warn" : "error"} card pad mb`}
      role={result.ok || result.partial ? "status" : "alert"}
    >
      <strong>{result.ok ? "✓" : "△"}</strong>
      <span>
        {result.message}{" "}
        {result.operationId ? (
          <Link to={`/admin/operations?operation=${result.operationId}`}>
            Open operation
          </Link>
        ) : null}
      </span>
    </div>
  );
}

function Detail({
  submission,
  actionResult,
}: {
  submission: SubmissionDetail;
  actionResult?: ActionResult;
}) {
  const navigation = useNavigation();
  const labels = new Map(
    submission.schema?.fields.map((field) => [field.id, field.label]) ?? [],
  );
  return (
    <>
      <div className="page-head">
        <div>
          <Link className="subtle" to="/admin/submissions">
            ← All submissions
          </Link>
          <h1>{submission.title}</h1>
          <p>
            {submission.submitterName} · {submission.submitterEmail}
          </p>
        </div>
        <div className="page-actions">
          <DomainStatusBadge domain="submission" status={submission.status} />
          <span className="pill">
            {submission.versionNumber
              ? `Form v${submission.versionNumber}`
              : "Manual entry"}
          </span>
        </div>
      </div>
      <ActionNotice result={actionResult} />
      <div className="grid grid-2">
        <section className="card pad">
          <div className="card-title">
            <h2>Application snapshot</h2>
            <span className="subtle right">Immutable source answers</span>
          </div>
          <dl className="stack">
            {Object.entries(submission.answers).map(([key, value]) => (
              <div key={key}>
                <dt className="label">{labels.get(key) ?? key}</dt>
                <dd style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                  {Array.isArray(value) ? value.join(", ") : value || "—"}
                </dd>
              </div>
            ))}
            {Object.entries(submission.uploads).map(([fieldId, reference]) => (
              <div key={fieldId}>
                <dt className="label">
                  {labels.get(fieldId) ?? fieldId} · private file
                </dt>
                <dd style={{ margin: "4px 0 0" }}>
                  <Link to={`/review/files/${reference.assetId}`}>
                    Download scanned video
                  </Link>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <aside className="stack">
          <section className="card pad">
            <h2>Routing</h2>
            <p>
              <span className="label">Category</span>
              <br />
              {submission.category ?? "Uncategorised"}
            </p>
            <p>
              <span className="label">Assigned team</span>
              <br />
              {submission.routedTo}
            </p>
            <p>
              <span className="label">Format</span>
              <br />
              {submission.format ?? "Not set"}
            </p>
            <p>
              <span className="label">Submitted</span>
              <br />
              {submission.submittedAt ? (
                <EventDateTime
                  epochSeconds={submission.submittedAt}
                  timeZone={submission.eventTimezone}
                  showTimeZone
                />
              ) : (
                "Draft"
              )}
            </p>
          </section>
          <section className="card pad">
            <div className="card-title">
              <h2>Speakers</h2>
              <span className="pill right">{submission.speakers.length}</span>
            </div>
            {submission.speakers.map((speaker) => (
              <div className="row-main mt" key={speaker.id}>
                <span className="avatar sm">
                  {speaker.name
                    .split(/\s+/)
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <span>
                  <strong>
                    {speaker.name}
                    {speaker.isPrimary ? " · Primary" : ""}
                  </strong>
                  <small>
                    {speaker.email} · {speaker.invitationStatus}
                  </small>
                  {speaker.biography ? (
                    <small>Current biography: {speaker.biography}</small>
                  ) : null}
                  {speaker.submittedBiography &&
                  speaker.submittedBiography !== speaker.biography ? (
                    <small>
                      Submitted biography: {speaker.submittedBiography}
                    </small>
                  ) : null}
                </span>
                {!speaker.isPrimary &&
                ["pending", "sent", "expired"].includes(
                  speaker.invitationStatus,
                ) ? (
                  <Form method="post" className="right">
                    <input
                      type="hidden"
                      name="_intent"
                      value="resend_co_speaker"
                    />
                    <input
                      type="hidden"
                      name="invitationId"
                      value={speaker.id}
                    />
                    <button
                      className="btn small"
                      type="submit"
                      disabled={navigation.state !== "idle"}
                    >
                      Resend
                    </button>
                  </Form>
                ) : null}
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}

function SpeakerFields({
  speakers,
  setSpeakers,
}: {
  speakers: SpeakerInput[];
  setSpeakers(speakers: SpeakerInput[]): void;
}) {
  return (
    <fieldset className="card pad">
      <legend>
        <strong>Speakers</strong>
      </legend>
      {speakers.map((speaker, index) => (
        <div className="grid grid-3 mb" key={index}>
          <label className="label">
            Speaker {index + 1} name
            <input
              className="field"
              required
              value={speaker.name}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, name: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          <label className="label">
            Email
            <input
              className="field"
              type="email"
              required
              value={speaker.email}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, email: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          <label className="label">
            Biography
            <textarea
              className="textarea"
              maxLength={5_000}
              value={speaker.biography}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, biography: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          {index > 0 ? (
            <button
              className="btn small danger"
              type="button"
              onClick={() =>
                setSpeakers(
                  speakers.filter((_, speakerIndex) => speakerIndex !== index),
                )
              }
            >
              Remove speaker
            </button>
          ) : null}
        </div>
      ))}
      <button
        className="btn small"
        type="button"
        onClick={() =>
          setSpeakers([...speakers, { name: "", email: "", biography: "" }])
        }
      >
        + Add co-speaker
      </button>
    </fieldset>
  );
}

function DuplicatePersonWarning({
  result,
  intent,
}: {
  result?: ActionResult;
  intent: "create_direct_session" | "create_manual_application";
}) {
  const check = result?.duplicateCheck;
  if (!check || check.intent !== intent) return null;
  return (
    <PersonDuplicateWarning
      id={`${intent}-duplicate`}
      matches={check.matches}
      truncated={check.truncated}
    />
  );
}

function ManualEntryPanels({
  routingTeams,
  sessionFormats,
  manualApplicationIdempotencyKey,
  directSessionIdempotencyKey,
  actionResult,
}: {
  routingTeams: Array<{ id: string; name: string }>;
  sessionFormats: Awaited<
    ReturnType<SubmissionService["getConfiguredSessionFormats"]>
  >;
  manualApplicationIdempotencyKey: string;
  directSessionIdempotencyKey: string;
  actionResult?: ActionResult;
}) {
  const navigation = useNavigation();
  const [directSpeakers, setDirectSpeakers] = useState<SpeakerInput[]>([
    { name: "", email: "", biography: "" },
  ]);
  const [applicationSpeakers, setApplicationSpeakers] = useState<
    SpeakerInput[]
  >([{ name: "", email: "", biography: "" }]);
  const [directFormat, setDirectFormat] = useState(sessionFormats[0]!.key);
  const [directDuration, setDirectDuration] = useState(
    sessionFormats[0]!.defaultDurationMinutes,
  );
  return (
    <div className="stack">
      <details className="card pad">
        <summary>
          <strong>Enter an application manually</strong>{" "}
          <span className="subtle">
            preserve an administrator-entered abstract and speaker snapshot
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input
            type="hidden"
            name="_intent"
            value="create_manual_application"
          />
          <input
            type="hidden"
            name="idempotencyKey"
            value={manualApplicationIdempotencyKey}
          />
          <input
            type="hidden"
            name="speakers"
            value={JSON.stringify(applicationSpeakers)}
          />
          <div className="grid grid-2">
            <label className="label">
              Session title
              <input className="field" name="title" required />
            </label>
            <label className="label">
              Category
              <input className="field" name="category" required />
            </label>
            <label className="label">
              Format
              <select
                className="select"
                name="format"
                defaultValue="Presentation"
              >
                <option>Keynote</option>
                <option>Presentation</option>
                <option>Panel</option>
                <option>Workshop</option>
                <option>Breakout</option>
                <option>Other</option>
              </select>
            </label>
            <label className="label">
              Evaluation team
              <select className="select" name="routedTeamId" defaultValue="">
                <option value="">Unassigned</option>
                {routingTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="label">
            Abstract or description
            <textarea className="textarea" name="description" required />
          </label>
          <div className="grid grid-2">
            <label className="label">
              Submitter name
              <input className="field" name="submitterName" required />
            </label>
            <label className="label">
              Submitter email
              <input
                className="field"
                name="submitterEmail"
                type="email"
                required
              />
            </label>
          </div>
          <SpeakerFields
            speakers={applicationSpeakers}
            setSpeakers={setApplicationSpeakers}
          />
          <DuplicatePersonWarning
            result={actionResult}
            intent="create_manual_application"
          />
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.formData?.get("_intent") === "create_manual_application"
              ? "Creating…"
              : "Create manual application"}
          </button>
        </Form>
      </details>

      <details className="card pad">
        <summary>
          <strong>Create a guaranteed direct session</strong>{" "}
          <span className="subtle">
            for sponsors, invited speakers or confirmed programme items
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="_intent" value="create_direct_session" />
          <input
            type="hidden"
            name="idempotencyKey"
            value={directSessionIdempotencyKey}
          />
          <input
            type="hidden"
            name="speakers"
            value={JSON.stringify(directSpeakers)}
          />
          <div className="form-row">
            <label className="label">
              Session title
              <input className="field" name="title" required />
            </label>
            <label className="label">
              Format
              <select
                className="select"
                name="format"
                value={directFormat}
                onChange={(changeEvent) => {
                  const next = sessionFormats.find(
                    (format) => format.key === changeEvent.target.value,
                  );
                  if (!next) return;
                  setDirectFormat(next.key);
                  setDirectDuration(next.defaultDurationMinutes);
                }}
              >
                {sessionFormats.map((format) => (
                  <option key={format.key} value={format.key}>
                    {format.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Duration (minutes)
              <input
                className="field"
                name="durationMinutes"
                type="number"
                min={5}
                max={480}
                value={directDuration}
                onChange={(changeEvent) =>
                  setDirectDuration(Number(changeEvent.target.value))
                }
                required
              />
            </label>
          </div>
          <label className="label">
            Description
            <textarea className="textarea" name="description" />
          </label>
          <SpeakerFields
            speakers={directSpeakers}
            setSpeakers={setDirectSpeakers}
          />
          <DuplicatePersonWarning
            result={actionResult}
            intent="create_direct_session"
          />
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.formData?.get("_intent") === "create_direct_session"
              ? "Creating…"
              : "Create unscheduled session"}
          </button>
        </Form>
      </details>
    </div>
  );
}

export default function SubmissionsAdmin({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  if (loaderData.mode === "detail")
    return (
      <Detail submission={loaderData.submission} actionResult={actionData} />
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
          <div className="label">Category routes</div>
          <div className="value">
            {
              new Set(
                submissions
                  .map((submission) => submission.routedTeamId)
                  .filter(Boolean),
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
            Category
            <select
              className="select"
              name="category"
              defaultValue={filters.category}
            >
              <option value="">All categories</option>
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

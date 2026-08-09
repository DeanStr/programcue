import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FileCheck2,
  LockKeyhole,
  Mic2,
  UploadCloud,
  UserRound,
} from "lucide-react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/speaker-dashboard";
import { SpeakerShell } from "~/components/speaker-shell";
import { FilePolicyError } from "~/modules/files/file-policy";
import { FileService } from "~/modules/files/file-service.server";
import {
  ensureDemoSpeakerData,
  requireSpeakerViewer,
} from "~/modules/speakers/demo.server";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Speaker Dashboard · Program Cue" }];

function formatEvent(event: {
  timezone: string;
  startsAt: number;
  endsAt: number;
  venue: string | null;
  city: string | null;
}) {
  // Event setup persists whole-day boundaries at UTC midnight; format those as calendar dates.
  const format = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    dateLabel: `${format.format(new Date(event.startsAt * 1_000))}–${format.format(new Date(event.endsAt * 1_000))}`,
    locationLabel: [event.venue, event.city].filter(Boolean).join(", "),
  };
}

async function participant(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireSpeakerViewer(request, env, env.DEFAULT_EVENT_ID);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await participant(request, context);
  const [portal, tasks] = await Promise.all([
    new SpeakerService(env).getPortal(viewer),
    new TaskService(env).listParticipantTasks(viewer),
  ]);
  return { portal, tasks, viewer };
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the highlighted information.";
  if (
    error instanceof FilePolicyError ||
    error instanceof TaskStateError ||
    error instanceof SpeakerProfileConflictError
  )
    return error.message;
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await participant(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "save-profile") {
      await new SpeakerService(env).updateProfile(viewer, {
        revision: form.get("revision"),
        name: form.get("name"),
        biography: form.get("biography"),
        pronunciation: form.get("pronunciation"),
        organisationName: form.get("organisationName"),
        jobTitle: form.get("jobTitle"),
        publish: form.get("publish") ? "true" : "false",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "person",
        entityId: viewer.personId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Profile saved to D1." });
    }
    if (intent === "complete-task") {
      const taskId = String(form.get("taskId") ?? "");
      await new TaskService(env).completeParticipant(viewer, {
        taskId,
        revision: form.get("revision"),
        confirmed: form.get("confirmed") ?? "false",
        text: form.get("text") || undefined,
        url: form.get("url") || undefined,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Task updated." });
    }
    if (intent === "comment") {
      const taskId = String(form.get("taskId") ?? "");
      await new TaskService(env).addComment(
        viewer,
        taskId,
        String(form.get("body") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Comment added." });
    }
    if (intent === "upload-task") {
      const taskId = String(form.get("taskId") ?? "");
      const file = form.get("file");
      if (!(file instanceof File))
        throw new FilePolicyError("Choose a file to upload.");
      const taskService = new TaskService(env);
      await taskService.assertFileEvidenceUploadAllowed(viewer, taskId);
      const fileService = new FileService(env);
      const upload = await fileService.uploadParticipantFile(
        viewer,
        { targetType: "task", targetId: taskId, assetKind: "task_evidence" },
        file,
      );
      try {
        await taskService.submitFileEvidence(viewer, taskId, upload.assetId);
      } catch (submissionError) {
        try {
          await fileService.discardUnattachedTaskUpload(viewer, upload);
        } catch (cleanupError) {
          throw new AggregateError(
            [submissionError, cleanupError],
            "Task evidence submission failed and the uploaded file could not be discarded.",
          );
        }
        throw submissionError;
      }
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "File stored privately in R2 and submitted for scanning. It remains quarantined until a scanner reports it clean.",
      });
    }
    if (intent === "upload-file") {
      const file = form.get("file");
      if (!(file instanceof File))
        throw new FilePolicyError("Choose a file to upload.");
      const kind = String(form.get("assetKind") ?? "");
      const upload = await new FileService(env).uploadParticipantFile(
        viewer,
        { targetType: "person", targetId: viewer.personId, assetKind: kind },
        file,
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "file_asset",
        entityId: upload.assetId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "File stored privately in R2. Signature validation passed; malware scanning is still pending, so the file remains quarantined.",
      });
    }
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  } catch (error) {
    const message = errorMessage(error);
    if (message) {
      return data(
        { ok: false, message },
        {
          status:
            error instanceof SpeakerProfileConflictError ||
            error instanceof TaskStateError
              ? 409
              : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function statusClass(status: string) {
  if (["completed", "waived", "active", "published"].includes(status))
    return "success";
  if (["overdue", "rejected", "infected", "failed"].includes(status))
    return "danger";
  if (["blocked", "pending", "submitted"].includes(status)) return "warning";
  return "info";
}

function dueLabel(epoch: number | null, timezone: string) {
  return epoch
    ? `${new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))} (${timezone})`
    : "No due date";
}

export default function SpeakerDashboard({ loaderData }: Route.ComponentProps) {
  const { portal, tasks, viewer } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const finished = tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const progress = tasks.length
    ? Math.round((finished / tasks.length) * 100)
    : 100;
  const next = tasks.find(
    (task) => !["completed", "waived"].includes(task.status),
  );
  const waitingOnTeam = next
    ? ["submitted", "blocked"].includes(next.status)
    : false;
  const eventLabel = formatEvent(portal.event);
  const sessionDateTime = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: portal.event.timezone,
  });
  return (
    <SpeakerShell
      event={{ name: portal.event.name, ...eventLabel }}
      viewer={viewer}
    >
      <div className="speaker-portal-head">
        <div>
          <span className="pc-page-eyebrow">Speaker workspace</span>
          <h1>Welcome back, {portal.profile.name.split(/\s+/)[0]}</h1>
          <p className="subtle">
            Everything the event team needs from you, with clear privacy and
            review states.
          </p>
        </div>
        <div className="speaker-readiness">
          <strong>{progress}%</strong>
          <span>onboarding complete</span>
        </div>
      </div>

      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.ok ? (
            <CheckCircle2 aria-hidden size={19} />
          ) : (
            <AlertTriangle aria-hidden size={19} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{actionData.ok ? "Saved" : "Action needed"}</strong>
            <div>{actionData.message}</div>
          </div>
        </div>
      ) : null}

      <section className="card next-action mt">
        <div>
          <span
            className={`status ${next ? statusClass(next.status) : "success"}`}
          >
            {next
              ? waitingOnTeam
                ? "Waiting"
                : "Next action"
              : "Onboarding complete"}
          </span>
          <h2>{next?.title ?? "You are ready for the event"}</h2>
          <p className="subtle">
            {next
              ? waitingOnTeam
                ? next.status === "submitted"
                  ? "Submitted for administrator review. No further action is required until the event team responds."
                  : "This requirement is waiting for its prerequisites to be completed."
                : next.description
              : "There are no outstanding requirements right now."}
          </p>
          {next ? (
            <a className="btn primary" href={`#task-${next.id}`}>
              Open task
            </a>
          ) : null}
        </div>
        <div
          className="speaker-progress-visual"
          role="progressbar"
          aria-label={`${progress}% complete`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="gauge compact"
            style={{ "--pct": progress } as React.CSSProperties}
          >
            <div className="gauge-inner">
              <strong>{progress}%</strong>
              <small>Complete</small>
            </div>
          </div>
        </div>
      </section>

      <section className="mt" id="sessions">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Programme</span>
            <h2>My sessions</h2>
          </div>
          <span className="pill right">{portal.sessions.length}</span>
        </div>
        <div className="grid grid-2">
          {portal.sessions.length ? (
            portal.sessions.map((session) => (
              <article
                className="card pad speaker-session-card"
                key={session.id}
              >
                <div className="card-title">
                  <span className={`status ${statusClass(session.status)}`}>
                    {session.status}
                  </span>
                  <span className="pill right">
                    {session.durationMinutes} min
                  </span>
                </div>
                <h3>{session.title}</h3>
                <p className="subtle">{session.description}</p>
                <dl className="speaker-session-meta">
                  <div>
                    <dt>Role</dt>
                    <dd>{session.roleLabel ?? "Speaker"}</dd>
                  </div>
                  <div>
                    <dt>When</dt>
                    <dd>
                      {session.startsAt
                        ? sessionDateTime.format(
                            new Date(session.startsAt * 1_000),
                          )
                        : "Scheduling pending"}
                    </dd>
                  </div>
                  <div>
                    <dt>Room</dt>
                    <dd>{session.roomName ?? "To be confirmed"}</dd>
                  </div>
                </dl>
              </article>
            ))
          ) : (
            <div className="pc-empty-state">
              <Mic2 aria-hidden className="pc-state-icon" />
              <h2>No linked sessions</h2>
              <p className="subtle">
                Ask the event team to connect your accepted session to this
                speaker identity.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mt" id="tasks">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Onboarding</span>
            <h2>My tasks</h2>
          </div>
          <span className="pill right">
            {finished} of {tasks.length} complete
          </span>
        </div>
        <div className="speaker-task-list">
          {tasks.length ? (
            tasks.map((task) => {
              const blocked = task.dependencies.some(
                (dependency) =>
                  !["completed", "waived"].includes(dependency.status),
              );
              return (
                <article
                  className="card pad speaker-task"
                  id={`task-${task.id}`}
                  key={task.id}
                >
                  <div className="speaker-task-main">
                    <div className="card-title">
                      <span className={`status ${statusClass(task.status)}`}>
                        {task.status.replaceAll("_", " ")}
                      </span>
                      <span className={`impact ${task.impact} right`}>
                        {task.impact} impact
                      </span>
                    </div>
                    <h3>{task.title}</h3>
                    <p className="subtle">{task.description}</p>
                    <p className="tiny subtle">
                      <Clock3 aria-hidden size={13} />{" "}
                      {dueLabel(task.dueAt, portal.event.timezone)}
                    </p>
                    {blocked ? (
                      <div className="validation-item warn">
                        <LockKeyhole aria-hidden size={16} />
                        <span>
                          Complete{" "}
                          {task.dependencies
                            .filter(
                              (dependency) =>
                                !["completed", "waived"].includes(
                                  dependency.status,
                                ),
                            )
                            .map((dependency) => dependency.title)
                            .join(", ")}{" "}
                          first.
                        </span>
                      </div>
                    ) : null}
                    {task.comments.map((comment) => (
                      <blockquote key={comment.id} className="task-comment">
                        <strong>{comment.authorName}</strong>
                        <p>{comment.body}</p>
                      </blockquote>
                    ))}
                  </div>
                  <div className="speaker-task-action">
                    {!["completed", "waived", "submitted"].includes(
                      task.status,
                    ) &&
                    !blocked &&
                    task.taskType === "file_upload" ? (
                      <Form
                        method="post"
                        encType="multipart/form-data"
                        className="stack"
                      >
                        <input
                          type="hidden"
                          name="intent"
                          value="upload-task"
                        />
                        <input type="hidden" name="taskId" value={task.id} />
                        <label className="label">
                          Evidence file
                          <input
                            className="field"
                            type="file"
                            name="file"
                            required
                          />
                        </label>
                        <button
                          className="btn primary"
                          disabled={navigation.state !== "idle"}
                        >
                          <UploadCloud aria-hidden size={15} /> Upload to
                          quarantine
                        </button>
                      </Form>
                    ) : null}
                    {!["completed", "waived", "submitted"].includes(
                      task.status,
                    ) &&
                    !blocked &&
                    task.taskType !== "file_upload" &&
                    task.taskType !== "administrator_only" ? (
                      <Form method="post" className="stack">
                        <input
                          type="hidden"
                          name="intent"
                          value="complete-task"
                        />
                        <input type="hidden" name="taskId" value={task.id} />
                        <input
                          type="hidden"
                          name="revision"
                          value={task.revision}
                        />
                        {task.taskType === "short_form" ? (
                          <label className="label">
                            Response
                            <textarea
                              className="textarea"
                              name="text"
                              required
                            />
                          </label>
                        ) : task.taskType === "link_visit" ? (
                          <label className="label">
                            Visited link
                            <input
                              className="field"
                              name="url"
                              type="url"
                              required
                            />
                          </label>
                        ) : (
                          <label className="speaker-confirm">
                            <input type="checkbox" name="confirmed" required />{" "}
                            I confirm this requirement
                          </label>
                        )}
                        <button
                          className="btn primary"
                          disabled={navigation.state !== "idle"}
                        >
                          <CheckCircle2 aria-hidden size={15} /> Complete task
                        </button>
                      </Form>
                    ) : null}
                    {task.status === "submitted" ? (
                      <div className="validation-item warn">
                        <Clock3 aria-hidden size={16} />
                        <span>
                          {task.taskType === "file_upload"
                            ? "Stored in quarantine. Scanning and administrator approval are pending."
                            : "Submitted for administrator review."}
                        </span>
                      </div>
                    ) : null}
                    {["completed", "waived"].includes(task.status) ? (
                      <div className="speaker-complete-mark">
                        <CheckCircle2 aria-hidden />
                        <strong>
                          {task.status === "waived"
                            ? "Waived by the event team"
                            : "Completed"}
                        </strong>
                      </div>
                    ) : null}
                  </div>
                  <details className="speaker-task-comment">
                    <summary>Add a comment</summary>
                    <Form method="post" className="form-row mt">
                      <input type="hidden" name="intent" value="comment" />
                      <input type="hidden" name="taskId" value={task.id} />
                      <label className="label">
                        Message
                        <input
                          className="field"
                          name="body"
                          required
                          maxLength={2_000}
                        />
                      </label>
                      <button className="btn" type="submit">
                        Send
                      </button>
                    </Form>
                  </details>
                </article>
              );
            })
          ) : (
            <div className="pc-empty-state">
              <CheckCircle2 aria-hidden className="pc-state-icon" />
              <h2>No onboarding tasks</h2>
              <p className="subtle">
                The event team has not assigned any requirements.
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-2 mt">
        <section className="card pad" id="files">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Private R2 files</span>
              <h2>Files and versions</h2>
            </div>
            <FileCheck2 aria-hidden className="subtle" />
          </div>
          <p className="subtle">
            Every upload is signature-checked and quarantined. Downloads appear
            only after an external malware scanner reports a clean result.
          </p>
          <Form
            method="post"
            encType="multipart/form-data"
            className="stack speaker-upload-form"
          >
            <input type="hidden" name="intent" value="upload-file" />
            <label className="label">
              File purpose
              <select
                className="select"
                name="assetKind"
                defaultValue="headshot"
              >
                <option value="headshot">
                  Headshot (JPG, PNG, WebP · 10 MB)
                </option>
                <option value="slides">
                  Presentation slides (PDF, PPT, PPTX · 90 MB)
                </option>
                <option value="supporting_document">
                  Supporting document (90 MB)
                </option>
              </select>
            </label>
            <label className="label">
              Choose file
              <input className="field" name="file" type="file" required />
            </label>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              <UploadCloud aria-hidden size={15} /> Upload privately
            </button>
          </Form>
          <div className="stack mt">
            {portal.files.map((file) => (
              <div className="file-version-row" key={file.id}>
                <span className="file-kind-icon">
                  <FileCheck2 aria-hidden size={17} />
                </span>
                <span>
                  <strong>{file.kind.replaceAll("_", " ")}</strong>
                  <small>
                    {file.filename} · version {file.versionNumber ?? "—"}
                  </small>
                </span>
                <span
                  className={`status ${statusClass(file.scanStatus ?? file.status)}`}
                >
                  {file.scanStatus === "pending"
                    ? "Quarantined"
                    : (file.scanStatus ?? file.status)}
                </span>
                {file.currentVersionId && file.downloadReleasedAt ? (
                  <a
                    className="icon-btn"
                    href={`/speaker/files/${file.id}`}
                    aria-label={`Download ${file.downloadFilename}`}
                  >
                    <Download aria-hidden size={15} />
                  </a>
                ) : (
                  <LockKeyhole
                    aria-label="Download locked pending scan"
                    size={15}
                    className="subtle"
                  />
                )}
                {file.versions.length > 1 ? (
                  <details className="file-history">
                    <summary>{file.versions.length} versions</summary>
                    {file.versions.map((version) => (
                      <small key={version.id}>
                        v{version.versionNumber} · {version.filename} · scan{" "}
                        {version.scanStatus}
                      </small>
                    ))}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="card pad" id="profile">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Public identity</span>
              <h2>Speaker profile</h2>
            </div>
            <UserRound aria-hidden className="subtle" />
          </div>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="save-profile" />
            <input
              type="hidden"
              name="revision"
              value={portal.profile.revision}
            />
            <label className="label">
              Display name
              <input
                className="field"
                name="name"
                defaultValue={portal.profile.name}
                required
              />
            </label>
            <div className="form-row">
              <label className="label">
                Job title
                <input
                  className="field"
                  name="jobTitle"
                  defaultValue={portal.profile.jobTitle ?? ""}
                />
              </label>
              <label className="label">
                Organisation
                <input
                  className="field"
                  name="organisationName"
                  defaultValue={portal.profile.organisationName ?? ""}
                />
              </label>
            </div>
            <label className="label">
              Name pronunciation
              <input
                className="field"
                name="pronunciation"
                defaultValue={portal.profile.pronunciation ?? ""}
              />
            </label>
            <label className="label">
              Biography
              <textarea
                className="textarea"
                name="biography"
                defaultValue={portal.profile.biography ?? ""}
                minLength={40}
                required
                rows={7}
              />
            </label>
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="publish"
                defaultChecked={portal.profile.profileStatus === "published"}
              />{" "}
              Publish this profile when saved
            </label>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              Save profile
            </button>
          </Form>
        </section>
      </div>
    </SpeakerShell>
  );
}

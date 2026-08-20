import {
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  LockKeyhole,
} from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import {
  DirectMultipartUpload,
  DirectUploadCompletionConflictError,
} from "~/components/direct-multipart-upload";
import {
  type SpeakerPortal,
  type SpeakerTask,
  speakerDueLabel,
} from "~/components/speaker-dashboard-panel-shared";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { requireValue } from "~/lib/required-value";
import { maximumMegabytes } from "~/modules/files/file-policy";
import type { ParticipantTaskEvidenceVersion } from "~/modules/files/file-service.server";
import { UserFacingError } from "~/platform/user-facing-error";

async function attachTaskEvidence(
  taskId: string,
  upload: { assetId: string; versionId: string },
) {
  const response = await fetch("/files/task-evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      assetId: upload.assetId,
      versionId: upload.versionId,
    }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    committed?: boolean;
    error?: string;
    message?: string;
    discarded?: boolean;
  };
  if (payload.committed)
    return {
      message: `Your file was attached. ${payload.message ?? "The organisers may not have been notified yet; no action is needed from you."}`,
    };
  if (payload.discarded)
    throw new DirectUploadCompletionConflictError(
      payload.error ??
        "The task changed, so the unattached upload was discarded. Reload before choosing the file again.",
    );
  if (!response.ok || payload.ok !== true)
    throw new UserFacingError(
      payload.error ??
        payload.message ??
        "The uploaded file could not be attached to this task.",
    );
  return { message: payload.message };
}

function AcknowledgementCompleteControls({
  busy,
  label = "I confirm this requirement",
}: {
  busy: boolean;
  label?: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="speaker-task-complete">
      <label className="speaker-confirm">
        <input
          type="checkbox"
          name="confirmed"
          required
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        {label}
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={busy || !confirmed}
      >
        Complete task
      </button>
    </div>
  );
}

function isFinished(status: string) {
  return status === "completed" || status === "waived";
}

function isBlocked(dependencies: SpeakerTask["dependencies"]) {
  return dependencies.some(
    (dependency) => !["completed", "waived"].includes(dependency.status),
  );
}

export function taskEvidenceVersionStatus(
  version: Pick<
    ParticipantTaskEvidenceVersion,
    "uploadStatus" | "signatureStatus" | "scanStatus" | "releasedAt"
  >,
) {
  if (version.uploadStatus === "failed")
    return { label: "Upload failed", tone: "danger" } as const;
  if (version.uploadStatus === "aborted")
    return { label: "Upload aborted", tone: "danger" } as const;
  if (version.signatureStatus === "invalid")
    return { label: "Invalid file signature", tone: "danger" } as const;
  if (version.signatureStatus === "failed")
    return { label: "Signature validation failed", tone: "danger" } as const;
  if (version.scanStatus === "infected")
    return { label: "Malware detected", tone: "danger" } as const;
  if (version.scanStatus === "failed")
    return { label: "Malware scan failed", tone: "danger" } as const;
  if (version.uploadStatus === "requested")
    return { label: "Upload requested", tone: "info" } as const;
  if (version.uploadStatus === "uploading")
    return { label: "Uploading", tone: "info" } as const;
  if (version.signatureStatus === "pending")
    return { label: "Signature validation pending", tone: "info" } as const;
  if (version.scanStatus === "pending")
    return { label: "Malware scan pending", tone: "info" } as const;
  if (version.releasedAt === null)
    return { label: "Release pending", tone: "warning" } as const;
  return { label: "Released", tone: "success" } as const;
}

export function SpeakerTasksPanel({
  portal,
  tasks,
  finished,
  busy,
  intentId,
}: {
  portal: SpeakerPortal;
  tasks: Array<
    SpeakerTask & { fileVersions: ParticipantTaskEvidenceVersion[] }
  >;
  finished: number;
  busy: boolean;
  intentId: string;
}) {
  const ordered = [...tasks].sort((left, right) => {
    const leftDone = isFinished(left.status) ? 1 : 0;
    const rightDone = isFinished(right.status) ? 1 : 0;
    return leftDone - rightDone;
  });
  return (
    <section className="mt speaker-work" id="tasks">
      <h2 className="sr-only">Assigned tasks</h2>
      <p className="sr-only">
        {finished} of {tasks.length} complete
      </p>
      <div className="speaker-work-list">
        {ordered.length ? (
          ordered.map((task) => {
            const blocked = isBlocked(task.dependencies);
            const done = isFinished(task.status);
            const open =
              !done && !blocked && task.taskType !== "administrator_only";
            const canUpload = open && task.taskType === "file_upload";
            const canComplete =
              open &&
              task.status !== "submitted" &&
              task.taskType !== "file_upload";
            return (
              <article
                className="speaker-task"
                data-state={done ? "done" : blocked ? "blocked" : task.status}
                id={`task-${task.id}`}
                key={task.id}
              >
                <div className="speaker-task-row">
                  <span className="speaker-task-mark" aria-hidden>
                    {done ? (
                      <CheckCircle2 size={16} />
                    ) : blocked ? (
                      <LockKeyhole size={16} />
                    ) : (
                      <Circle size={16} />
                    )}
                  </span>
                  <div className="speaker-task-copy">
                    <div className="speaker-task-title-row">
                      <h3>{task.title}</h3>
                      {done ? null : (
                        <DomainStatusBadge domain="task" status={task.status} />
                      )}
                    </div>
                    {task.targetType === "session" && task.targetLabel ? (
                      <p className="speaker-task-kicker">{task.targetLabel}</p>
                    ) : null}
                    {task.description ? (
                      <p className="speaker-task-desc">{task.description}</p>
                    ) : null}
                    <p className="speaker-task-meta">
                      <Clock3 aria-hidden size={12} />
                      {task.dueAt ? (
                        <EventDateTime
                          epochSeconds={task.dueAt}
                          timeZone={portal.event.timezone}
                        >
                          {speakerDueLabel(task.dueAt, portal.event.timezone)}
                        </EventDateTime>
                      ) : (
                        "No due date"
                      )}
                    </p>
                  </div>
                  {done ? (
                    <p className="speaker-task-done">
                      {task.status === "waived"
                        ? "Waived by the event team"
                        : "Completed"}
                    </p>
                  ) : null}
                </div>
                {blocked ? (
                  <p className="speaker-task-note">
                    Complete{" "}
                    {task.dependencies
                      .filter(
                        (dependency) =>
                          !["completed", "waived"].includes(dependency.status),
                      )
                      .map((dependency) => dependency.title)
                      .join(", ")}{" "}
                    first.
                  </p>
                ) : null}
                {task.status === "submitted" ? (
                  <p className="speaker-task-note">
                    {task.taskType === "file_upload"
                      ? "Stored for administrator review. You can upload a newer version while review is pending."
                      : "Submitted for administrator review."}
                  </p>
                ) : null}
                {task.comments.map((comment) => (
                  <blockquote key={comment.id} className="task-comment">
                    <footer>
                      <strong>{comment.authorName}</strong> ·{" "}
                      <EventDateTime
                        epochSeconds={comment.createdAt}
                        timeZone={portal.event.timezone}
                      />
                    </footer>
                    <p>{comment.body}</p>
                  </blockquote>
                ))}
                {task.fileVersions.length ? (
                  <section
                    className="speaker-task-versions"
                    aria-label="Uploaded file versions"
                  >
                    <strong>Uploaded file versions</strong>
                    <ol>
                      {task.fileVersions.map((version) => {
                        const state = taskEvidenceVersionStatus(version);
                        return (
                          <li
                            className="file-version-row"
                            key={version.versionId}
                          >
                            <span>
                              <strong>
                                {version.filename} · v{version.versionNumber}
                              </strong>
                              <small className="subtle">
                                <EventDateTime
                                  epochSeconds={version.createdAt}
                                  timeZone={portal.event.timezone}
                                />
                              </small>
                            </span>
                            <span className="row-actions">
                              {version.latest ? (
                                <span className="status success">Latest</span>
                              ) : null}
                              {version.current ? (
                                <span className="status info">
                                  Current released
                                </span>
                              ) : null}
                              {version.downloadAvailable ? (
                                <a
                                  className="btn small"
                                  href={`/participant/tasks/files/${encodeURIComponent(version.assetId)}/${encodeURIComponent(version.versionId)}`}
                                >
                                  Download v{version.versionNumber}
                                </a>
                              ) : (
                                <small className={`status ${state.tone}`}>
                                  {state.label}
                                </small>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ) : null}
                {canUpload ? (
                  <div className="speaker-task-action">
                    <DirectMultipartUpload
                      target={{ targetType: "task", targetId: task.id }}
                      kinds={[
                        {
                          value: "task_evidence",
                          label:
                            task.fileScope === "session_deliverable"
                              ? `Task evidence · documents and images (${maximumMegabytes(portal.event.filePolicy.supportingDocumentMaximumBytes)} MB maximum) or MP4/WebM video (${maximumMegabytes(portal.event.filePolicy.videoMaximumBytes)} MB maximum)`
                              : `Task evidence · ${maximumMegabytes(portal.event.filePolicy.supportingDocumentMaximumBytes)} MB maximum`,
                          accept:
                            ".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip,.jpg,.jpeg,.png,.webp,.mp4,.webm",
                          maximumBytes:
                            portal.event.filePolicy
                              .supportingDocumentMaximumBytes,
                          ...(task.fileScope === "session_deliverable"
                            ? {
                                maximumBytesByContentType: {
                                  "video/mp4":
                                    portal.event.filePolicy.videoMaximumBytes,
                                  "video/webm":
                                    portal.event.filePolicy.videoMaximumBytes,
                                },
                              }
                            : {}),
                        },
                      ]}
                      heading={
                        task.status === "submitted"
                          ? "Upload a replacement version"
                          : "Upload evidence"
                      }
                      description={
                        task.status === "submitted"
                          ? "The replacement becomes the next version of this exact deliverable. Earlier versions remain retained and downloadable after clean scanning."
                          : "Upload directly to Program Cue's private file store. The exact completed file is attached to this task and remains quarantined until malware scanning passes."
                      }
                      onCompleted={(upload) =>
                        attachTaskEvidence(task.id, upload)
                      }
                      disabled={busy}
                    />
                  </div>
                ) : null}
                {canComplete ? (
                  <div className="speaker-task-action">
                    <Form method="post" className="speaker-task-form">
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
                      {task.taskType === "short_form" &&
                      task.formFields.length ? (
                        <fieldset className="speaker-task-fields">
                          <legend className="label">
                            Required information
                          </legend>
                          {task.formFields.map((field) => {
                            const name = `response.${field.id}`;
                            if (field.type === "boolean") {
                              return (
                                <label className="label" key={field.id}>
                                  {field.label}
                                  <select
                                    className="select"
                                    name={name}
                                    required={field.required}
                                    defaultValue=""
                                  >
                                    <option value="" disabled>
                                      Choose yes or no
                                    </option>
                                    <option value="true">Yes</option>
                                    <option value="false">No</option>
                                  </select>
                                  {field.help ? (
                                    <span className="help">{field.help}</span>
                                  ) : null}
                                </label>
                              );
                            }
                            if (field.type === "select") {
                              return (
                                <label className="label" key={field.id}>
                                  {field.label}
                                  <select
                                    className="select"
                                    name={name}
                                    required={field.required}
                                    defaultValue=""
                                  >
                                    <option value="">Choose an option</option>
                                    {field.options.map((option) => (
                                      <option value={option} key={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                  {field.help ? (
                                    <span className="help">{field.help}</span>
                                  ) : null}
                                </label>
                              );
                            }
                            return (
                              // biome-ignore lint/a11y/noLabelWithoutControl: The conditional branch renders a wrapped input or textarea.
                              <label className="label" key={field.id}>
                                {field.label}
                                {field.type === "long_text" ? (
                                  <textarea
                                    className="textarea"
                                    name={name}
                                    required={field.required}
                                  />
                                ) : (
                                  <input
                                    className="field"
                                    name={name}
                                    type={
                                      field.type === "date" ? "date" : "text"
                                    }
                                    required={field.required}
                                  />
                                )}
                                {field.help ? (
                                  <span className="help">{field.help}</span>
                                ) : null}
                              </label>
                            );
                          })}
                        </fieldset>
                      ) : task.taskType === "short_form" ? (
                        <label className="label">
                          Response
                          <textarea className="textarea" name="text" required />
                        </label>
                      ) : task.taskType === "link_visit" ? (
                        <div className="stack">
                          <a
                            className="btn"
                            href={requireValue(
                              task.destinationUrl,
                              "Link task destination missing after server validation.",
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open link <ExternalLink aria-hidden size={14} />
                            <span className="sr-only">
                              {" "}
                              (opens in a new tab)
                            </span>
                          </a>
                          <AcknowledgementCompleteControls
                            busy={busy}
                            label="I’ve visited this link"
                          />
                        </div>
                      ) : (
                        <AcknowledgementCompleteControls busy={busy} />
                      )}
                      {task.taskType === "short_form" ? (
                        <button
                          type="submit"
                          className="btn primary"
                          disabled={busy}
                        >
                          Complete task
                        </button>
                      ) : null}
                    </Form>
                  </div>
                ) : null}
                <details className="speaker-task-comment">
                  <summary>Add a comment</summary>
                  <Form method="post" className="speaker-task-comment-form">
                    <input type="hidden" name="intent" value="comment" />
                    <input
                      type="hidden"
                      name="intentId"
                      value={`${intentId}:${task.id}`}
                    />
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
                    <button className="btn" type="submit" disabled={busy}>
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
  );
}

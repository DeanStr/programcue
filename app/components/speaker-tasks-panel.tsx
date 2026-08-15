import { CheckCircle2, Clock3, LockKeyhole } from "lucide-react";
import { Form } from "react-router";

import {
  DirectMultipartUpload,
  DirectUploadCompletionConflictError,
} from "~/components/direct-multipart-upload";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { maximumMegabytes } from "~/modules/files/file-policy";
import { UserFacingError } from "~/platform/user-facing-error";
import type { ParticipantTaskEvidenceVersion } from "~/modules/files/file-service.server";
import {
  speakerDueLabel,
  type SpeakerPortal,
  type SpeakerTask,
} from "~/components/speaker-dashboard-panel-shared";

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
  return (
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
                    <DomainStatusBadge domain="task" status={task.status} />
                    <span className={`impact ${task.impact} right`}>
                      {task.impact} impact
                    </span>
                  </div>
                  <h3>{task.title}</h3>
                  {task.targetType === "session" && task.targetLabel ? (
                    <p className="tiny">
                      <span className="status info">Session deliverable</span>{" "}
                      <strong>{task.targetLabel}</strong>
                    </p>
                  ) : null}
                  <p className="subtle">{task.description}</p>
                  <p className="tiny subtle">
                    <Clock3 aria-hidden size={13} />{" "}
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
                      className="stack mt"
                      aria-label="Uploaded file versions"
                    >
                      <strong>Uploaded file versions</strong>
                      <ol className="stack">
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
                </div>
                <div className="speaker-task-action">
                  {!["completed", "waived"].includes(task.status) &&
                  !blocked &&
                  task.taskType === "file_upload" ? (
                    <DirectMultipartUpload
                      target={{ targetType: "task", targetId: task.id }}
                      kinds={[
                        {
                          value: "task_evidence",
                          label: `Task evidence (${maximumMegabytes(portal.event.filePolicy.supportingDocumentMaximumBytes)} MB maximum)`,
                          accept:
                            ".pdf,.doc,.docx,.xls,.xlsx,.zip,.jpg,.jpeg,.png,.webp",
                          maximumBytes:
                            portal.event.filePolicy
                              .supportingDocumentMaximumBytes,
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
                      {task.taskType === "short_form" &&
                      task.formFields.length ? (
                        <fieldset className="stack">
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
                          <input type="checkbox" name="confirmed" required /> I
                          confirm this requirement
                        </label>
                      )}
                      <button className="btn primary" disabled={busy}>
                        <CheckCircle2 aria-hidden size={15} /> Complete task
                      </button>
                    </Form>
                  ) : null}
                  {task.status === "submitted" ? (
                    <div className="validation-item warn">
                      <Clock3 aria-hidden size={16} />
                      <span>
                        {task.taskType === "file_upload"
                          ? "Stored for administrator review. You can upload a newer version while review is pending."
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

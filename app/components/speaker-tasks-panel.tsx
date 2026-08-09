import { CheckCircle2, Clock3, LockKeyhole, UploadCloud } from "lucide-react";
import { Form } from "react-router";

import {
  speakerDueLabel,
  speakerStatusClass,
  type SpeakerPortal,
} from "~/components/speaker-dashboard-panel-shared";
import type { SpeakerDashboardData } from "~/routes/speaker-dashboard";

export function SpeakerTasksPanel({
  portal,
  tasks,
  finished,
  busy,
}: {
  portal: SpeakerPortal;
  tasks: SpeakerDashboardData["tasks"];
  finished: number;
  busy: boolean;
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
                    <span
                      className={`status ${speakerStatusClass(task.status)}`}
                    >
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
                    {speakerDueLabel(task.dueAt, portal.event.timezone)}
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
                      <input type="hidden" name="intent" value="upload-task" />
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
                      <button className="btn primary" disabled={busy}>
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
  );
}

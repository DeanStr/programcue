import { ListChecks } from "lucide-react";
import { useEffect } from "react";
import { Form } from "react-router";

import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { AdminTasksData } from "~/routes/admin-tasks";

function dateLabel(epoch: number | null, timezone: string) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))
    : "No due date";
}

export function AdminAssignedTasksPanel({
  data,
  busy,
}: {
  data: AdminTasksData;
  busy: boolean;
}) {
  useEffect(() => {
    if (!data.focusedTaskId) return;
    const target = document.getElementById(`admin-task-${data.focusedTaskId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [data.focusedTaskId]);
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Assigned work</h2>
        <span className="help right">
          Dependencies refresh before every read
        </span>
      </div>
      <div className="table-wrap pc-responsive-table-wrap">
        <table className="data-table pc-responsive-table">
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Speaker</th>
              <th scope="col">Impact</th>
              <th scope="col">Due ({data.eventTimezone})</th>
              <th scope="col">Status / evidence</th>
              <th scope="col">Administrator action</th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.map((task) => (
              <tr
                id={`admin-task-${task.id}`}
                key={task.id}
                tabIndex={task.id === data.focusedTaskId ? -1 : undefined}
              >
                <td className="pc-record-primary-cell" data-label="Requirement">
                  <div className="pc-record-stack">
                    <strong>{task.title}</strong>
                    <small className="subtle">
                      Type: {task.taskType.replaceAll("_", " ")}
                    </small>
                    <small className="subtle">Revision {task.revision}</small>
                  </div>
                </td>
                <td data-label="Speaker">{task.ownerName ?? task.targetId}</td>
                <td data-label="Impact">
                  <span className={`impact ${task.impact}`}>{task.impact}</span>
                </td>
                <td data-label={`Due (${data.eventTimezone})`}>
                  {task.dueAt ? (
                    <EventDateTime
                      epochSeconds={task.dueAt}
                      timeZone={data.eventTimezone}
                    >
                      {dateLabel(task.dueAt, data.eventTimezone)}
                    </EventDateTime>
                  ) : (
                    "No due date"
                  )}
                </td>
                <td data-label="Status / evidence">
                  <div className="pc-record-stack">
                    <DomainStatusBadge domain="task" status={task.status} />
                    {task.evidence[0] ? (
                      <div className="pc-record-stack task-evidence-review">
                        <small className="subtle">
                          Latest evidence: {task.evidence[0].status}
                          {task.evidence[0].fileAssetId
                            ? " · private file"
                            : ""}
                        </small>
                        {task.evidence[0].fileAssetId &&
                        task.evidence[0].details.fileVersionId ? (
                          task.evidence[0].downloadAvailable ? (
                            <a
                              className="btn small"
                              href={`/admin/tasks/files/${encodeURIComponent(task.evidence[0].fileAssetId)}/${encodeURIComponent(task.evidence[0].details.fileVersionId)}`}
                            >
                              Download evidence
                            </a>
                          ) : (
                            <small className="subtle">
                              Download remains unavailable until the exact
                              submitted version passes scanning.
                            </small>
                          )
                        ) : null}
                        {task.evidence[0].details.text ? (
                          <p>
                            <strong>Response:</strong>{" "}
                            {task.evidence[0].details.text}
                          </p>
                        ) : null}
                        {task.evidence[0].details.url ? (
                          <p>
                            <strong>Submitted link:</strong>{" "}
                            <a
                              href={task.evidence[0].details.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {task.evidence[0].details.url}
                              <span className="sr-only">
                                {" "}
                                (opens in a new tab)
                              </span>
                            </a>
                          </p>
                        ) : null}
                        {task.evidence[0].details.confirmed ? (
                          <small>Participant confirmed this requirement.</small>
                        ) : null}
                      </div>
                    ) : null}
                    {task.comments.length ? (
                      <details>
                        <summary>
                          {task.comments.length} message
                          {task.comments.length === 1 ? "" : "s"}
                        </summary>
                        <div className="stack mt">
                          {task.comments.map((comment) => (
                            <blockquote
                              className="task-comment"
                              key={comment.id}
                            >
                              <strong>{comment.authorName}</strong>
                              {comment.visibility === "administrator" ? (
                                <small className="subtle">
                                  Administrator only
                                </small>
                              ) : null}
                              <p>{comment.body}</p>
                            </blockquote>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </td>
                <td
                  data-label="Administrator action"
                  className="pc-record-action-cell"
                >
                  <Form method="post" className="task-admin-actions">
                    <input type="hidden" name="taskId" value={task.id} />
                    <input
                      type="hidden"
                      name="revision"
                      value={task.revision}
                    />
                    {task.status === "submitted" ? (
                      <button
                        className="btn small primary"
                        name="intent"
                        value="approve"
                        formNoValidate
                        disabled={busy}
                      >
                        Approve
                      </button>
                    ) : null}
                    {!["completed", "waived", "submitted"].includes(
                      task.status,
                    ) ? (
                      <button
                        className="btn small"
                        name="intent"
                        value="complete"
                        formNoValidate
                        disabled={busy}
                      >
                        Complete
                      </button>
                    ) : ["completed", "waived"].includes(task.status) ? (
                      <button
                        className="btn small"
                        name="intent"
                        value="reopen"
                        formNoValidate
                        disabled={busy}
                      >
                        Reopen
                      </button>
                    ) : null}
                    {!["completed", "waived"].includes(task.status) ? (
                      <details>
                        <summary className="btn small">Waive task</summary>
                        <label className="label">
                          Reason
                          <input
                            className="field"
                            name="reason"
                            minLength={5}
                            required
                          />
                        </label>
                        <button
                          className="btn small danger"
                          name="intent"
                          value="waive"
                          disabled={busy}
                        >
                          Confirm waiver
                        </button>
                      </details>
                    ) : null}
                  </Form>
                  <details className="mt">
                    <summary className="btn small">Add comment</summary>
                    <Form method="post" className="stack mt">
                      <input type="hidden" name="intent" value="comment" />
                      <input
                        type="hidden"
                        name="intentId"
                        value={`${data.intentId}:${task.id}`}
                      />
                      <input type="hidden" name="taskId" value={task.id} />
                      <label className="label">
                        Message
                        <textarea
                          className="textarea"
                          name="body"
                          required
                          maxLength={2_000}
                        />
                      </label>
                      <label className="speaker-confirm">
                        <input type="checkbox" name="administratorOnly" /> Keep
                        this note administrator-only
                      </label>
                      <button className="btn small" disabled={busy}>
                        Send comment
                      </button>
                    </Form>
                  </details>
                </td>
              </tr>
            ))}
            {!data.tasks.length ? (
              <tr className="pc-table-empty-row">
                <td className="pc-table-empty-cell" colSpan={6}>
                  <div className="pc-empty-state">
                    <ListChecks aria-hidden className="pc-state-icon" />
                    <h2>No matching tasks</h2>
                    <p className="subtle">
                      Clear the filters or assign a task plan.
                    </p>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

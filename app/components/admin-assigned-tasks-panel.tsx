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

const DAY_MILLISECONDS = 86_400_000;

function localDayNumber(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: timezone,
  }).formatToParts(new Date(epoch * 1_000));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(value("year"), value("month") - 1, value("day")) / DAY_MILLISECONDS
  );
}

export function dueDistanceLabel(dueAt: number, now: number, timezone: string) {
  const days = localDayNumber(dueAt, timezone) - localDayNumber(now, timezone);
  if (days < 0) {
    const overdue = Math.abs(days);
    return {
      text: overdue === 1 ? "1 day overdue" : `${overdue} days overdue`,
      tone: "danger" as const,
    };
  }
  if (days === 0) return { text: "Due today", tone: "warning" as const };
  if (days === 1) return { text: "Due tomorrow", tone: "warning" as const };
  if (days <= 7) return { text: `${days} days left`, tone: "warning" as const };
  return { text: `${days} days left`, tone: "neutral" as const };
}

function readinessTone(percent: number) {
  if (percent >= 100) return "green";
  if (percent >= 50) return "";
  return percent > 0 ? "amber" : "red";
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
      <div
        className="table-wrap pc-responsive-table-wrap"
        role="region"
        aria-label="Assigned speaker work"
        tabIndex={0}
      >
        <table className="data-table pc-responsive-table">
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Speaker</th>
              <th scope="col">Impact</th>
              <th scope="col">Due ({data.eventTimezone})</th>
              <th scope="col">Readiness</th>
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
                    <div className="pc-record-stack">
                      <EventDateTime
                        epochSeconds={task.dueAt}
                        timeZone={data.eventTimezone}
                      >
                        {dateLabel(task.dueAt, data.eventTimezone)}
                      </EventDateTime>
                      {(() => {
                        const distance = dueDistanceLabel(
                          task.dueAt,
                          data.now,
                          data.eventTimezone,
                        );
                        return (
                          <small
                            className={`task-due-distance ${distance.tone}`}
                          >
                            {distance.text}
                          </small>
                        );
                      })()}
                    </div>
                  ) : (
                    "No due date"
                  )}
                </td>
                <td data-label="Readiness">
                  <div className="pc-record-stack task-readiness-cell">
                    <div
                      className={`progress ${readinessTone(task.readinessPercent)}${task.readinessPercent === 0 ? " is-zero" : ""}`}
                      aria-hidden
                    >
                      <span style={{ width: `${task.readinessPercent}%` }} />
                    </div>
                    <small className="pc-num">
                      {task.readinessPercent}%
                      <span className="sr-only"> ready</span>
                    </small>
                  </div>
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
                        {task.evidence[0].details.responses
                          ? task.formFields.map((field) => {
                              const value =
                                task.evidence[0]!.details.responses?.[field.id];
                              if (value === undefined) return null;
                              return (
                                <p key={field.id}>
                                  <strong>{field.label}:</strong>{" "}
                                  {typeof value === "boolean"
                                    ? value
                                      ? "Yes"
                                      : "No"
                                    : value}
                                </p>
                              );
                            })
                          : null}
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
                              {" · "}
                              <EventDateTime
                                epochSeconds={comment.createdAt}
                                timeZone={data.eventTimezone}
                              />
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
                  {task.targetType === "speaker" &&
                  task.dueAt !== null &&
                  !["completed", "waived"].includes(task.status) ? (
                    <details className="mt">
                      <summary className="btn small">Extend deadline</summary>
                      <Form method="post" className="stack mt">
                        <input
                          type="hidden"
                          name="intent"
                          value="extend-deadline"
                        />
                        <input type="hidden" name="taskId" value={task.id} />
                        <input
                          type="hidden"
                          name="revision"
                          value={task.revision}
                        />
                        <label className="label">
                          New deadline ({data.eventTimezone})
                          <input
                            className="field"
                            type="date"
                            name="dueDate"
                            required
                          />
                        </label>
                        <label className="label">
                          Reason for deadline extension
                          <input
                            className="field"
                            name="reason"
                            minLength={5}
                            maxLength={1_000}
                            required
                          />
                        </label>
                        <button className="btn small" disabled={busy}>
                          Confirm extension
                        </button>
                      </Form>
                    </details>
                  ) : null}
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
                <td className="pc-table-empty-cell" colSpan={7}>
                  <div className="pc-empty-state">
                    <ListChecks aria-hidden className="pc-state-icon" />
                    <h3>No assigned work matches these filters</h3>
                    <p className="subtle">
                      Clear or change the filters to see other event tasks.
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

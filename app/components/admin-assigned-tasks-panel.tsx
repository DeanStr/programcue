import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Form, Link } from "react-router";
import { Button, ButtonAnchor } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { Field } from "~/components/ui/field";
import { impactLabel } from "~/components/ui/readiness-weighting";
import { taskTypeLabel } from "~/modules/tasks/task-schema";
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

type AssignedTask = AdminTasksData["tasks"][number];

/* One visible decision per row. Waiver, extension, details and comments are
   secondary and sit behind More so a row does not read as five equal links. */
function primaryTaskAction(task: AssignedTask) {
  if (task.status === "submitted") {
    return task.isSessionDetailsReview
      ? null
      : { intent: "approve", label: "Approve" };
  }
  if (["completed", "waived"].includes(task.status)) {
    return { intent: "reopen", label: "Reopen" };
  }
  return task.isSessionDetailsReview
    ? null
    : { intent: "complete", label: "Mark complete" };
}

function TaskPrimaryAction({
  task,
  busy,
}: {
  task: AssignedTask;
  busy: boolean;
}) {
  const action = primaryTaskAction(task);
  if (!action) return null;
  return (
    <Form method="post" className="task-admin-actions">
      <input type="hidden" name="taskId" value={task.id} />
      <input type="hidden" name="revision" value={task.revision} />
      <Button
        type="submit"
        size="small"
        name="intent"
        value={action.intent}
        disabled={busy}
      >
        {action.label}
      </Button>
    </Form>
  );
}

function TaskActionDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="task-action-disclosure">
      <summary className="task-ghost">
        <ChevronRight aria-hidden size={14} />
        {label}
      </summary>
      {children}
    </details>
  );
}

/* Secondary forms span the table in their own row. They stay mounted so
   a half-written reason or comment survives closing the panel. */
function TaskMoreActionsPanel({
  task,
  busy,
  eventTimezone,
  intentId,
  panelId,
}: {
  task: AssignedTask;
  busy: boolean;
  eventTimezone: string;
  intentId: string;
  panelId: string;
}) {
  const open = !["completed", "waived"].includes(task.status);
  return (
    <section
      id={panelId}
      className="task-more-panel"
      aria-label={`Actions for ${task.title}`}
    >
      {open ? (
        <TaskActionDisclosure label="Waive task">
          <Form method="post" className="stack mt">
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="revision" value={task.revision} />
            <Field label="Reason" description="At least 5 characters.">
              <input className="field" name="reason" minLength={5} required />
            </Field>
            <Button
              type="submit"
              variant="danger"
              size="small"
              name="intent"
              value="waive"
              disabled={busy}
            >
              Confirm waiver
            </Button>
          </Form>
        </TaskActionDisclosure>
      ) : null}
      {open && task.targetType === "speaker" && task.dueAt !== null ? (
        <TaskActionDisclosure label="Extend deadline">
          <Form method="post" className="stack mt">
            <input type="hidden" name="intent" value="extend-deadline" />
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="revision" value={task.revision} />
            <label className="label">
              New deadline ({eventTimezone})
              <input className="field" type="date" name="dueDate" required />
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
            <Button type="submit" size="small" disabled={busy}>
              Confirm extension
            </Button>
          </Form>
        </TaskActionDisclosure>
      ) : null}
      <TaskActionDisclosure label="Task details">
        <p className="help">{task.description}</p>
        <p className="help">
          {taskTypeLabel(task.taskType)} · Revision {task.revision}
        </p>
      </TaskActionDisclosure>
      <TaskActionDisclosure label="Add comment">
        <Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="comment" />
          <input
            type="hidden"
            name="intentId"
            value={`${intentId}:${task.id}`}
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
            <input type="checkbox" name="administratorOnly" /> Keep this note
            administrator-only
          </label>
          <Button type="submit" size="small" disabled={busy}>
            Send comment
          </Button>
        </Form>
      </TaskActionDisclosure>
    </section>
  );
}

function AssignedTaskRow({
  task,
  data,
  busy,
}: {
  task: AssignedTask;
  data: AdminTasksData;
  busy: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <tr
        id={`admin-task-${task.id}`}
        data-actions-open={moreOpen}
        tabIndex={task.id === data.focusedTaskId ? -1 : undefined}
      >
        <td className="pc-record-primary-cell" data-label="Requirement">
          <div className="pc-record-stack">
            <strong>{task.title}</strong>
            <small className="subtle">
              {task.ownerName ?? task.targetLabel ?? task.targetId}
              {task.ownerName &&
              task.targetLabel &&
              task.ownerName !== task.targetLabel
                ? ` · ${task.targetLabel}`
                : ""}
            </small>
          </div>
        </td>
        <td data-label="Impact">
          <span className={`impact ${task.impact}`}>
            {impactLabel(task.impact)}
          </span>
        </td>
        <td data-label="Due">
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
                  <small className={`task-due-distance ${distance.tone}`}>
                    {distance.text}
                  </small>
                );
              })()}
            </div>
          ) : (
            <span className="subtle">No due date</span>
          )}
        </td>
        <td data-label="Status">
          <div className="pc-record-stack">
            <DomainStatusBadge domain="task" status={task.status} />
            {task.status === "blocked"
              ? task.blockingDependencies.map((dependency) => (
                  <small className="subtle" key={dependency.id}>
                    Waiting for:{" "}
                    <Link
                      to={`/admin/tasks?task=${encodeURIComponent(dependency.id)}`}
                    >
                      {dependency.title}
                    </Link>
                  </small>
                ))
              : null}
            {task.taskType !== "administrator_only" &&
            !task.participantActionable ? (
              <small className="status warning">
                Inactive — no eligible participant
              </small>
            ) : null}
            {/* Only partial progress says something the status does
                        not: a bar reading 0% beside Not started repeated it. */}
            {task.readinessPercent > 0 && task.readinessPercent < 100 ? (
              <small className="subtle pc-num">
                {task.readinessPercent}% complete
              </small>
            ) : null}
            {task.evidence[0] ? (
              <div className="pc-record-stack task-evidence-review">
                <small className="subtle">
                  Latest evidence: {task.evidence[0].status}
                  {task.evidence[0].fileAssetId ? " · private file" : ""}
                </small>
                {task.evidence[0].fileAssetId &&
                task.evidence[0].details.fileVersionId ? (
                  task.evidence[0].downloadAvailable ? (
                    <ButtonAnchor
                      size="small"
                      href={`/admin/tasks/files/${encodeURIComponent(task.evidence[0].fileAssetId)}/${encodeURIComponent(task.evidence[0].details.fileVersionId)}`}
                    >
                      Download evidence
                    </ButtonAnchor>
                  ) : (
                    <small className="subtle">
                      Download remains unavailable until the exact submitted
                      version passes scanning.
                    </small>
                  )
                ) : null}
                {task.evidence[0].details.text ? (
                  <p>
                    <strong>Response:</strong> {task.evidence[0].details.text}
                  </p>
                ) : null}
                {task.evidence[0].details.responses
                  ? task.formFields.map((field) => {
                      const value =
                        task.evidence[0].details.responses?.[field.id];
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
                {task.evidence[0].details.destinationUrl ? (
                  <p>
                    <strong>Configured destination:</strong>{" "}
                    <a
                      href={task.evidence[0].details.destinationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {task.evidence[0].details.destinationUrl}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </p>
                ) : null}
                {task.evidence
                  .filter((item) => item.details.url)
                  .map((item) => (
                    <p key={item.id}>
                      <strong>Legacy participant-submitted URL:</strong>{" "}
                      {item.details.url}
                    </p>
                  ))}
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
                    <blockquote className="task-comment" key={comment.id}>
                      <strong>{comment.authorName}</strong>
                      {" · "}
                      <EventDateTime
                        epochSeconds={comment.createdAt}
                        timeZone={data.eventTimezone}
                      />
                      {comment.visibility === "administrator" ? (
                        <small className="subtle">Administrator only</small>
                      ) : null}
                      <p>{comment.body}</p>
                    </blockquote>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </td>
        <td data-label="Actions" className="pc-record-action-cell">
          <div className="task-admin-action-row">
            <TaskPrimaryAction task={task} busy={busy} />
            <Button
              size="small"
              variant="ghost"
              className="task-more-toggle"
              aria-expanded={moreOpen}
              aria-controls={panelId}
              onClick={() => setMoreOpen((current) => !current)}
            >
              More actions
              <ChevronDown aria-hidden size={14} />
            </Button>
          </div>
        </td>
      </tr>
      <tr className="task-details-row" hidden={!moreOpen}>
        <td colSpan={5}>
          <TaskMoreActionsPanel
            task={task}
            busy={busy}
            eventTimezone={data.eventTimezone}
            intentId={data.intentId}
            panelId={panelId}
          />
        </td>
      </tr>
    </>
  );
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
    <section className="card pad tasks-assigned">
      <section
        className="table-wrap pc-responsive-table-wrap"
        aria-label="Assigned speaker work"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
        tabIndex={0}
      >
        <table className="data-table pc-responsive-table">
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Impact</th>
              <th scope="col">Due</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.map((task) => (
              <AssignedTaskRow
                key={task.id}
                task={task}
                data={data}
                busy={busy}
              />
            ))}
            {!data.tasks.length ? (
              <tr className="pc-table-empty-row">
                <td className="pc-table-empty-cell" colSpan={5}>
                  <div className="pc-empty-state">
                    <ListChecks aria-hidden className="pc-state-icon" />
                    <h3>No assigned work matches these filters</h3>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </section>
  );
}

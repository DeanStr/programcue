import { GitBranch, Plus } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import type { AdminTasksData } from "~/routes/admin-tasks";

export function AdminTaskPlanPanel({
  data,
  busy,
}: {
  data: AdminTasksData;
  busy: boolean;
}) {
  const assignableTemplates = data.templates.filter(
    (template) => template.status === "active",
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    assignableTemplates[0]?.id ?? "",
  );
  const [targetType, setTargetType] = useState<"speaker" | "session" | "event">(
    "speaker",
  );
  const [dueAnchor, setDueAnchor] = useState("none");
  const [autoAssignOnAcceptance, setAutoAssignOnAcceptance] = useState(false);
  const selectedTemplate =
    assignableTemplates.find(
      (template) => template.id === selectedTemplateId,
    ) ?? assignableTemplates[0];
  const assignmentTargets =
    selectedTemplate?.targetType === "session"
      ? data.sessions
      : selectedTemplate?.targetType === "event"
        ? [data.eventTarget]
        : data.speakers;
  const selectedTargetLabel =
    selectedTemplate?.targetType === "session"
      ? "Session"
      : selectedTemplate?.targetType === "event"
        ? "Event"
        : "Speaker";
  return (
    <aside className="tasks-side stack">
      <section className="card pad">
        <div className="card-title">
          <h2>Speaker travel onboarding</h2>
        </div>
        <p className="subtle">
          Create the hotel-stay and flight-reimbursement forms confirmed as the
          minimum speaker onboarding workflow. Both are due seven days after
          acceptance and assigned automatically.
        </p>
        <ul className="help">
          <li>Hotel stay requirements</li>
          <li>Flight reimbursement</li>
        </ul>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="create-travel-onboarding" />
          <label className="speaker-confirm">
            <input
              type="checkbox"
              name="confirmed"
              value="create-travel-onboarding"
              required
            />{" "}
            I confirm these forms should be created and automatically assigned
            to speakers when a submission is accepted.
          </label>
          <button className="btn primary" disabled={busy}>
            <Plus aria-hidden size={15} /> Create travel forms
          </button>
        </Form>
      </section>
      <section className="card pad">
        <div className="card-title">
          <h2>Assign a plan</h2>
          <GitBranch aria-hidden className="subtle" size={18} />
        </div>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="assign" />
          <label className="label">
            Template
            <select
              className="select"
              name="templateId"
              required
              value={selectedTemplate?.id ?? ""}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
            >
              {assignableTemplates.map((template) => (
                <option value={template.id} key={template.id}>
                  {template.name} · {template.targetType}
                  {template.autoAssignOnAcceptance
                    ? " · automatic on acceptance"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            {selectedTargetLabel}
            <select className="select" name="targetId" required>
              {assignmentTargets.map((target) => (
                <option value={target.id} key={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn primary"
            disabled={
              !assignableTemplates.length || !assignmentTargets.length || busy
            }
          >
            <Plus aria-hidden size={15} /> Assign with prerequisites
          </button>
        </Form>
      </section>
      <details className="card pad" open={!data.templates.length}>
        <summary>
          <strong>Create task template</strong>
        </summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="create-template" />
          <input type="hidden" name="intentId" value={data.intentId} />
          <label className="label">
            Name
            <input className="field" name="name" required />
          </label>
          <label className="label">
            Description
            <textarea className="textarea" name="description" />
          </label>
          <div className="form-row">
            <label className="label">
              Scope
              <select
                className="select"
                name="targetType"
                value={targetType}
                onChange={(event) =>
                  setTargetType(
                    event.target.value as "speaker" | "session" | "event",
                  )
                }
              >
                <option value="speaker">Speaker</option>
                <option value="session">Session</option>
                <option value="event">Event</option>
              </select>
            </label>
            <label className="label">
              Type
              <select
                className="select"
                name="taskType"
                defaultValue="checklist"
              >
                <option value="checklist">Checklist</option>
                <option value="acknowledgement">Acknowledgement</option>
                <option value="short_form">Short form</option>
                <option value="file_upload">File upload</option>
                <option value="link_visit">Link visit</option>
                <option value="administrator_only">Administrator only</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="label">
              Impact
              <select className="select" name="impact" defaultValue="medium">
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="label">
              Evidence
              <select
                className="select"
                name="evidenceMode"
                defaultValue="checkbox"
              >
                <option value="none">None</option>
                <option value="checkbox">Checkbox</option>
                <option value="file">File</option>
                <option value="text">Text</option>
                <option value="link">Link</option>
                <option value="admin_approval">Administrator approval</option>
              </select>
            </label>
          </div>
          <label className="label">
            Due date anchor
            <select
              className="select"
              name="dueAnchor"
              value={dueAnchor}
              onChange={(event) => {
                setDueAnchor(event.target.value);
                if (event.target.value === "session_start") {
                  setAutoAssignOnAcceptance(false);
                }
              }}
            >
              <option value="none">None</option>
              <option value="acceptance">Acceptance date</option>
              <option value="session_start">Session start</option>
              <option value="fixed">Fixed date</option>
            </select>
          </label>
          <div className="form-row">
            <label className="label">
              Offset days
              <input
                className="field"
                type="number"
                name="dueOffsetDays"
                placeholder="e.g. 14 or -7"
              />
            </label>
            <label className="label">
              Fixed due date
              <input className="field" type="date" name="fixedDueDate" />
              <span className="help">
                Ends at 11:59 PM in {data.eventTimezone}.
              </span>
            </label>
          </div>
          <label className="speaker-confirm">
            <input
              type="checkbox"
              name="autoAssignOnAcceptance"
              value="true"
              checked={autoAssignOnAcceptance}
              disabled={dueAnchor === "session_start"}
              onChange={(event) =>
                setAutoAssignOnAcceptance(event.target.checked)
              }
            />{" "}
            Add this task automatically when a submission is accepted
          </label>
          <span className="help">
            Prerequisites are included automatically. Session-start deadlines
            require a scheduled session and cannot be created at acceptance.
          </span>
          {data.templates.length ? (
            <fieldset>
              <legend className="label">Prerequisites</legend>
              <div className="task-dependency-list">
                {data.templates
                  .filter(
                    (template) =>
                      template.status === "active" &&
                      template.targetType === targetType,
                  )
                  .map((template) => (
                    <label className="speaker-confirm" key={template.id}>
                      <input
                        type="checkbox"
                        name="dependencyIds"
                        value={template.id}
                      />{" "}
                      {template.name}
                    </label>
                  ))}
              </div>
            </fieldset>
          ) : null}
          <button className="btn primary">
            <Plus aria-hidden size={15} /> Create template
          </button>
        </Form>
      </details>
    </aside>
  );
}

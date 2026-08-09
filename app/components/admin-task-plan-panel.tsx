import { GitBranch, Plus } from "lucide-react";
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
    (template) =>
      template.targetType === "speaker" && template.status === "active",
  );
  return (
    <aside className="tasks-side stack">
      <section className="card pad">
        <div className="card-title">
          <h2>Assign a plan</h2>
          <GitBranch aria-hidden className="subtle" size={18} />
        </div>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="assign" />
          <label className="label">
            Template
            <select className="select" name="templateId" required>
              {assignableTemplates.map((template) => (
                <option value={template.id} key={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Speaker
            <select className="select" name="personId" required>
              {data.speakers.map((speaker) => (
                <option value={speaker.id} key={speaker.id}>
                  {speaker.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn primary"
            disabled={
              !assignableTemplates.length || !data.speakers.length || busy
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
              <input type="hidden" name="targetType" value="speaker" />
              <input className="field" value="Speaker" readOnly />
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
            <select className="select" name="dueAnchor" defaultValue="none">
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
          {data.templates.length ? (
            <fieldset>
              <legend className="label">Prerequisites</legend>
              <div className="task-dependency-list">
                {data.templates
                  .filter((template) => template.status === "active")
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

import { Form, Link } from "react-router";
import { DraftRecoveryStatus } from "~/components/draft-recovery-feedback";
import type { DraftRecoveryState } from "~/platform/drafts/draft-recovery";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  communicationCategoryLabel as categoryLabel,
  type PendingIntent,
  type SelectedTemplate,
} from "./communications-panel-shared";

export type TemplateDraftFields = {
  name: string;
  category: string;
  subject: string;
  body: string;
  physicalAddress: string;
  buttonText: string;
  buttonUrl: string;
};

export function TemplateVersionList({
  loaderData,
  selected,
}: {
  loaderData: CommunicationsCentreLoaderData;
  selected: SelectedTemplate;
}) {
  return (
    <aside className="card pad template-column">
      <div className="card-title">
        <h2>Template versions</h2>
        <span className="status info right">{loaderData.templates.length}</span>
      </div>
      <div className="template-list">
        {loaderData.templates.length ? (
          loaderData.templates.map((template) => (
            <Link
              key={template.id}
              to={`?template=${template.id}`}
              className={`template-item${selected?.id === template.id ? " active" : ""}`}
            >
              <strong>{template.name}</strong>
              <small>
                {categoryLabel(template.category)} · v{template.versionNumber}
              </small>
              <span
                className={`status ${template.versionStatus === "published" ? "success" : template.versionStatus === "draft" ? "warning" : "info"}`}
              >
                {template.versionStatus}
              </span>
            </Link>
          ))
        ) : (
          <div className="empty compact">
            <p>Create the first versioned email template.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

export function TemplateEditor({
  selected,
  working,
  pendingIntent,
  templateDirty,
  draft,
  recoveryState,
  onChange,
}: {
  selected: SelectedTemplate;
  working: boolean;
  pendingIntent: PendingIntent;
  templateDirty: boolean;
  draft: TemplateDraftFields;
  recoveryState: DraftRecoveryState;
  onChange: (draft: TemplateDraftFields) => void;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>{selected ? `Edit ${selected.name}` : "New email template"}</h2>
        {selected ? (
          <span
            className={`status ${selected.versionStatus === "published" ? "success" : "warning"} right`}
          >
            v{selected.versionNumber} · {selected.versionStatus}
          </span>
        ) : null}
      </div>
      <Form
        key={selected?.id ?? "new-template"}
        method="post"
        className="stack"
      >
        {selected ? (
          <input type="hidden" name="templateId" value={selected.templateId} />
        ) : null}
        <div className="form-row">
          <label className="label">
            Template name
            <input
              className="field"
              name="name"
              value={draft.name}
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
              required
            />
          </label>
          <label className="label">
            Type
            <select
              className="select"
              name="category"
              value={draft.category}
              onChange={(event) =>
                onChange({ ...draft, category: event.target.value })
              }
            >
              <option value="submission_confirmation">
                Submission confirmation
              </option>
              <option value="decision">Decision</option>
              <option value="task_reminder">Task reminder</option>
              <option value="schedule">Schedule update</option>
              <option value="calendar">Calendar</option>
              <option value="ad_hoc">Ad hoc</option>
            </select>
          </label>
        </div>
        <label className="label">
          Subject
          <input
            className="field"
            name="subject"
            value={draft.subject}
            onChange={(event) =>
              onChange({ ...draft, subject: event.target.value })
            }
            required
          />
        </label>
        <label className="label">
          Message
          <textarea
            className="textarea comms-body"
            name="body"
            value={draft.body}
            onChange={(event) =>
              onChange({ ...draft, body: event.target.value })
            }
            required
          />
        </label>
        <label className="label">
          Physical address
          <input
            className="field"
            name="physicalAddress"
            value={draft.physicalAddress}
            onChange={(event) =>
              onChange({ ...draft, physicalAddress: event.target.value })
            }
            required
          />
          <span className="help">Required in the rendered footer.</span>
        </label>
        <div className="form-row">
          <label className="label">
            Optional button text
            <input
              className="field"
              name="buttonText"
              value={draft.buttonText}
              onChange={(event) =>
                onChange({ ...draft, buttonText: event.target.value })
              }
            />
          </label>
          <label className="label">
            Optional button URL
            <input
              className="field"
              name="buttonUrl"
              type="url"
              value={draft.buttonUrl}
              onChange={(event) =>
                onChange({ ...draft, buttonUrl: event.target.value })
              }
            />
          </label>
        </div>
        <div className="row-actions">
          <DraftRecoveryStatus state={recoveryState} />
          <button
            className="btn"
            name="intent"
            value="save-template"
            disabled={working}
          >
            {working && pendingIntent === "save-template"
              ? "Saving…"
              : "Save as new draft version"}
          </button>
          {selected?.versionStatus === "draft" ? (
            <button
              className="btn primary"
              name="intent"
              value="publish-template"
              formNoValidate
              disabled={working || templateDirty}
            >
              {templateDirty
                ? "Save changes before publishing"
                : working && pendingIntent === "publish-template"
                  ? "Publishing…"
                  : "Publish this saved version"}
            </button>
          ) : null}
          {selected?.versionStatus === "draft" ? (
            <input type="hidden" name="templateVersionId" value={selected.id} />
          ) : null}
        </div>
      </Form>
    </section>
  );
}

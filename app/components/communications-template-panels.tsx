import { FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link } from "react-router";

import { DraftRecoveryStatus } from "~/components/draft-recovery-feedback";
import { EmptyState } from "~/components/ui/states";
import {
  type MergeValues,
  mergeTemplateVariables,
  representativeMergeValues,
} from "~/modules/communications/merge-template";
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

const MERGE_FIELDS = Object.keys(representativeMergeValues);

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
        <span className="status info right">
          <span className="pc-num">{loaderData.templates.length}</span>
        </span>
      </div>
      <div className="template-list">
        {loaderData.templates.length ? (
          loaderData.templates.map((template) => (
            <Link
              key={template.id}
              to={`?template=${template.id}`}
              className={`template-item${selected?.id === template.id ? " active" : ""}`}
              aria-current={selected?.id === template.id ? "true" : undefined}
            >
              <strong title={template.name}>{template.name}</strong>
              <small>
                {categoryLabel(template.category)} ·{" "}
                <span className="pc-num">v{template.versionNumber}</span>
              </small>
              <span
                className="template-item-state"
                data-state={template.versionStatus}
              >
                {template.versionStatus === "published"
                  ? "Live"
                  : template.versionStatus}
              </span>
            </Link>
          ))
        ) : (
          <EmptyState
            className="comms-empty"
            icon={FileText}
            title="No templates yet"
            description="Create the first versioned email template with the editor beside this list."
          />
        )}
      </div>
    </aside>
  );
}

/**
 * A merge field the reader typed that Program Cue cannot fill is only found at
 * send time today, where it stops a real delivery. The editor knows the same
 * value set the sender uses, so it can say so while the reader is still typing.
 */
function unresolvableMergeFields(draft: TemplateDraftFields) {
  return [
    ...new Set([
      ...mergeTemplateVariables(draft.subject),
      ...mergeTemplateVariables(draft.body),
    ]),
  ].filter((field) => !(field in representativeMergeValues));
}

function fillMergeFields(text: string, mergeValues: MergeValues) {
  return text.replace(
    /\{\{\s*([a-z][a-zA-Z0-9.]*)\s*\}\}/gu,
    (token, field: string) =>
      field in mergeValues ? String(mergeValues[field] ?? "") : token,
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
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const metadataRequired = !selected || !draft.physicalAddress.trim();
  const [metadataOpen, setMetadataOpen] = useState(metadataRequired);
  useEffect(() => {
    if (metadataRequired) setMetadataOpen(true);
  }, [metadataRequired]);
  // Typing `{{recipient.firstName}}` by hand is where the unfillable fields
  // came from, so the fields that exist are offered rather than remembered.
  const insertMergeField = (field: string) => {
    const token = `{{${field}}}`;
    const element = bodyRef.current;
    if (!element) {
      onChange({ ...draft, body: `${draft.body}${token}` });
      return;
    }
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange({
      ...draft,
      body: `${draft.body.slice(0, start)}${token}${draft.body.slice(end)}`,
    });
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>{selected ? `Edit ${selected.name}` : "New email template"}</h2>
        {selected ? (
          <span
            className={`status ${selected.versionStatus === "published" ? "success" : "warning"} right`}
          >
            <span className="pc-num">v{selected.versionNumber}</span> ·{" "}
            {selected.versionStatus}
          </span>
        ) : null}
      </div>
      <Form
        key={selected?.id ?? "new-template"}
        method="post"
        className="stack comms-canvas"
      >
        {selected ? (
          <input type="hidden" name="templateId" value={selected.templateId} />
        ) : null}
        <label className="comms-canvas-field">
          <span className="sr-only">Subject</span>
          <textarea
            className="textarea comms-subject"
            name="subject"
            rows={1}
            value={draft.subject}
            onChange={(event) =>
              onChange({ ...draft, subject: event.target.value })
            }
            placeholder="Subject"
            required
          />
        </label>
        <label className="comms-canvas-field comms-canvas-body">
          <span className="sr-only">Message</span>
          <textarea
            ref={bodyRef}
            className="textarea comms-body"
            name="body"
            value={draft.body}
            onChange={(event) =>
              onChange({ ...draft, body: event.target.value })
            }
            placeholder="Write the message"
            required
          />
        </label>
        <details className="pc-disclosure comms-merge-fields">
          <summary>Insert a merge field</summary>
          <div className="comms-merge-field-list">
            {MERGE_FIELDS.map((field) => (
              <button
                key={field}
                className="btn small"
                type="button"
                onClick={() => insertMergeField(field)}
              >
                {field}
              </button>
            ))}
          </div>
        </details>
        <details
          className="pc-disclosure comms-merge-fields"
          open={metadataOpen || metadataRequired}
          onToggle={(event) => {
            if (metadataRequired) {
              setMetadataOpen(true);
              return;
            }
            setMetadataOpen(event.currentTarget.open);
          }}
        >
          <summary>Template name, type and footer</summary>
          <div className="stack mt">
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
                  onChange={(event) => {
                    const category = event.target.value;
                    onChange({
                      ...draft,
                      category,
                      ...(category === "submission_confirmation"
                        ? { buttonText: "", buttonUrl: "" }
                        : {}),
                    });
                  }}
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
              Physical address
              <textarea
                className="textarea"
                name="physicalAddress"
                rows={2}
                value={draft.physicalAddress}
                onChange={(event) =>
                  onChange({ ...draft, physicalAddress: event.target.value })
                }
                required
              />
              <span className="help">Required in the rendered footer.</span>
            </label>
            {draft.category === "submission_confirmation" ? (
              <p className="help">
                Program Cue adds a fixed <strong>Manage application</strong>
                action using the exact submitted application URL when this
                confirmation is sent.
              </p>
            ) : (
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
            )}
          </div>
        </details>
        <div className="row-actions">
          <DraftRecoveryStatus state={recoveryState} />
          <button
            type="submit"
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
              type="submit"
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

/**
 * The editor authored merge fields with nothing on screen showing what they
 * resolve to. This fills them with the same representative values the real
 * test send uses, so the reader checks the sentence rather than the syntax.
 * It is the message, not the sent email: the branded frame is added on send,
 * and claiming otherwise would be a preview that lies about fidelity.
 */
export function TemplatePreview({
  draft,
  mergeValues,
}: {
  draft: TemplateDraftFields;
  mergeValues: MergeValues;
}) {
  const preview = useMemo(
    () => ({
      subject: fillMergeFields(draft.subject, mergeValues),
      paragraphs: fillMergeFields(draft.body, mergeValues).split(/\n{2,}/u),
      unresolvable: unresolvableMergeFields(draft),
    }),
    [draft, mergeValues],
  );
  return (
    <aside className="comms-message-preview" aria-label="Message preview">
      <h2 className="sr-only">Message preview</h2>
      {preview.unresolvable.length ? (
        <div className="validation-item warn" role="status">
          <strong>△</strong>
          <span>
            Program Cue cannot fill{" "}
            {preview.unresolvable.map((field) => `{{${field}}}`).join(", ")}.
            Sending is refused until{" "}
            {preview.unresolvable.length === 1 ? "it is" : "they are"} removed
            or corrected.
          </span>
        </div>
      ) : null}
      <header className="comms-message-chrome">
        <div className="comms-message-chrome-row">
          <p className="comms-message-chrome-label">To</p>
          <p className="comms-message-paragraph">
            {String(mergeValues["recipient.name"])}
          </p>
        </div>
        <div className="comms-message-chrome-row">
          <p className="comms-message-chrome-label">Subject</p>
          <p className="comms-message-subject">{preview.subject}</p>
        </div>
      </header>
      <div className="comms-message-body">
        {preview.paragraphs.map((paragraph, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Preview paragraphs are stateless derived text and duplicate paragraph content is valid.
          <p key={index} className="comms-message-paragraph">
            {paragraph}
          </p>
        ))}
        {draft.category === "submission_confirmation" ? (
          <p className="comms-message-button">
            Manage application
            <small>Exact application URL generated when sent</small>
          </p>
        ) : draft.buttonText && draft.buttonUrl ? (
          <p className="comms-message-button">
            {draft.buttonText}
            <small>{draft.buttonUrl}</small>
          </p>
        ) : null}
      </div>
      <p className="comms-message-footer">
        {draft.physicalAddress}
        <small>
          Example recipient with this event's current details. This is a
          template preview, not delivery evidence. The Program Cue frame is
          added on send.
        </small>
      </p>
    </aside>
  );
}

import { ChevronDown, ChevronUp } from "lucide-react";

import {
  conditionalFieldOrderIssue,
  formConditionSourceLabel,
  formFieldTypeLabel,
} from "~/modules/submissions/form-builder-fields";
import type { SaveFormInput } from "~/modules/submissions/submission-schema";

/**
 * The form's keyboard-reorderable outline: what questions exist, and in what
 * order, beside the visual canvas.
 */
export function FormStructurePanel({
  input,
  selectedId,
  draftVersionNumber,
  change,
  onSelect,
  operationMessage,
  onOperationBlocked,
}: {
  input: SaveFormInput;
  selectedId: string | undefined;
  draftVersionNumber: number;
  change: (next: SaveFormInput) => void;
  onSelect: (fieldId: string) => void;
  operationMessage: string | null;
  onOperationBlocked: (message: string) => void;
}) {
  const fields = input.schema.fields;

  /* Reordering has to act on the row it is drawn on, not on whatever happens
     to be selected, or the two panes disagree about what "this field" means. */
  function moveFieldAt(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target]!, next[index]!];
    const issue = conditionalFieldOrderIssue(next);
    if (issue) {
      onOperationBlocked(issue);
      return;
    }
    change({ ...input, schema: { ...input.schema, fields: next } });
  }

  return (
    <section className="card fb-pane fb-outline">
      <div className="fb-pane-head">
        <h2>Form structure</h2>
        <span className="status info right">Draft v{draftVersionNumber}</span>
      </div>
      <div className="fb-pane-body">
        <label className="label mb">
          Introduction
          <textarea
            className="textarea fb-introduction"
            value={input.schema.introduction}
            onChange={(event) =>
              change({
                ...input,
                schema: { ...input.schema, introduction: event.target.value },
              })
            }
          />
        </label>
        {operationMessage ? (
          <div className="validation-item error mb" role="alert">
            <strong>Reorder blocked</strong>
            <span>{operationMessage}</span>
          </div>
        ) : null}
        <ul className="fb-field-list">
          {fields.map((field, index) => (
            <li
              className={`fb-field-row${field.id === selectedId ? " is-selected" : ""}`}
              key={field.id}
            >
              <button
                className="fb-field-select"
                type="button"
                aria-current={field.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(field.id)}
              >
                <span className="fb-field-index pc-num">{index + 1}</span>
                <span>
                  <span className="fb-field-name">
                    {field.label}
                    {/* Non-breaking, so a required mark never wraps alone onto
                        a line of its own in a 245px column. */}
                    {field.required ? "\u00a0*" : ""}
                  </span>
                  <span className="fb-field-kind">
                    {formFieldTypeLabel(field.type)}
                  </span>
                  {field.condition ? (
                    <span className="fb-field-condition">
                      Shown when{" "}
                      {formConditionSourceLabel(
                        fields,
                        field.condition.fieldId,
                      )}{" "}
                      = {field.condition.equals}
                    </span>
                  ) : null}
                </span>
              </button>
              <span className="fb-field-move">
                <button
                  type="button"
                  aria-label={`Move ${field.label} up`}
                  disabled={index === 0}
                  onClick={() => moveFieldAt(index, -1)}
                >
                  <ChevronUp size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${field.label} down`}
                  disabled={index === fields.length - 1}
                  onClick={() => moveFieldAt(index, 1)}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * When the form opens, closes and who may answer it. These are properties of
 * the form rather than of any field, so they live with the canvas and not in
 * the field inspector.
 */
export function PublicationSettingsFields({
  input,
  passwordConfigured,
  change,
}: {
  input: SaveFormInput;
  passwordConfigured: boolean;
  change: (next: SaveFormInput) => void;
}) {
  return (
    <div className="fb-form-settings">
      <label className="label">
        Closing date
        <input
          className="field"
          name="closeDate"
          type="date"
          value={input.closeDate ?? ""}
          onChange={(event) =>
            change({ ...input, closeDate: event.target.value || null })
          }
        />
      </label>
      <label className="label">
        Overall limit
        <input
          className="field"
          name="submissionLimit"
          type="number"
          min={1}
          value={input.submissionLimit ?? ""}
          onChange={(event) =>
            change({
              ...input,
              submissionLimit: event.target.value
                ? Number(event.target.value)
                : null,
            })
          }
          placeholder="No limit"
        />
      </label>
      <label className="label">
        Min speakers
        <input
          className="field"
          name="minSpeakers"
          type="number"
          min={1}
          max={20}
          value={input.minSpeakers}
          onChange={(event) =>
            change({ ...input, minSpeakers: Number(event.target.value) })
          }
        />
      </label>
      <label className="label">
        Max speakers
        <input
          className="field"
          name="maxSpeakers"
          type="number"
          min={1}
          max={20}
          value={input.maxSpeakers ?? ""}
          onChange={(event) =>
            change({
              ...input,
              maxSpeakers: event.target.value
                ? Number(event.target.value)
                : null,
            })
          }
        />
      </label>
      <label className="label">
        Applicant access
        <select
          className="select"
          name="accessMode"
          value={input.accessMode}
          onChange={(event) =>
            change({
              ...input,
              accessMode: event.target.value as SaveFormInput["accessMode"],
            })
          }
        >
          <option value="email_verified">Verified email</option>
          <option value="account_required">Program Cue account</option>
          <option value="password_protected">
            Form password + verified email
          </option>
        </select>
      </label>
      {input.accessMode === "password_protected" ? (
        <label className="label">
          {passwordConfigured ? "Replace form password" : "Form password"}
          <input
            className="field"
            name="accessPassword"
            type="password"
            minLength={8}
            required={!passwordConfigured}
            value={input.accessPassword}
            onChange={(event) =>
              change({ ...input, accessPassword: event.target.value })
            }
            placeholder={
              passwordConfigured
                ? "Leave blank to keep current"
                : "At least 8 characters"
            }
          />
          <span className="help">
            Passwords are never stored in browser recovery. Re-enter a new value
            after refreshing this page.
          </span>
        </label>
      ) : (
        <input type="hidden" name="accessPassword" value="" />
      )}
      {input.kind === "direct_session" ? (
        <label className="label">
          Session duration override (minutes)
          <input
            className="field"
            type="number"
            min={5}
            max={480}
            value={input.routing.directSessionDurationMinutes ?? ""}
            placeholder="Use the selected format default"
            onChange={(event) =>
              change({
                ...input,
                routing: {
                  ...input.routing,
                  directSessionDurationMinutes: event.target.value
                    ? Number(event.target.value)
                    : null,
                },
              })
            }
          />
          <span className="help">
            Leave blank to use the selected Event Setup format’s default.
          </span>
        </label>
      ) : null}
    </div>
  );
}

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { CharacterCount } from "~/components/ui/character-count";
import { requireValue } from "~/lib/required-value";

import {
  conditionalFieldOrderIssue,
  formConditionSourceLabel,
  formFieldTypeLabel,
} from "~/modules/submissions/form-builder-fields";
import {
  formLayout,
  formLayoutSchema,
  formSectionsForDisplay,
  MAX_FORM_SECTIONS,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";

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
  const fields = formSectionsForDisplay(input.schema).flatMap(
    (section) => section.fields,
  );

  /* Reordering has to act on the row it is drawn on, not on whatever happens
     to be selected, or the two panes disagree about what "this field" means. */
  function moveFieldAt(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    if (
      requireValue(fields[index], "Required fields[index] is unavailable.")
        .sectionId !==
      requireValue(fields[target], "Required fields[target] is unavailable.")
        .sectionId
    ) {
      onOperationBlocked(
        "Use the field's Section setting to move it between sections.",
      );
      return;
    }
    const next = [...fields];
    [next[index], next[target]] = [
      requireValue(next[target], "Required next[target] is unavailable."),
      requireValue(next[index], "Required next[index] is unavailable."),
    ];
    const issue = conditionalFieldOrderIssue(next);
    if (issue) {
      onOperationBlocked(issue);
      return;
    }
    change({ ...input, schema: { ...input.schema, fields: next } });
  }

  function addSection() {
    if (input.schema.sections.length >= MAX_FORM_SECTIONS) {
      onOperationBlocked(
        `A form can contain at most ${MAX_FORM_SECTIONS} sections.`,
      );
      return;
    }
    const existing = new Set(
      input.schema.sections.map((section) => section.id),
    );
    let suffix = input.schema.sections.length + 1;
    let id = `section_${suffix}`;
    while (existing.has(id)) {
      suffix += 1;
      id = `section_${suffix}`;
    }
    change({
      ...input,
      schema: {
        ...input.schema,
        sections: [
          ...input.schema.sections,
          { id, title: `Section ${suffix}`, description: "" },
        ],
      },
    });
  }

  function moveSection(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= input.schema.sections.length) return;
    const sections = [...input.schema.sections];
    [sections[index], sections[target]] = [
      requireValue(
        sections[target],
        "Required sections[target] is unavailable.",
      ),
      requireValue(sections[index], "Required sections[index] is unavailable."),
    ];
    const orderedFields = sections.flatMap((section) =>
      fields.filter((field) => field.sectionId === section.id),
    );
    const issue = conditionalFieldOrderIssue(orderedFields);
    if (issue) {
      onOperationBlocked(issue);
      return;
    }
    change({ ...input, schema: { ...input.schema, sections } });
  }

  function removeSection(index: number) {
    if (input.schema.sections.length === 1) return;
    const removed = requireValue(
      input.schema.sections[index],
      "Required input.schema.sections[index] is unavailable.",
    );
    const assignedFields = fields.filter(
      (field) => field.sectionId === removed.id,
    );
    if (assignedFields.length) {
      onOperationBlocked(
        `Move ${assignedFields.length} assigned ${assignedFields.length === 1 ? "field" : "fields"} to another section before removing “${removed.title}”.`,
      );
      return;
    }
    change({
      ...input,
      schema: {
        ...input.schema,
        sections: input.schema.sections.filter(
          (section) => section.id !== removed.id,
        ),
      },
    });
  }

  return (
    <section className="card fb-pane fb-outline">
      <div className="fb-pane-head">
        <h2>Form structure</h2>
        <span className="fb-draft-pill right">Draft v{draftVersionNumber}</span>
      </div>
      <div className="fb-pane-body">
        <label className="fb-intro-editor">
          <span className="fb-kicker">Introduction</span>
          <textarea
            className="textarea fb-introduction"
            value={input.schema.introduction}
            maxLength={2_000}
            onChange={(event) =>
              change({
                ...input,
                schema: { ...input.schema, introduction: event.target.value },
              })
            }
          />
          <CharacterCount value={input.schema.introduction} maximum={2_000} />
        </label>
        <label className="fb-intro-editor">
          <span className="fb-kicker">Applicant layout</span>
          <select
            className="select"
            value={formLayout(input.schema)}
            onChange={(event) => {
              const parsed = formLayoutSchema.safeParse(event.target.value);
              if (!parsed.success) return;
              change({
                ...input,
                schema: { ...input.schema, layout: parsed.data },
              });
            }}
          >
            <option value="single_page">Single page</option>
            <option value="steps">Steps (one section per page)</option>
          </select>
          <span className="help">
            Steps reuse these sections as pages and add a Speakers page at the
            end. Speakers is not a builder section.
          </span>
        </label>
        <div className="fb-section-list">
          <div className="fb-kicker-row">
            <span className="fb-kicker">Sections</span>
            <button className="fb-ghost-add" type="button" onClick={addSection}>
              <Plus size={13} aria-hidden="true" /> Add section
            </button>
          </div>
          {input.schema.sections.map((section, index) => (
            <div className="fb-section-item" key={section.id}>
              <div className="fb-section-item-main">
                <label className="fb-section-title">
                  <span className="sr-only">Section title</span>
                  <input
                    className="fb-inline-input"
                    value={section.title}
                    maxLength={120}
                    required
                    onChange={(event) => {
                      const sections = input.schema.sections.map((candidate) =>
                        candidate.id === section.id
                          ? { ...candidate, title: event.target.value }
                          : candidate,
                      );
                      change({
                        ...input,
                        schema: { ...input.schema, sections },
                      });
                    }}
                  />
                </label>
                <label className="fb-section-desc">
                  <span className="sr-only">Description (optional)</span>
                  <textarea
                    className="fb-inline-input"
                    rows={2}
                    value={section.description}
                    maxLength={500}
                    placeholder="Optional description"
                    onChange={(event) => {
                      const sections = input.schema.sections.map((candidate) =>
                        candidate.id === section.id
                          ? { ...candidate, description: event.target.value }
                          : candidate,
                      );
                      change({
                        ...input,
                        schema: { ...input.schema, sections },
                      });
                    }}
                  />
                </label>
              </div>
              <div className="fb-section-item-actions">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => moveSection(index, -1)}
                >
                  <ChevronUp size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === input.schema.sections.length - 1}
                  onClick={() => moveSection(index, 1)}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
                <button
                  className="is-danger"
                  type="button"
                  aria-label="Remove"
                  disabled={input.schema.sections.length === 1}
                  onClick={() => removeSection(index)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
        {operationMessage ? (
          <div className="validation-item error mb" role="alert">
            <strong>Change blocked</strong>
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
  eventTimezone,
}: {
  input: SaveFormInput;
  passwordConfigured: boolean;
  change: (next: SaveFormInput) => void;
  eventTimezone: string;
}) {
  return (
    <div className="fb-form-settings">
      <label className="label">
        Opening date
        <input
          className="field"
          name="openDate"
          type="date"
          value={input.openDate ?? ""}
          onInput={(event) =>
            change({ ...input, openDate: event.currentTarget.value || null })
          }
        />
        <span className="help">
          Leave blank to accept applications immediately after publication.
        </span>
      </label>
      <label className="label">
        Closing date
        <input
          className="field"
          name="closeDate"
          type="date"
          value={input.closeDate ?? ""}
          onInput={(event) =>
            change({ ...input, closeDate: event.currentTarget.value || null })
          }
        />
        <span className="help">
          Applications close at 11:59 PM in {eventTimezone}.
        </span>
      </label>
      <label className="label">
        Total submission capacity
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
        <span className="help">Across all applicants for this form.</span>
      </label>
      <label className="label">
        Maximum submissions per person
        <input
          className="field"
          name="perPersonSubmissionLimit"
          type="number"
          min={1}
          value={input.perPersonSubmissionLimit ?? ""}
          onChange={(event) =>
            change({
              ...input,
              perPersonSubmissionLimit: event.target.value
                ? Number(event.target.value)
                : null,
            })
          }
          placeholder="No limit"
        />
        <span className="help">
          Counts active drafts and submitted applications by a verified person.
        </span>
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
            change({
              ...input,
              minSpeakers: Number(event.target.value),
              maxSpeakers:
                input.maxSpeakers !== null &&
                input.maxSpeakers < Number(event.target.value)
                  ? Number(event.target.value)
                  : input.maxSpeakers,
            })
          }
        />
      </label>
      <label className="label">
        Max speakers
        <input
          className="field"
          name="maxSpeakers"
          type="number"
          min={input.minSpeakers}
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
      <p className="help">
        Speaker range: {input.minSpeakers}
        {input.maxSpeakers === null || input.maxSpeakers === input.minSpeakers
          ? input.maxSpeakers === null
            ? "+"
            : ""
          : `–${input.maxSpeakers}`}{" "}
        speaker
        {input.maxSpeakers === 1 ? "" : "s"}.
      </p>
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

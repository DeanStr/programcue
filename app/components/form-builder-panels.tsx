import { useEffect, useState } from "react";

import type { FormWorkspace } from "~/modules/submissions/submission-repository.server";
import {
  validateAnswerShapes,
  validateFinalAnswers,
  visibleFields,
  type FormField,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";

const FIELD_TYPES: Array<{ value: FormField["type"]; label: string }> = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "select", label: "Dropdown" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "url", label: "URL" },
  { value: "video", label: "Video upload or URL" },
];

function newField(type: FormField["type"], index: number): FormField {
  return {
    id: `field_${index + 1}`,
    label: FIELD_TYPES.find((item) => item.value === type)?.label ?? "Question",
    type,
    required: false,
    help: "",
    options:
      type === "select" || type === "multi_select"
        ? ["Option 1", "Option 2"]
        : [],
    reviewVisibility: "administrators_only",
    condition: null,
  };
}

function nextFieldIndex(fields: FormField[]) {
  const ids = new Set(fields.map((field) => field.id));
  let index = fields.length + 1;
  while (ids.has(`field_${index}`)) index += 1;
  return index - 1;
}

function publishedLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function FieldPreview({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange(value: string | string[]): void;
}) {
  if (field.type === "long_text")
    return (
      <textarea
        className="textarea"
        maxLength={5_000}
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (field.type === "select")
    return (
      <select
        className="select"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  if (field.type === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="stack">
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option]
                    : selected.filter((item) => item !== option),
                )
              }
            />{" "}
            {option}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      className="field"
      type={field.type === "url" || field.type === "video" ? "url" : "text"}
      maxLength={field.id === "title" ? 180 : 5_000}
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function FieldLibraryPanel({
  input,
  passwordConfigured,
  change,
  onSelect,
}: {
  input: SaveFormInput;
  passwordConfigured: boolean;
  change: (next: SaveFormInput) => void;
  onSelect: (fieldId: string) => void;
}) {
  return (
    <section className="card builder-panel">
      <div className="card-title">
        <h2>Field library</h2>
      </div>
      <div className="field-library">
        {FIELD_TYPES.map((fieldType) => (
          <button
            className="field-option"
            type="button"
            key={fieldType.value}
            onClick={() => {
              const field = newField(
                fieldType.value,
                nextFieldIndex(input.schema.fields),
              );
              change({
                ...input,
                schema: {
                  ...input.schema,
                  fields: [...input.schema.fields, field],
                },
              });
              onSelect(field.id);
            }}
          >
            <span>＋</span>
            {fieldType.label}
          </button>
        ))}
      </div>
      <div className="divider" />
      <h3>Publication settings</h3>
      <label className="label mt">
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
      <label className="label mt">
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
      <div className="form-row mt">
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
      </div>
      <label className="label mt">
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
        <label className="label mt">
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
        <label className="label mt">
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
    </section>
  );
}

export function FormStructurePanel({
  input,
  selectedId,
  draftVersionNumber,
  change,
  onSelect,
}: {
  input: SaveFormInput;
  selectedId: string | undefined;
  draftVersionNumber: number;
  change: (next: SaveFormInput) => void;
  onSelect: (fieldId: string) => void;
}) {
  return (
    <section className="card builder-panel">
      <div className="card-title">
        <h2>Form structure</h2>
        <span className="status info right">Draft v{draftVersionNumber}</span>
      </div>
      <label className="label mb">
        Introduction
        <textarea
          className="textarea"
          value={input.schema.introduction}
          onChange={(event) =>
            change({
              ...input,
              schema: { ...input.schema, introduction: event.target.value },
            })
          }
        />
      </label>
      <div className="form-canvas">
        {input.schema.fields.map((field, index) => (
          <button
            className={`form-field-card${field.id === selectedId ? " selected" : ""}`}
            type="button"
            key={field.id}
            onClick={() => onSelect(field.id)}
            style={{ width: "100%", textAlign: "left" }}
          >
            <span className="drag-handle">⠿</span>
            <span>
              <strong>{field.label}</strong>
              {field.required ? " *" : ""}
              <small className="subtle" style={{ display: "block" }}>
                {FIELD_TYPES.find((type) => type.value === field.type)?.label}
              </small>
              {field.condition ? (
                <span className="conditional-note">
                  Shown when {field.condition.fieldId} ={" "}
                  {field.condition.equals}
                </span>
              ) : null}
            </span>
            <span>{index + 1}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function FieldSettingsPanel({
  input,
  selected,
  categoryField,
  change,
  patchField,
  moveField,
  setSelectedId,
  routingTeams,
}: {
  input: SaveFormInput;
  selected: FormField | undefined;
  categoryField: FormField | undefined;
  change: (next: SaveFormInput) => void;
  patchField: (patch: Partial<FormField>) => void;
  moveField: (direction: -1 | 1) => void;
  setSelectedId: (fieldId: string) => void;
  routingTeams: Array<{ id: string; name: string }>;
}) {
  return (
    <section className="card builder-panel settings-panel">
      <div className="card-title">
        <h2>Field settings</h2>
        {selected ? (
          <span className="pill right">{selected.type.replace("_", " ")}</span>
        ) : null}
      </div>
      {selected ? (
        <>
          <label className="label">
            Stable field ID
            <input
              className="field"
              value={selected.id}
              onChange={(event) => {
                const oldId = selected.id;
                const nextId = event.target.value;
                setSelectedId(nextId);
                change({
                  ...input,
                  schema: {
                    ...input.schema,
                    fields: input.schema.fields.map((field) => ({
                      ...field,
                      id: field.id === oldId ? nextId : field.id,
                      condition:
                        field.condition?.fieldId === oldId
                          ? { ...field.condition, fieldId: nextId }
                          : field.condition,
                    })),
                  },
                });
              }}
            />
          </label>
          <label className="label mt">
            Label
            <input
              className="field"
              value={selected.label}
              onChange={(event) => patchField({ label: event.target.value })}
            />
          </label>
          <label className="label mt">
            Help text
            <textarea
              className="textarea"
              value={selected.help}
              onChange={(event) => patchField({ help: event.target.value })}
            />
          </label>
          {selected.type === "select" || selected.type === "multi_select" ? (
            <label className="label mt">
              Options, one per line
              <textarea
                className="textarea"
                value={selected.options.join("\n")}
                onChange={(event) =>
                  patchField({
                    options: event.target.value
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          ) : null}
          <label className="label mt">
            Blinded-review visibility
            <select
              className="select"
              value={selected.reviewVisibility ?? "administrators_only"}
              onChange={(event) =>
                patchField({
                  reviewVisibility: event.target
                    .value as FormField["reviewVisibility"],
                })
              }
            >
              <option value="reviewers">Show answer to reviewers</option>
              <option value="administrators_only">
                Hide answer from reviewers
              </option>
            </select>
            <span className="help">
              Keep identity and biography answers hidden. This setting applies
              only when blinded reviewing is enabled.
            </span>
          </label>
          <label className="toggle mt">
            <input
              type="checkbox"
              checked={selected.required}
              onChange={(event) =>
                patchField({ required: event.target.checked })
              }
            />{" "}
            Required when visible
          </label>
          <div className="divider" />
          <h3>Conditional logic</h3>
          <label className="label mt">
            Show this field when
            <select
              className="select"
              value={selected.condition?.fieldId ?? ""}
              onChange={(event) =>
                patchField({
                  condition: event.target.value
                    ? { fieldId: event.target.value, equals: "" }
                    : null,
                })
              }
            >
              <option value="">Always visible</option>
              {input.schema.fields
                .slice(
                  0,
                  input.schema.fields.findIndex(
                    (field) => field.id === selected.id,
                  ),
                )
                .filter(
                  (field) =>
                    field.type === "select" || field.type === "multi_select",
                )
                .map((field) => (
                  <option value={field.id} key={field.id}>
                    {field.label}
                  </option>
                ))}
            </select>
          </label>
          {selected.condition ? (
            <label className="label mt">
              Equals
              <select
                className="select"
                value={selected.condition.equals}
                onChange={(event) =>
                  patchField({
                    condition: {
                      ...selected.condition!,
                      equals: event.target.value,
                    },
                  })
                }
              >
                <option value="">Choose…</option>
                {input.schema.fields
                  .find((field) => field.id === selected.condition?.fieldId)
                  ?.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
              </select>
            </label>
          ) : null}
          <div className="page-actions mt">
            <button
              className="btn small"
              type="button"
              onClick={() => moveField(-1)}
            >
              Move up
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => moveField(1)}
            >
              Move down
            </button>
            {!["title", "category", "format"].includes(selected.id) ? (
              <button
                className="btn small danger"
                type="button"
                onClick={() => {
                  const fields = input.schema.fields
                    .filter((field) => field.id !== selected.id)
                    .map((field) =>
                      field.condition?.fieldId === selected.id
                        ? { ...field, condition: null }
                        : field,
                    );
                  change({ ...input, schema: { ...input.schema, fields } });
                  setSelectedId(fields[0]?.id ?? "");
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="subtle">Select a field to configure it.</p>
      )}
      <div className="divider" />
      <h3>Category routing</h3>
      {categoryField?.options.map((category) => (
        <label className="label mt" key={category}>
          {category}
          <select
            className="select"
            value={input.routing.categories[category] ?? ""}
            onChange={(event) => {
              const teamId = event.target.value;
              const categories = { ...input.routing.categories };
              if (teamId) categories[category] = teamId;
              else delete categories[category];
              change({
                ...input,
                routing: {
                  ...input.routing,
                  categories,
                  teamNames: Object.fromEntries(
                    routingTeams.map((team) => [team.id, team.name]),
                  ),
                },
              });
            }}
          >
            <option value="">No automatic team route</option>
            {routingTeams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      {!routingTeams.length ? (
        <p className="help mt">
          Create an active evaluation team before configuring automatic category
          routing.
        </p>
      ) : null}
    </section>
  );
}

export function ApplicantPreviewPanel({
  input,
  brandAccent,
  eventName,
}: {
  input: SaveFormInput;
  brandAccent?: string;
  eventName?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [speakerCount, setSpeakerCount] = useState(input.minSpeakers);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [validated, setValidated] = useState(false);
  const [viewport, setViewport] = useState<"mobile" | "desktop">("mobile");
  useEffect(() => {
    setAnswers({});
    setSpeakerCount(input.minSpeakers);
    setErrors({});
    setValidated(false);
  }, [input.id, input.schema, input.minSpeakers]);
  const previewFields = visibleFields(input.schema, answers);

  function updateAnswer(fieldId: string, value: string | string[]) {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
    setErrors({});
    setValidated(false);
  }

  function validatePreview() {
    const speakers = Array.from({ length: speakerCount }, (_, index) => ({
      name: `Test speaker ${index + 1}`,
      email: `test-speaker-${index + 1}@example.invalid`,
    }));
    const nextErrors = {
      ...validateAnswerShapes(input.schema, answers),
      ...validateFinalAnswers(
        input.schema,
        answers,
        speakers,
        input.minSpeakers,
        input.maxSpeakers,
      ),
    };
    setErrors(nextErrors);
    setValidated(true);
  }

  return (
    <section
      className={`card builder-panel preview-panel${viewport === "desktop" ? " preview-desktop" : ""}`}
    >
      <div className="card-title">
        <h2>Live applicant preview</h2>
        <span
          className="preview-viewport-controls right"
          role="group"
          aria-label="Applicant preview size"
        >
          <button
            className="btn small"
            type="button"
            aria-pressed={viewport === "mobile"}
            onClick={() => setViewport("mobile")}
          >
            Mobile
          </button>
          <button
            className="btn small"
            type="button"
            aria-pressed={viewport === "desktop"}
            onClick={() => setViewport("desktop")}
          >
            Desktop
          </button>
        </span>
      </div>
      <p className="help mb">
        Isolated test mode exercises conditional fields and validation without
        creating applicant or submission records.
      </p>
      <div className={`phone preview-device-${viewport}`}>
        <div
          className="phone-head"
          style={{
            background: `linear-gradient(135deg,#111b3f,${brandAccent ?? "#4f46e5"})`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="brand-mark small">P</span>
            <strong>Program Cue</strong>
          </div>
          <h3>{input.name}</h3>
          <small>{eventName ?? "Your event"}</small>
        </div>
        <div className="phone-body">
          <p className="tiny subtle">{input.schema.introduction}</p>
          {previewFields.map((field) =>
            field.type === "multi_select" ? (
              <fieldset className="application-choice-field" key={field.id}>
                <legend className="label">
                  {field.label}
                  {field.required ? " *" : ""}
                </legend>
                {field.help ? <span className="help">{field.help}</span> : null}
                <FieldPreview
                  field={field}
                  value={answers[field.id]}
                  onChange={(value) => updateAnswer(field.id, value)}
                />
                {errors[field.id]?.[0] ? (
                  <span className="field-error">{errors[field.id][0]}</span>
                ) : null}
              </fieldset>
            ) : (
              <label className="label" key={field.id}>
                {field.label}
                {field.required ? " *" : ""}
                {field.help ? <span className="help">{field.help}</span> : null}
                <FieldPreview
                  field={field}
                  value={answers[field.id]}
                  onChange={(value) => updateAnswer(field.id, value)}
                />
                {errors[field.id]?.[0] ? (
                  <span className="field-error">{errors[field.id][0]}</span>
                ) : null}
              </label>
            ),
          )}
          <label className="label">
            Test speaker count
            <input
              className="field"
              type="number"
              min={1}
              max={20}
              value={speakerCount}
              onChange={(event) => {
                setSpeakerCount(Number(event.target.value));
                setErrors({});
                setValidated(false);
              }}
            />
            {errors.speakers?.[0] ? (
              <span className="field-error">{errors.speakers[0]}</span>
            ) : null}
          </label>
          {validated ? (
            <div
              className={`validation-item ${Object.keys(errors).length ? "error" : "ok"}`}
              role={Object.keys(errors).length ? "alert" : "status"}
            >
              <strong>{Object.keys(errors).length ? "△" : "✓"}</strong>
              <span>
                {Object.keys(errors).length
                  ? "This test submission needs the highlighted changes."
                  : "This test submission passes the current form rules."}
              </span>
            </div>
          ) : null}
          <button
            className="btn primary"
            type="button"
            onClick={validatePreview}
          >
            Validate test submission
          </button>
          <small className="help">
            Test values stay in this preview. No applicant or submission record
            is saved.
          </small>
        </div>
      </div>
    </section>
  );
}

export function FormVersionHistory({
  workspace,
  eventTimezone,
}: {
  workspace: FormWorkspace;
  eventTimezone: string;
}) {
  return (
    <section className="card pad mt">
      <div className="card-title">
        <h2>Version history</h2>
        <span className="subtle right">
          Published submissions retain their original form version.
        </span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Published ({eventTimezone})</th>
            </tr>
          </thead>
          <tbody>
            {workspace.versions.map((version) => (
              <tr key={version.id}>
                <td>
                  <strong>v{version.versionNumber}</strong>
                </td>
                <td>
                  <span
                    className={`status ${version.status === "published" ? "success" : version.status === "draft" ? "info" : "neutral"}`}
                  >
                    {version.status}
                  </span>
                </td>
                <td>
                  {version.publishedAt
                    ? publishedLabel(version.publishedAt, eventTimezone)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

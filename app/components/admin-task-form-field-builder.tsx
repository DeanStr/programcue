import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { TaskFormField } from "~/modules/tasks/task-schema";

function nextFieldId(fields: TaskFormField[]) {
  const existing = new Set(fields.map((field) => field.id));
  let index = fields.length + 1;
  while (existing.has(`field_${index}`)) index += 1;
  return `field_${index}`;
}

function conditionCandidates(fields: TaskFormField[], fieldIndex: number) {
  return fields
    .slice(0, fieldIndex)
    .filter(
      (field) =>
        field.type === "boolean" ||
        (field.type === "select" && field.options.length > 0),
    );
}

function withoutConditionalRequirement(field: TaskFormField): TaskFormField {
  const { requiredWhen: _requiredWhen, ...remaining } = field;
  return remaining;
}

function normalizeConditions(fields: TaskFormField[]) {
  return fields.map((field, index) => {
    if (!field.requiredWhen) return field;
    const dependencyIndex = fields.findIndex(
      (candidate) => candidate.id === field.requiredWhen?.fieldId,
    );
    const dependency = fields[dependencyIndex];
    const validBoolean =
      dependency?.type === "boolean" &&
      typeof field.requiredWhen.equals === "boolean";
    const validSelect =
      dependency?.type === "select" &&
      typeof field.requiredWhen.equals === "string" &&
      dependency.options.includes(field.requiredWhen.equals);
    return dependencyIndex >= 0 &&
      dependencyIndex < index &&
      (validBoolean || validSelect)
      ? field
      : withoutConditionalRequirement(field);
  });
}

function SelectOptionsEditor({
  field,
  onChange,
}: {
  field: TaskFormField;
  onChange(options: string[]): void;
}) {
  const [value, setValue] = useState(() => field.options.join("\n"));
  const tooManyOptions = field.options.length > 20;
  const errorId = `task-form-options-${field.id}-error`;
  return (
    <>
      <textarea
        aria-describedby={tooManyOptions ? errorId : undefined}
        aria-invalid={tooManyOptions || undefined}
        className="textarea"
        id={`task-form-options-${field.id}`}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          setValue(nextValue);
          onChange(
            nextValue
              .split("\n")
              .map((option) => option.trim())
              .filter(Boolean),
          );
        }}
        placeholder={"Standard\nPremium\nNot required"}
        rows={4}
        value={value}
      />
      {tooManyOptions ? (
        <span className="field-error" id={errorId} role="alert">
          Select fields support at most 20 options.
        </span>
      ) : null}
    </>
  );
}

export function AdminTaskFormFieldBuilder({
  fields,
  onChange,
}: {
  fields: TaskFormField[];
  onChange(fields: TaskFormField[]): void;
}) {
  function replaceField(index: number, field: TaskFormField) {
    onChange(
      normalizeConditions(
        fields.map((candidate, candidateIndex) =>
          candidateIndex === index ? field : candidate,
        ),
      ),
    );
  }

  function moveField(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= fields.length) return;
    const currentField = fields[index];
    const destinationField = fields[destination];
    if (!currentField || !destinationField) return;
    const reordered = fields.map((field, candidateIndex) =>
      candidateIndex === index
        ? destinationField
        : candidateIndex === destination
          ? currentField
          : field,
    );
    onChange(normalizeConditions(reordered));
  }

  return (
    <fieldset className="task-form-field-builder stack">
      <legend className="sr-only">Structured task questions</legend>
      <div className="task-form-field-builder-head">
        <div>
          <strong>Questions</strong>
          <p className="help">
            Answers are stored as task evidence. They do not overwrite a
            participant profile or session record.
          </p>
        </div>
        <button
          className="btn small"
          disabled={fields.length >= 20}
          onClick={() =>
            onChange([
              ...fields,
              {
                id: nextFieldId(fields),
                label: "",
                type: "short_text",
                required: false,
                help: "",
                options: [],
              },
            ])
          }
          type="button"
        >
          <Plus aria-hidden size={14} /> Add question
        </button>
      </div>
      {fields.length === 0 ? (
        <div className="validation-item info" role="status">
          <strong>Add at least one question</strong>
          <span>Short-form templates require a structured question.</span>
        </div>
      ) : null}
      {fields.map((field, index) => {
        const dependencies = conditionCandidates(fields, index);
        const selectedDependency = dependencies.find(
          (candidate) => candidate.id === field.requiredWhen?.fieldId,
        );
        return (
          <article className="task-form-field-card" key={field.id}>
            <div className="task-form-field-card-head">
              <strong>Question {index + 1}</strong>
              <div className="page-actions">
                <button
                  aria-label={`Move question ${index + 1} up`}
                  className="btn small icon-only"
                  disabled={index === 0}
                  onClick={() => moveField(index, -1)}
                  type="button"
                >
                  <ArrowUp aria-hidden size={14} />
                </button>
                <button
                  aria-label={`Move question ${index + 1} down`}
                  className="btn small icon-only"
                  disabled={index === fields.length - 1}
                  onClick={() => moveField(index, 1)}
                  type="button"
                >
                  <ArrowDown aria-hidden size={14} />
                </button>
                <button
                  aria-label={`Remove question ${index + 1}`}
                  className="btn small icon-only danger"
                  onClick={() =>
                    onChange(
                      normalizeConditions(
                        fields.filter(
                          (_candidate, candidateIndex) =>
                            candidateIndex !== index,
                        ),
                      ),
                    )
                  }
                  type="button"
                >
                  <Trash2 aria-hidden size={14} />
                </button>
              </div>
            </div>
            <div className="form-row">
              <label className="label">
                Question label
                <input
                  className="field"
                  maxLength={120}
                  onChange={(event) =>
                    replaceField(index, {
                      ...field,
                      label: event.currentTarget.value,
                    })
                  }
                  required
                  value={field.label}
                />
              </label>
              <label className="label">
                Answer type
                <select
                  className="select"
                  onChange={(event) => {
                    const type = event.currentTarget
                      .value as TaskFormField["type"];
                    replaceField(index, {
                      ...field,
                      type,
                      options: type === "select" ? field.options : [],
                    });
                  }}
                  value={field.type}
                >
                  <option value="short_text">Short text</option>
                  <option value="long_text">Long text</option>
                  <option value="date">Date</option>
                  <option value="boolean">Yes or no</option>
                  <option value="select">Select one</option>
                </select>
              </label>
            </div>
            <label className="label">
              Help text
              <input
                className="field"
                maxLength={300}
                onChange={(event) =>
                  replaceField(index, {
                    ...field,
                    help: event.currentTarget.value,
                  })
                }
                value={field.help}
              />
            </label>
            {field.type === "select" ? (
              <label
                className="label"
                htmlFor={`task-form-options-${field.id}`}
              >
                Options
                <SelectOptionsEditor
                  field={field}
                  onChange={(options) =>
                    replaceField(index, {
                      ...field,
                      options,
                    })
                  }
                />
                <span className="help">
                  One unique option per line, up to 20 options.
                </span>
              </label>
            ) : null}
            <label className="speaker-confirm">
              <input
                checked={field.required}
                onChange={(event) =>
                  replaceField(index, {
                    ...(event.currentTarget.checked
                      ? withoutConditionalRequirement(field)
                      : field),
                    required: event.currentTarget.checked,
                  })
                }
                type="checkbox"
              />{" "}
              Always require this answer
            </label>
            {dependencies.length ? (
              <div className="form-row">
                <label className="label">
                  Or require when
                  <select
                    className="select"
                    onChange={(event) => {
                      const dependency = dependencies.find(
                        (candidate) =>
                          candidate.id === event.currentTarget.value,
                      );
                      replaceField(index, {
                        ...(dependency
                          ? field
                          : withoutConditionalRequirement(field)),
                        ...(dependency
                          ? {
                              required: false,
                              requiredWhen: {
                                fieldId: dependency.id,
                                equals:
                                  dependency.type === "boolean"
                                    ? true
                                    : (dependency.options[0] ?? ""),
                              },
                            }
                          : {}),
                      });
                    }}
                    value={field.requiredWhen?.fieldId ?? ""}
                  >
                    <option value="">No conditional requirement</option>
                    {dependencies.map((dependency) => (
                      <option key={dependency.id} value={dependency.id}>
                        {dependency.label ||
                          `Question ${fields.indexOf(dependency) + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedDependency && field.requiredWhen ? (
                  <label className="label">
                    Equals
                    <select
                      className="select"
                      onChange={(event) =>
                        replaceField(index, {
                          ...field,
                          requiredWhen: {
                            fieldId: selectedDependency.id,
                            equals:
                              selectedDependency.type === "boolean"
                                ? event.currentTarget.value === "true"
                                : event.currentTarget.value,
                          },
                        })
                      }
                      value={String(field.requiredWhen.equals)}
                    >
                      {selectedDependency.type === "boolean" ? (
                        <>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </>
                      ) : (
                        selectedDependency.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                ) : (
                  <span />
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </fieldset>
  );
}

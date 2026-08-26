import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { requireValue } from "~/lib/required-value";
import { formFieldTypeLabel } from "~/modules/submissions/form-builder-fields";
import type {
  FormField,
  SaveFormInput,
} from "~/modules/submissions/submission-schema";
import { formFieldsInDisplayOrder } from "~/modules/submissions/submission-schema";

export function FieldSettingsPanel({
  input,
  selected,
  categoryField,
  change,
  patchField,
  setSelectedId,
  routingTeams,
  routingTracks,
  paneSwitch,
  hidden,
  formProperties,
  formPropertiesForceOpen = false,
}: {
  input: SaveFormInput;
  selected: FormField | undefined;
  categoryField: FormField | undefined;
  change: (next: SaveFormInput) => void;
  patchField: (patch: Partial<FormField>) => void;
  setSelectedId: (fieldId: string) => void;
  routingTeams: Array<{ id: string; name: string }>;
  routingTracks: Array<{ id: string; name: string }>;
  paneSwitch?: ReactNode;
  hidden?: boolean;
  formProperties?: ReactNode;
  formPropertiesForceOpen?: boolean;
}) {
  const [allowIdChange, setAllowIdChange] = useState(false);
  const displayFields = formFieldsInDisplayOrder(input.schema);
  const selectedIndex = selected ? displayFields.indexOf(selected) : -1;
  const [propertiesOpen, setPropertiesOpen] = useState(
    () => formPropertiesForceOpen || selectedIndex < 0,
  );
  useEffect(() => {
    if (formPropertiesForceOpen) {
      setPropertiesOpen(true);
      return;
    }
    if (selectedIndex >= 0) setPropertiesOpen(false);
  }, [formPropertiesForceOpen, selectedIndex]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the selected field deliberately revokes the transient permission to edit its stable ID.
  useEffect(() => setAllowIdChange(false), [selectedIndex]);
  const idReferenced = selected
    ? input.schema.fields.some(
        (field) => field.condition?.fieldId === selected.id,
      )
    : false;
  const idProtected = Boolean(input.id || idReferenced);
  const duplicateOptions = selected
    ? selected.options.filter(
        (option, index, options) =>
          options.findIndex(
            (candidate) =>
              candidate.trim().toLocaleLowerCase() ===
              option.trim().toLocaleLowerCase(),
          ) !== index,
      )
    : [];
  return (
    <section
      className="fb-dock-panel fb-inspector"
      hidden={hidden}
      id="form-builder-field-settings"
      tabIndex={-1}
    >
      <div className="fb-pane-head">
        {/* The outline row already names the selected field's type, so the pane
            title carries no pill: at dock width it wrapped the switch onto a
            second row and pushed this pane's content below its neighbours. */}
        <div className="fb-inspector-heading">
          <h2>Field settings</h2>
          {selected ? (
            <span className="fb-inspector-kind">
              {formFieldTypeLabel(selected.type)}
            </span>
          ) : null}
        </div>
        {paneSwitch ? <span className="right">{paneSwitch}</span> : null}
      </div>
      <div className="fb-pane-body fb-inspector-body">
        {formProperties ? (
          <details
            className="fb-disclosure"
            open={propertiesOpen || formPropertiesForceOpen}
            onToggle={(event) => {
              if (formPropertiesForceOpen) {
                setPropertiesOpen(true);
                return;
              }
              setPropertiesOpen(event.currentTarget.open);
            }}
          >
            <summary>
              <span>
                <strong>Form properties</strong>
                <small>Name, public URL, access, landing page</small>
              </span>
            </summary>
            <div className="fb-disclosure-fields">{formProperties}</div>
          </details>
        ) : null}
        {selected ? (
          <>
            <label className="fb-prop-row">
              <span>Required when visible</span>
              <input
                type="checkbox"
                checked={selected.required}
                onChange={(event) =>
                  patchField({ required: event.target.checked })
                }
              />
            </label>
            <div className="fb-inspector-cluster">
              <label className="label">
                Label
                <input
                  className="field"
                  value={selected.label}
                  onChange={(event) =>
                    patchField({ label: event.target.value })
                  }
                />
              </label>
              <label className="label mt">
                Section
                <select
                  className="select"
                  aria-label="Field section"
                  value={selected.sectionId}
                  onChange={(event) =>
                    patchField({ sectionId: event.target.value })
                  }
                >
                  {input.schema.sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fb-inspector-cluster">
              <h3 className="fb-cluster-label">Prompt</h3>
              <label className="label">
                Help text
                <textarea
                  className="textarea"
                  rows={2}
                  value={selected.help}
                  onChange={(event) => patchField({ help: event.target.value })}
                />
                <span className="help">
                  Explain why the organiser asks for this information.
                </span>
              </label>
              <label className="label mt">
                Example answer
                <textarea
                  className="textarea"
                  rows={2}
                  value={selected.example}
                  onChange={(event) =>
                    patchField({ example: event.target.value })
                  }
                  placeholder="A concrete answer that shows the expected level of detail"
                />
                <span className="help">
                  Applicants see this as a prompt; it is never submitted as an
                  answer.
                </span>
              </label>
              {(selected.type === "select" ||
                selected.type === "multi_select") &&
              !["category", "format"].includes(selected.id) ? (
                <label className="label mt">
                  Options, one per line
                  <textarea
                    className="textarea"
                    rows={3}
                    value={selected.options.join("\n")}
                    onChange={(event) =>
                      patchField({
                        options: event.target.value.split("\n"),
                      })
                    }
                    onBlur={() =>
                      patchField({
                        options: selected.options
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  {duplicateOptions.length ? (
                    <span className="field-error" role="alert">
                      Remove duplicate option “{duplicateOptions[0]}”.
                    </span>
                  ) : null}
                </label>
              ) : selected.id === "category" || selected.id === "format" ? (
                <fieldset className="stack mt">
                  <legend className="label">
                    Current Event settings{" "}
                    {selected.id === "category" ? "tracks" : "formats"}
                  </legend>
                  <p className="help">
                    These protected choices follow Event settings and are
                    captured in each published form version. Change them in{" "}
                    <Link to="/admin/event">Event settings</Link>.
                  </p>
                  <ul className="help">
                    {selected.options.map((option) => (
                      <li key={option}>{option}</li>
                    ))}
                  </ul>
                  {!selected.options.length ? (
                    <p className="help">
                      Configure at least one choice in Event settings.
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
            </div>

            <div className="fb-inspector-cluster">
              <h3 className="fb-cluster-label">Reviewer visibility</h3>
              <label className="label">
                Ordinary review
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
                  Identity, biography and contact fields should stay hidden.
                </span>
              </label>
              <label className="label mt">
                Blinded review
                <select
                  className="select"
                  value={selected.blindReviewVisibility ?? "identity"}
                  onChange={(event) =>
                    patchField({
                      blindReviewVisibility: event.target
                        .value as FormField["blindReviewVisibility"],
                    })
                  }
                >
                  <option value="content">
                    Show safe content to reviewers
                  </option>
                  <option value="identity">
                    Hide field when review is blind
                  </option>
                </select>
                <span className="help">
                  Identity, employer, profile and contact fields stay hidden
                  here even when ordinary reviewer visibility is enabled.
                </span>
              </label>
            </div>

            <div className="fb-inspector-cluster">
              <h3 className="fb-cluster-label">Conditional logic</h3>
              <label className="label">
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
                  {displayFields
                    .slice(0, selectedIndex)
                    .filter(
                      (field) =>
                        field.type === "select" ||
                        field.type === "multi_select",
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
                          ...requireValue(
                            selected.condition,
                            "Required selected.condition is unavailable.",
                          ),
                          equals: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="">Choose…</option>
                    {displayFields
                      .find((field) => field.id === selected.condition?.fieldId)
                      ?.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                  </select>
                </label>
              ) : null}
              {!["title", "category", "format"].includes(selected.id) ? (
                <div className="row-actions mt">
                  <Button
                    variant="danger"
                    size="small"
                    type="button"
                    onClick={() => {
                      const fields = input.schema.fields
                        .filter((field) => field.id !== selected.id)
                        .map((field) =>
                          field.condition?.fieldId === selected.id
                            ? { ...field, condition: null }
                            : field,
                        );
                      const schema = { ...input.schema, fields };
                      change({ ...input, schema });
                      setSelectedId(
                        formFieldsInDisplayOrder(schema)[0]?.id ?? "",
                      );
                    }}
                  >
                    Remove field
                  </Button>
                </div>
              ) : null}
            </div>
            <details className="pc-disclosure">
              <summary>
                <strong>Advanced identity</strong>
                <span className="help">Stable field ID: {selected.id}</span>
              </summary>
              <div className="stack mt">
                {idProtected ? (
                  <div className="validation-item warn">
                    <strong>References may be affected</strong>
                    <span>
                      This field belongs to a saved form or is used by
                      conditional logic. Program Cue will update in-form
                      conditions, but external exports may still use the current
                      ID.
                    </span>
                  </div>
                ) : null}
                {idProtected ? (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={allowIdChange}
                      onChange={(event) =>
                        setAllowIdChange(event.currentTarget.checked)
                      }
                    />{" "}
                    Allow this stable ID to change
                  </label>
                ) : null}
                <label className="label">
                  Stable field ID
                  <input
                    className="field"
                    value={selected.id}
                    disabled={idProtected && !allowIdChange}
                    pattern="[a-z][a-z0-9_]{1,39}"
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
              </div>
            </details>
          </>
        ) : (
          <p className="subtle">Select a field to configure it.</p>
        )}

        <div className="fb-inspector-cluster">
          <h3 className="fb-cluster-label">Track routing</h3>
          {/* Offering four dead selects and then admitting underneath that they
            cannot work reads as a broken control. Ask for the missing thing
            instead. */}
          {routingTeams.length ? (
            <div className="fb-route-table">
              {categoryField?.options.map((category) => (
                <label className="fb-route-row" key={category}>
                  <span>{category}</span>
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
                          trackIds: input.routing.trackIds,
                          trackNames: input.routing.trackNames,
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
            </div>
          ) : (
            <p className="help">
              Automatic routing needs an evaluation team.{" "}
              <Link to="/admin/review">Create one in Review</Link>.
            </p>
          )}
          {!routingTracks.length ? (
            <p className="help mt">
              Configure at least one event track before publishing this form.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

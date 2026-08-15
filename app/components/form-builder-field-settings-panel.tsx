import type { ReactNode } from "react";
import { Link } from "react-router";

import type {
  FormField,
  SaveFormInput,
} from "~/modules/submissions/submission-schema";

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
}) {
  return (
    <section className="fb-dock-panel fb-inspector" hidden={hidden}>
      <div className="fb-pane-head">
        {/* The outline row already names the selected field's type, so the pane
            title carries no pill: at dock width it wrapped the switch onto a
            second row and pushed this pane's content below its neighbours. */}
        <h2>Field settings</h2>
        {paneSwitch ? <span className="right">{paneSwitch}</span> : null}
      </div>
      <div className="fb-pane-body fb-inspector-body">
        {selected ? (
          <>
            <label className="label">
              Label
              <input
                className="field"
                value={selected.label}
                onChange={(event) => patchField({ label: event.target.value })}
              />
            </label>
            <label className="label mt">
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
            {(selected.type === "select" || selected.type === "multi_select") &&
            !["category", "format"].includes(selected.id) ? (
              <label className="label mt">
                Options, one per line
                <textarea
                  className="textarea"
                  rows={3}
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
            ) : selected.id === "category" || selected.id === "format" ? (
              <fieldset className="stack mt">
                <legend className="label">
                  Current Event Setup{" "}
                  {selected.id === "category" ? "tracks" : "formats"}
                </legend>
                <p className="help">
                  These protected choices follow Event Setup and are captured in
                  each published form version. Change them in{" "}
                  <Link to="/admin/event">Event Setup</Link>.
                </p>
                <ul className="help">
                  {selected.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
                {!selected.options.length ? (
                  <p className="help">
                    Configure at least one choice in Event Setup.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
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

            <h3 className="fb-subhead">Reviewer visibility</h3>
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
                <option value="content">Show safe content to reviewers</option>
                <option value="identity">
                  Hide field when review is blind
                </option>
              </select>
              <span className="help">
                Identity, employer, profile and contact fields stay hidden here
                even when ordinary reviewer visibility is enabled.
              </span>
            </label>

            <h3 className="fb-subhead">Conditional logic</h3>
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
            {!["title", "category", "format"].includes(selected.id) ? (
              <div className="row-actions mt">
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
                  Remove field
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="subtle">Select a field to configure it.</p>
        )}

        <h3 className="fb-subhead">Track routing</h3>
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
    </section>
  );
}

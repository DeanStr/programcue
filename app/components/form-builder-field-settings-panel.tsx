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
  moveField,
  setSelectedId,
  routingTeams,
  routingTracks,
}: {
  input: SaveFormInput;
  selected: FormField | undefined;
  categoryField: FormField | undefined;
  change: (next: SaveFormInput) => void;
  patchField: (patch: Partial<FormField>) => void;
  moveField: (direction: -1 | 1) => void;
  setSelectedId: (fieldId: string) => void;
  routingTeams: Array<{ id: string; name: string }>;
  routingTracks: Array<{ id: string; name: string }>;
}) {
  const selectedTrackNames = new Set(categoryField?.options ?? []);
  function updateTrackChoices(trackId: string, selected: boolean) {
    const nextTracks = routingTracks.filter((track) =>
      track.id === trackId ? selected : selectedTrackNames.has(track.name),
    );
    const nextTrackNames = new Set(nextTracks.map((track) => track.name));
    change({
      ...input,
      schema: {
        ...input.schema,
        fields: input.schema.fields.map((field) =>
          field.id === "category"
            ? { ...field, options: nextTracks.map((track) => track.name) }
            : field,
        ),
      },
      routing: {
        ...input.routing,
        categories: Object.fromEntries(
          Object.entries(input.routing.categories).filter(([trackName]) =>
            nextTrackNames.has(trackName),
          ),
        ),
        trackIds: Object.fromEntries(
          nextTracks.map((track) => [track.name, track.id]),
        ),
        trackNames: Object.fromEntries(
          nextTracks.map((track) => [track.id, track.name]),
        ),
      },
    });
  }
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
            <span className="help">
              Explain why the organiser asks for this information.
            </span>
          </label>
          <label className="label mt">
            Example answer
            <textarea
              className="textarea"
              value={selected.example}
              onChange={(event) => patchField({ example: event.target.value })}
              placeholder="A concrete answer that shows the expected level of detail"
            />
            <span className="help">
              Applicants see this as a prompt; it is never submitted as an
              answer.
            </span>
          </label>
          {(selected.type === "select" || selected.type === "multi_select") &&
          selected.id !== "category" ? (
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
          ) : selected.id === "category" ? (
            <fieldset className="stack mt">
              <legend className="label">Available event tracks</legend>
              <p className="help">
                Track choices come from Event Setup so submissions and schedule
                records use the same track identities.
              </p>
              {routingTracks.map((track) => (
                <label className="toggle" key={track.id}>
                  <input
                    type="checkbox"
                    checked={selectedTrackNames.has(track.name)}
                    onChange={(event) =>
                      updateTrackChoices(track.id, event.target.checked)
                    }
                  />{" "}
                  {track.name}
                </label>
              ))}
              {!routingTracks.length ? (
                <p className="help">
                  Configure at least one event track in Event Setup.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <label className="label mt">
            Reviewer visibility
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
              Controls whether reviewers can use this answer in an ordinary
              review. Identity, biography and contact fields should remain
              hidden.
            </span>
          </label>
          <label className="label mt">
            Blinded-review visibility
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
              <option value="identity">Hide field when review is blind</option>
            </select>
            <span className="help">
              Only explicitly classified content is returned during blind
              review. Identity, employer, profile and contact fields stay
              hidden even if their normal reviewer visibility is enabled.
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
      <h3>Track routing</h3>
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
      {!routingTeams.length ? (
        <p className="help mt">
          Create an active evaluation team before configuring automatic category
          routing.
        </p>
      ) : null}
      {!routingTracks.length ? (
        <p className="help mt">
          Configure at least one event track before publishing this form.
        </p>
      ) : null}
    </section>
  );
}

import type {
  FormField,
  SaveFormInput,
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
    example: "",
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

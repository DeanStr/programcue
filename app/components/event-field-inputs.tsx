type FieldValue = {
  id: string;
  label: string;
  fieldType:
    | "short_text"
    | "long_text"
    | "number"
    | "boolean"
    | "date"
    | "single_choice"
    | "multiple_choice";
  options: string[];
  participantAccess: "hidden" | "read_only" | "editable";
  required: boolean;
  valueRevision: number;
  value: string | number | boolean | string[] | null;
};

function displayFieldValue(value: FieldValue["value"]) {
  if (
    value === null ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  ) {
    return "Not provided";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function EventFieldReadOnlyValues({
  fields,
}: {
  fields: readonly FieldValue[];
}) {
  return (
    <dl className="speaker-session-meta">
      {fields.map((field) => (
        <div key={field.id}>
          <dt>{field.label}</dt>
          <dd>{displayFieldValue(field.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EventFieldInputs({
  fields,
  participant = false,
}: {
  fields: readonly FieldValue[];
  participant?: boolean;
}) {
  return fields.map((field) => {
    const name = `field:${field.id}`;
    const disabled = participant && field.participantAccess !== "editable";
    const revisionInput = (
      <input
        type="hidden"
        name={`fieldRevision:${field.id}`}
        value={field.valueRevision}
      />
    );
    const label = (
      <span className="pc-field-label">
        <span>{field.label}</span>
        {field.required ? (
          <span className="pc-required" aria-hidden="true">
            Required
          </span>
        ) : null}
      </span>
    );
    if (field.fieldType === "boolean") {
      return (
        <label className="label" key={field.id}>
          {revisionInput}
          {label}
          <select
            className="select"
            name={name}
            defaultValue={field.value === null ? "" : String(field.value)}
            required={field.required && !disabled}
            disabled={disabled}
          >
            <option value="">Not provided</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
          {disabled ? <span className="help">Set by organiser</span> : null}
        </label>
      );
    }
    if (field.fieldType === "long_text") {
      return (
        <label className="label" key={field.id}>
          {revisionInput}
          {label}
          <textarea
            className="textarea"
            name={name}
            defaultValue={typeof field.value === "string" ? field.value : ""}
            required={field.required && !disabled}
            disabled={disabled}
            rows={4}
          />
        </label>
      );
    }
    if (field.fieldType === "single_choice") {
      return (
        <label className="label" key={field.id}>
          {revisionInput}
          {label}
          <select
            className="select"
            name={name}
            defaultValue={typeof field.value === "string" ? field.value : ""}
            required={field.required && !disabled}
            disabled={disabled}
          >
            <option value="">Select…</option>
            {field.options.map((option) => (
              <option value={option} key={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }
    if (field.fieldType === "multiple_choice") {
      const selected = new Set(Array.isArray(field.value) ? field.value : []);
      return (
        <fieldset className="stack" key={field.id}>
          <legend>{label}</legend>
          {revisionInput}
          {field.options.map((option) => (
            <label className="toggle" key={option}>
              <input
                type="checkbox"
                name={name}
                value={option}
                defaultChecked={selected.has(option)}
                disabled={disabled}
              />{" "}
              {option}
            </label>
          ))}
        </fieldset>
      );
    }
    return (
      <label className="label" key={field.id}>
        {revisionInput}
        {label}
        <input
          className="field"
          name={name}
          type={
            field.fieldType === "number"
              ? "number"
              : field.fieldType === "date"
                ? "date"
                : "text"
          }
          step={field.fieldType === "number" ? "any" : undefined}
          defaultValue={
            typeof field.value === "string" || typeof field.value === "number"
              ? field.value
              : ""
          }
          required={field.required && !disabled}
          disabled={disabled}
        />
      </label>
    );
  });
}

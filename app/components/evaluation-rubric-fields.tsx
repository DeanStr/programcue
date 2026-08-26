import { useId, useState } from "react";

function duplicateBuiltInFieldWarning(name: string) {
  const normalizedName = name.trim().toLowerCase();
  if (normalizedName === "recommendation") {
    return "Every review already requires an overall recommendation. Rename this criterion to avoid asking reviewers twice.";
  }
  if (normalizedName === "confidence") {
    return "Every review already requires a confidence rating. Rename this criterion to avoid asking reviewers twice.";
  }
  return null;
}

function CriterionNameField({
  index,
  defaultValue,
}: {
  index: number;
  defaultValue: string;
}) {
  const [name, setName] = useState(defaultValue);
  const warning = duplicateBuiltInFieldWarning(name);
  const warningId = useId();

  return (
    <div className="stack">
      <label className="label">
        Criterion {index + 1}
        <input
          className="field"
          name="criterionName"
          defaultValue={defaultValue}
          onChange={(event) => setName(event.target.value)}
          aria-describedby={warning ? warningId : undefined}
        />
      </label>
      {warning ? (
        <div className="validation-item warn mt" id={warningId} role="status">
          <strong>Built-in review field</strong>
          <span>{warning}</span>
        </div>
      ) : null}
    </div>
  );
}

export function RubricFields({
  criteria,
}: {
  criteria: ReadonlyArray<{
    id?: string;
    name: string;
    description: string | null;
    inputType: string;
    options?: ReadonlyArray<string>;
    weightPercent: number;
    required: boolean;
  }>;
}) {
  const rows = [
    ...criteria,
    {
      name: "",
      description: "",
      inputType: "free_text",
      weightPercent: 0,
      required: false,
      options: [],
    },
  ];
  return (
    <fieldset className="stack pc-plain-fieldset">
      <legend className="label">Rubric criteria</legend>
      <p className="help">
        Every review already includes a required overall recommendation and
        confidence rating; do not recreate them as rubric criteria. Scored 1–5
        and 1–10 criteria must total 100%. Yes/no, dropdown and free-text
        criteria are contextual and must have zero weight. Every scored
        criterion is required; contextual criteria may be optional. Dropdown
        options are saved in the order entered, separated by commas. Leave the
        final row blank unless another criterion is needed. Clear an existing
        criterion name to remove that criterion when you save.
      </p>
      {rows.map((criterion, index) => (
        <div className="card pad" key={criterion.id ?? `new-${index}`}>
          <input type="hidden" name="criterionId" value={criterion.id ?? ""} />
          <div className="grid grid-3">
            <CriterionNameField index={index} defaultValue={criterion.name} />
            <label className="label">
              Response type
              <select
                className="select"
                name="criterionInputType"
                defaultValue={criterion.inputType}
              >
                <option value="scale_5">Score 1–5</option>
                <option value="scale_10">Score 1–10</option>
                <option value="yes_no">Yes / no</option>
                <option value="dropdown">Dropdown</option>
                <option value="free_text">Free text</option>
              </select>
            </label>
            <label className="label">
              Weight percent
              <input
                className="field"
                name="criterionWeight"
                type="number"
                min="0"
                max="100"
                defaultValue={criterion.weightPercent}
                required
              />
            </label>
          </div>
          <label className="label mt">
            Reviewer guidance
            <input
              className="field"
              name="criterionDescription"
              defaultValue={criterion.description ?? ""}
            />
          </label>
          <label className="label mt">
            Dropdown options
            <input
              className="field"
              name="criterionOptions"
              defaultValue={criterion.options?.join(", ") ?? ""}
              placeholder="Introductory, Intermediate, Advanced"
            />
          </label>
          <label className="label mt">
            Requirement
            <select
              className="select"
              name="criterionRequired"
              defaultValue={criterion.required ? "true" : "false"}
            >
              <option value="true">Required</option>
              <option value="false">Optional</option>
            </select>
          </label>
        </div>
      ))}
    </fieldset>
  );
}

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
        Scored 1–5 and 1–10 criteria must total 100%. Yes/no, dropdown and
        free-text criteria are contextual and must have zero weight. Every
        scored criterion is required; contextual criteria may be optional.
        Dropdown options are saved in the order entered, separated by commas.
        Leave the final row blank unless another criterion is needed. Clear an
        existing criterion name to remove that criterion when you save.
      </p>
      {rows.map((criterion, index) => (
        <div className="card pad" key={criterion.id ?? `new-${index}`}>
          <input type="hidden" name="criterionId" value={criterion.id ?? ""} />
          <div className="grid grid-3">
            <label className="label">
              Criterion {index + 1}
              <input
                className="input"
                name="criterionName"
                defaultValue={criterion.name}
              />
            </label>
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
                className="input"
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
              className="input"
              name="criterionDescription"
              defaultValue={criterion.description ?? ""}
            />
          </label>
          <label className="label mt">
            Dropdown options
            <input
              className="input"
              name="criterionOptions"
              defaultValue={criterion.options?.join(", ") ?? ""}
              placeholder="Accept, Maybe, Reject"
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

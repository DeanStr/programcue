import { useEffect, useState } from "react";
import {
  heroImagePathSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleFields,
  type FormField,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";

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
        placeholder={field.example || undefined}
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
      placeholder={field.example || undefined}
      maxLength={field.id === "title" ? 180 : 5_000}
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
    />
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
  const parsedHeroImagePath = heroImagePathSchema.safeParse(
    input.schema.presentation.heroImagePath,
  );
  const heroImagePath = parsedHeroImagePath.success
    ? parsedHeroImagePath.data
    : "";
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
            background: heroImagePath
              ? `linear-gradient(100deg,rgba(10,18,48,.94),rgba(10,18,48,.3)),url(${heroImagePath}) center/cover`
              : `linear-gradient(135deg,#111b3f,${brandAccent ?? "#4f46e5"})`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="brand-mark small">P</span>
            <strong>Program Cue</strong>
          </div>
          <h3>{input.name}</h3>
          <small>{eventName ?? "Your event"}</small>
          <small>
            {input.schema.fields.length} questions · about{" "}
            {input.schema.presentation.estimatedMinutes} minutes
          </small>
          {input.schema.presentation.organizerName ? (
            <small>
              Organised by {input.schema.presentation.organizerName}
            </small>
          ) : null}
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

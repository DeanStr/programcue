import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApplicantFormStepNav,
  ApplicantFormStepStatus,
} from "~/components/applicant-form-step-chrome";
import { BrandMark } from "~/components/brand-mark";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import {
  APPLICANT_SPEAKERS_STEP_ID,
  applicantFormStepIdForErrors,
  deriveInitialApplicantFormStepId,
  formApplicantSteps,
  formLayout,
  formSectionsForDisplay,
  heroImagePathSchema,
  resolveApplicantFormStepId,
  type SaveFormInput,
  type StoredFormField,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleFields,
} from "~/modules/submissions/submission-schema";

const PREVIEW_WIDTHS = { mobile: 390, desktop: 960 } as const;

/**
 * An event accent is customer-chosen and carries no contrast guarantee against
 * the white hero text, so the ground is the accent's derived ink rather than
 * the accent itself. An unusable value falls through to the token default.
 */
function heroGround(brandAccent: string | undefined) {
  if (!brandAccent) return undefined;
  try {
    return programmeAccentPalette(brandAccent).ink;
  } catch {
    return undefined;
  }
}

function FieldPreview({
  field,
  value,
  onChange,
}: {
  field: StoredFormField;
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

export function ApplicantPreviewPanel({
  input,
  brandAccent,
  eventName,
  paneSwitch,
  hidden,
  onClose,
}: {
  input: SaveFormInput;
  brandAccent?: string;
  eventName?: string;
  paneSwitch?: ReactNode;
  hidden?: boolean;
  onClose?: () => void;
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
  const stepped = formLayout(input.schema) === "steps";
  const [currentStepId, setCurrentStepId] = useState(() =>
    deriveInitialApplicantFormStepId({
      schema: input.schema,
      answers: {},
    }),
  );
  const ignoreStepResolution = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Form identity and schema changes intentionally reset this interactive preview, including when the minimum speaker count is unchanged.
  useEffect(() => {
    ignoreStepResolution.current = true;
    setAnswers({});
    setSpeakerCount(input.minSpeakers);
    setErrors({});
    setValidated(false);
    setCurrentStepId(
      deriveInitialApplicantFormStepId({
        schema: input.schema,
        answers: {},
      }),
    );
  }, [input.id, input.schema, input.minSpeakers]);
  const previewFields = visibleFields(input.schema, answers);
  const previewSections = formSectionsForDisplay(input.schema, previewFields);
  const steps = formApplicantSteps(input.schema, answers);
  const resolvedStepId = stepped
    ? resolveApplicantFormStepId(input.schema, answers, currentStepId)
    : currentStepId;
  useEffect(() => {
    if (ignoreStepResolution.current) {
      ignoreStepResolution.current = false;
      return;
    }
    if (!stepped) return;
    if (resolvedStepId !== currentStepId) setCurrentStepId(resolvedStepId);
  }, [currentStepId, resolvedStepId, stepped]);
  const visiblePreviewSections = stepped
    ? previewSections.filter((section) => section.id === resolvedStepId)
    : previewSections;
  const showSpeakers =
    !stepped || resolvedStepId === APPLICANT_SPEAKERS_STEP_ID;

  function updateAnswer(fieldId: string, value: string | string[]) {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
    setErrors({});
    setValidated(false);
  }

  function previewSpeakers() {
    return Array.from({ length: speakerCount }, (_, index) => ({
      name: `Test speaker ${index + 1}`,
      email: `test-speaker-${index + 1}@example.invalid`,
    }));
  }

  function validatePreview() {
    const nextErrors = {
      ...validateAnswerShapes(input.schema, answers),
      ...validateFinalAnswers(
        input.schema,
        answers,
        previewSpeakers(),
        input.minSpeakers,
        input.maxSpeakers,
      ),
    };
    setErrors(nextErrors);
    setValidated(true);
    if (!stepped) return;
    const errorStepId = applicantFormStepIdForErrors(input.schema, nextErrors);
    if (errorStepId) {
      setCurrentStepId(
        resolveApplicantFormStepId(input.schema, answers, errorStepId),
      );
    }
  }

  function continuePreview() {
    const current = steps.find((step) => step.id === resolvedStepId);
    if (current?.kind === "section") {
      const fieldIds = new Set(
        previewSections
          .find((section) => section.id === current.id)
          ?.fields.map((field) => field.id),
      );
      const sectionErrors = Object.fromEntries(
        Object.entries({
          ...validateAnswerShapes(input.schema, answers),
          ...validateFinalAnswers(
            input.schema,
            answers,
            previewSpeakers(),
            input.minSpeakers,
            input.maxSpeakers,
          ),
        }).filter(([fieldId]) => fieldIds.has(fieldId)),
      );
      if (Object.keys(sectionErrors).length) {
        setErrors(sectionErrors);
        setValidated(true);
        return;
      }
    }
    const index = steps.findIndex((step) => step.id === resolvedStepId);
    const next = steps[index + 1];
    if (!next) return;
    setErrors({});
    setValidated(false);
    setCurrentStepId(next.id);
  }

  function backPreview() {
    const index = steps.findIndex((step) => step.id === resolvedStepId);
    const previous = steps[index - 1];
    if (!previous) return;
    setErrors({});
    setValidated(false);
    setCurrentStepId(previous.id);
  }

  const ground = heroGround(brandAccent);
  const headStyle: CSSProperties = {
    ...(ground ? { backgroundColor: ground } : {}),
    ...(heroImagePath
      ? {
          // Density follows the text: the scrim is darkest at the foot, where
          // the meta lines sit. The old 100deg version faded to 30% opacity
          // exactly under the wrapped second line.
          backgroundImage: `linear-gradient(180deg,rgba(10,18,48,.35),rgba(10,18,48,.92)),url(${heroImagePath})`,
        }
      : {}),
  };

  return (
    <section className="fb-dock-panel fb-preview" hidden={hidden}>
      <div className="fb-pane-head">
        <h2>Live applicant preview</h2>
        {paneSwitch ? <span className="right">{paneSwitch}</span> : null}
      </div>
      <div className="fb-pane-body">
        <p className="fb-preview-note">
          Isolated test mode. Conditional fields and validation run here without
          creating applicant or submission records.
        </p>
        <div className="fb-preview-shell">
          <div className="fb-preview-chrome">
            <span className="pc-num">{PREVIEW_WIDTHS[viewport]} px wide</span>
            <fieldset
              className="preview-viewport-controls right pc-plain-fieldset"
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
            </fieldset>
            {onClose ? (
              <button
                className="btn small fb-preview-close"
                type="button"
                onClick={onClose}
              >
                Close preview
              </button>
            ) : null}
          </div>
          <div className="fb-preview-scroll">
            <div className={`fb-preview-page is-${viewport}`}>
              <div className="fb-preview-head" style={headStyle}>
                <span className="fb-preview-brand">
                  <BrandMark size="small" />
                  Program Cue
                </span>
                <h3>{input.name}</h3>
                <span className="fb-preview-meta">
                  {eventName ?? "Your event"}
                </span>
                <span className="fb-preview-meta">
                  {input.schema.fields.length} questions · about{" "}
                  {input.schema.presentation.estimatedMinutes} minutes
                </span>
                {input.schema.presentation.organizerName ? (
                  <span className="fb-preview-meta">
                    Organised by {input.schema.presentation.organizerName}
                  </span>
                ) : null}
              </div>
              <div className="fb-preview-body">
                <p className="tiny subtle">{input.schema.introduction}</p>
                {stepped ? (
                  <ApplicantFormStepStatus
                    steps={steps}
                    currentStepId={resolvedStepId}
                  />
                ) : null}
                {visiblePreviewSections.map((section) => (
                  <section
                    className="application-form-section stack"
                    aria-labelledby={
                      section.title
                        ? `preview-section-${section.id}`
                        : undefined
                    }
                    key={section.id}
                  >
                    {section.title ? (
                      <header>
                        <h4 id={`preview-section-${section.id}`}>
                          {section.title}
                        </h4>
                        {section.description ? (
                          <p className="subtle">{section.description}</p>
                        ) : null}
                      </header>
                    ) : null}
                    {section.fields.map((field) =>
                      field.type === "multi_select" ? (
                        <fieldset
                          className="application-choice-field"
                          key={field.id}
                        >
                          <legend className="label">
                            {field.label}
                            {field.required ? " *" : ""}
                          </legend>
                          {field.help ? (
                            <span className="help">{field.help}</span>
                          ) : null}
                          {field.example ? (
                            <span className="help">
                              Example: {field.example}
                            </span>
                          ) : null}
                          <FieldPreview
                            field={field}
                            value={answers[field.id]}
                            onChange={(value) => updateAnswer(field.id, value)}
                          />
                          {errors[field.id]?.[0] ? (
                            <span className="field-error">
                              {errors[field.id][0]}
                            </span>
                          ) : null}
                        </fieldset>
                      ) : (
                        // biome-ignore lint/a11y/noLabelWithoutControl: FieldPreview renders the wrapped input, select, or textarea.
                        <label className="label" key={field.id}>
                          {field.label}
                          {field.required ? " *" : ""}
                          {field.help ? (
                            <span className="help">{field.help}</span>
                          ) : null}
                          {field.example ? (
                            <span className="help">
                              Example: {field.example}
                            </span>
                          ) : null}
                          <FieldPreview
                            field={field}
                            value={answers[field.id]}
                            onChange={(value) => updateAnswer(field.id, value)}
                          />
                          {errors[field.id]?.[0] ? (
                            <span className="field-error">
                              {errors[field.id][0]}
                            </span>
                          ) : null}
                        </label>
                      ),
                    )}
                  </section>
                ))}
                {showSpeakers ? (
                  <section
                    className="application-form-section stack"
                    aria-labelledby="preview-section-speakers"
                  >
                    <header>
                      <h4 id="preview-section-speakers">Speakers</h4>
                    </header>
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
                        <span className="field-error">
                          {errors.speakers[0]}
                        </span>
                      ) : null}
                    </label>
                  </section>
                ) : null}
                {stepped ? (
                  <ApplicantFormStepNav
                    steps={steps}
                    currentStepId={resolvedStepId}
                    onBack={backPreview}
                    onContinue={continuePreview}
                    showContinue={resolvedStepId !== APPLICANT_SPEAKERS_STEP_ID}
                  />
                ) : null}
                {showSpeakers ? (
                  <>
                    {validated ? (
                      <div
                        className={`validation-item ${Object.keys(errors).length ? "error" : "ok"}`}
                        role={Object.keys(errors).length ? "alert" : "status"}
                      >
                        <strong>
                          {Object.keys(errors).length ? "△" : "✓"}
                        </strong>
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
                      Test values stay in this preview. No applicant or
                      submission record is saved.
                    </small>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

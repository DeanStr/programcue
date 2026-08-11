import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, useNavigation } from "react-router";

import {
  ApplicantVideoUpload,
  type ApplicantVideoUploadRecord,
} from "~/components/applicant-video-upload";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import type { ApplicantDraft } from "~/modules/submissions/submission-repository.server";
import {
  visibleFields,
  type FormField,
} from "~/modules/submissions/submission-schema";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

function FieldControl({
  field,
  value,
  onChange,
  disabled,
  invalid = false,
  describedBy,
  required = field.required,
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange(value: string | string[]): void;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
}) {
  const common = {
    id: `answer-${field.id}`,
    name: `answer-${field.id}`,
    disabled,
    required,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  if (field.type === "long_text")
    return (
      <textarea
        {...common}
        className="textarea"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        maxLength={5_000}
      />
    );
  if (field.type === "select")
    return (
      <select
        {...common}
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
          <label key={option} className="toggle">
            <input
              type="checkbox"
              disabled={disabled}
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
      {...common}
      className="field"
      type={field.type === "url" || field.type === "video" ? "url" : "text"}
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
      maxLength={field.id === "title" ? 180 : 5_000}
    />
  );
}

export function DraftEditor({
  draft,
  schema,
  applicant,
  publicSlug,
  currentUpload,
  uploadTurnstileSiteKey,
  maximumVideoBytes,
  recoveryPersonId,
  recoveryEventId,
  serverSaved,
  conflict,
  maxSpeakers,
  errors,
  canSubmit = true,
  timezone,
}: {
  draft: ApplicantDraft;
  schema: Array<FormField>;
  applicant: { name: string; email: string; verified: boolean };
  publicSlug: string;
  currentUpload: ApplicantVideoUploadRecord | null;
  uploadTurnstileSiteKey: string | null;
  maximumVideoBytes: number;
  recoveryPersonId: string;
  recoveryEventId: string;
  serverSaved: boolean;
  conflict: boolean;
  maxSpeakers: number | null;
  errors?: Record<string, string[]>;
  canSubmit?: boolean;
  timezone: string;
}) {
  const navigation = useNavigation();
  const [answers, setAnswers] = useState(draft.answers);
  const [speakers, setSpeakers] = useState(
    draft.speakers.length
      ? draft.speakers.map(({ name, email, biography, invitationStatus }) => ({
          name,
          email,
          biography,
          invitationStatus,
        }))
      : [
          {
            name: applicant.name,
            email: applicant.email,
            biography: "",
            invitationStatus: "pending",
          },
        ],
  );
  const [uploads, setUploads] = useState<
    Record<string, { assetId: string; versionId: string }>
  >(
    currentUpload
      ? {
          [currentUpload.fieldId]: {
            assetId: currentUpload.assetId,
            versionId: currentUpload.versionId,
          },
        }
      : draft.uploads,
  );
  const [dirty, setDirty] = useState(false);
  const readOnly = draft.status !== "draft";
  const recoveryPayload = useMemo(
    () => ({ answers, speakers, uploads }),
    [answers, speakers, uploads],
  );
  const restoreDraft = useCallback(
    (payload: typeof recoveryPayload) => {
      setAnswers(payload.answers);
      setSpeakers(
        applicant.verified && payload.speakers[0]
          ? [
              { ...payload.speakers[0], email: applicant.email },
              ...payload.speakers.slice(1),
            ]
          : payload.speakers,
      );
      setUploads(payload.uploads);
      setDirty(true);
    },
    [applicant.email, applicant.verified],
  );
  const recoveryScope = useMemo(
    () => ({
      eventId: recoveryEventId,
      personId: recoveryPersonId,
      recordType: "submission",
      recordId: draft.id,
    }),
    [draft.id, recoveryEventId, recoveryPersonId],
  );
  const recovery = useDraftRecovery({
    scope: recoveryScope,
    serverRevision: draft.revision,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreDraft,
    enabled: !readOnly,
  });
  useEffect(() => {
    setAnswers(draft.answers);
    setSpeakers(
      draft.speakers.length
        ? draft.speakers.map(
            ({ name, email, biography, invitationStatus }) => ({
              name,
              email,
              biography,
              invitationStatus,
            }),
          )
        : [
            {
              name: applicant.name,
              email: applicant.email,
              biography: "",
              invitationStatus: "pending",
            },
          ],
    );
    setUploads(
      currentUpload
        ? {
            [currentUpload.fieldId]: {
              assetId: currentUpload.assetId,
              versionId: currentUpload.versionId,
            },
          }
        : draft.uploads,
    );
    setDirty(false);
  }, [draft.id, draft.revision]);
  useEffect(() => {
    if (!serverSaved && !readOnly) return;
    void clearDraftRecoveryScope(recoveryScope);
  }, [readOnly, recoveryScope, serverSaved]);
  const fields = visibleFields({ introduction: "", fields: schema }, answers);

  return (
    <Form method="post" className="stack" onChange={() => setDirty(true)}>
      <input type="hidden" name="submissionId" value={draft.id} />
      <input type="hidden" name="revision" value={draft.revision} />
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      <input type="hidden" name="speakers" value={JSON.stringify(speakers)} />
      <input type="hidden" name="uploads" value={JSON.stringify(uploads)} />
      <div className="card-title">
        <div>
          <span
            className={`status ${draft.status === "draft" ? "info" : draft.status === "withdrawn" ? "warning" : "success"}`}
          >
            {draft.status}
          </span>
          <h1 className="mt">{draft.title}</h1>
        </div>
        <span className="subtle right">Form version {draft.versionNumber}</span>
      </div>
      <DraftRecoveryFeedback recovery={recovery} className="" />
      {errors && Object.keys(errors).length ? (
        <div className="validation-item error" role="alert">
          <strong>Review required</strong>
          <span>{Object.values(errors).flat()[0]}</span>
        </div>
      ) : null}
      {fields.map((field) => {
        const error = errors?.[field.id]?.[0];
        const helpId = field.help ? `answer-${field.id}-help` : undefined;
        const errorId = error ? `answer-${field.id}-error` : undefined;
        const describedBy =
          [helpId, errorId].filter(Boolean).join(" ") || undefined;
        const update = (value: string | string[]) => {
          setAnswers((current) => ({ ...current, [field.id]: value }));
          setDirty(true);
        };
        if (field.type === "video")
          return (
            <fieldset
              className="application-choice-field"
              key={field.id}
              aria-required={field.required || undefined}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.help ? (
                <span className="help" id={helpId}>
                  {field.help}
                </span>
              ) : null}
              <label className="label" htmlFor={`answer-${field.id}`}>
                HTTPS video link
                <FieldControl
                  field={field}
                  value={answers[field.id]}
                  disabled={readOnly}
                  required={field.required && !uploads[field.id]}
                  invalid={Boolean(error)}
                  describedBy={describedBy}
                  onChange={update}
                />
              </label>
              {!readOnly ? (
                <ApplicantVideoUpload
                  publicSlug={publicSlug}
                  submissionId={draft.id}
                  fieldId={field.id}
                  current={
                    currentUpload?.fieldId === field.id ? currentUpload : null
                  }
                  siteKey={uploadTurnstileSiteKey}
                  disabled={readOnly}
                  maximumBytes={maximumVideoBytes}
                  onReferenceChange={(reference) => {
                    setUploads((current) => ({
                      ...current,
                      [field.id]: reference,
                    }));
                    setDirty(true);
                  }}
                />
              ) : uploads[field.id] ? (
                <div className="validation-item ok mt">
                  <strong>Private video attached</strong>
                  <span>
                    The immutable submission references its scanned file
                    version.
                  </span>
                </div>
              ) : null}
              {error ? (
                <span className="field-error" id={errorId}>
                  {error}
                </span>
              ) : null}
            </fieldset>
          );
        if (field.type === "multi_select")
          return (
            <fieldset
              className="application-choice-field"
              key={field.id}
              aria-required={field.required || undefined}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.help ? (
                <span className="help" id={helpId}>
                  {field.help}
                </span>
              ) : null}
              <FieldControl
                field={field}
                value={answers[field.id]}
                disabled={readOnly}
                invalid={Boolean(error)}
                describedBy={describedBy}
                onChange={update}
              />
              {error ? (
                <span className="field-error" id={errorId}>
                  {error}
                </span>
              ) : null}
            </fieldset>
          );
        return (
          <label
            className="label"
            key={field.id}
            htmlFor={`answer-${field.id}`}
          >
            {field.label}
            {field.required ? " *" : ""}
            {field.help ? (
              <span className="help" id={helpId}>
                {field.help}
              </span>
            ) : null}
            <FieldControl
              field={field}
              value={answers[field.id]}
              disabled={readOnly}
              invalid={Boolean(error)}
              describedBy={describedBy}
              onChange={update}
            />
            {error ? (
              <span className="field-error" id={errorId}>
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      <fieldset className="card pad">
        <legend>
          <strong>Speakers</strong>
        </legend>
        <p className="subtle">
          The first speaker is primary. Additional speakers receive a pending
          claim relationship and an expiring invitation after final submission.
        </p>
        {speakers.map((speaker, index) => (
          <div className="form-row mb" key={index}>
            <label className="label">
              Speaker {index + 1} name
              <input
                className="field"
                disabled={
                  readOnly ||
                  (index > 0 && speaker.invitationStatus === "claimed")
                }
                required
                value={speaker.name}
                onChange={(event) => {
                  const next = [...speakers];
                  next[index] = { ...speaker, name: event.target.value };
                  setSpeakers(next);
                  setDirty(true);
                }}
              />
            </label>
            <label className="label">
              Email
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="field"
                  type="email"
                  disabled={
                    readOnly ||
                    (index === 0 && applicant.verified) ||
                    (index > 0 && speaker.invitationStatus === "claimed")
                  }
                  required
                  value={speaker.email}
                  onChange={(event) => {
                    const next = [...speakers];
                    next[index] = { ...speaker, email: event.target.value };
                    setSpeakers(next);
                    setDirty(true);
                  }}
                />
                {index > 0 &&
                !readOnly &&
                speaker.invitationStatus !== "claimed" ? (
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove speaker ${index + 1}`}
                    onClick={() => {
                      setSpeakers(
                        speakers.filter((_, itemIndex) => itemIndex !== index),
                      );
                      setDirty(true);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </label>
            <label className="label">
              Biography
              <textarea
                className="textarea"
                disabled={
                  readOnly ||
                  (index > 0 && speaker.invitationStatus === "claimed")
                }
                maxLength={5_000}
                value={speaker.biography}
                onChange={(event) => {
                  const next = [...speakers];
                  next[index] = {
                    ...speaker,
                    biography: event.target.value,
                  };
                  setSpeakers(next);
                  setDirty(true);
                }}
              />
              {index > 0 && speaker.invitationStatus === "claimed" ? (
                <span className="help">
                  This co-speaker owns their claimed profile. They can update it
                  below.
                </span>
              ) : null}
            </label>
          </div>
        ))}
        {!readOnly &&
        (maxSpeakers === null || speakers.length < maxSpeakers) ? (
          <button
            className="btn small"
            type="button"
            onClick={() => {
              setSpeakers([
                ...speakers,
                {
                  name: "",
                  email: "",
                  biography: "",
                  invitationStatus: "pending",
                },
              ]);
              setDirty(true);
            }}
          >
            + Add co-speaker
          </button>
        ) : !readOnly && maxSpeakers !== null ? (
          <span className="help">
            This form allows at most {maxSpeakers} speaker
            {maxSpeakers === 1 ? "" : "s"}.
          </span>
        ) : null}
        {errors?.speakers ? (
          <span className="field-error">{errors.speakers[0]}</span>
        ) : null}
      </fieldset>
      {!readOnly ? (
        <>
          <div className="validation-item warn">
            <strong>Before submitting</strong>
            <span>
              Final submission freezes this form-version snapshot. You can still
              view it afterward.
            </span>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              name="confirm"
              value="yes"
              required
              disabled={!canSubmit}
            />{" "}
            I have reviewed this application and am ready to submit it.
          </label>
          <div className="page-actions">
            <span className={`status ${dirty ? "warning" : "success"}`}>
              {dirty ? "Unsaved changes" : "Loaded from D1"}
            </span>
            <DraftRecoveryStatus state={recovery.state} />
            <button
              className="btn"
              type="submit"
              name="_intent"
              value="save_draft"
              formNoValidate
              disabled={navigation.state !== "idle"}
            >
              {navigation.formData?.get("_intent") === "save_draft"
                ? "Saving…"
                : "Save draft"}
            </button>
            <button
              className="btn primary"
              type="submit"
              name="_intent"
              value="submit"
              disabled={navigation.state !== "idle" || !canSubmit}
            >
              {navigation.formData?.get("_intent") === "submit"
                ? "Submitting…"
                : "Submit application"}
            </button>
          </div>
          {conflict ? (
            <div className="validation-item error" role="alert">
              <strong>Draft conflict</strong>
              <span>
                The browser recovery copy is intact. Export it or explicitly
                load the newer server revision; nothing was overwritten.
              </span>
              <span className="row-actions right">
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    const blob = new Blob(
                      [JSON.stringify(recoveryPayload, null, 2)],
                      { type: "application/json" },
                    );
                    const href = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = href;
                    link.download = `${draft.id}-application-recovery.json`;
                    link.click();
                    URL.revokeObjectURL(href);
                  }}
                >
                  Export local edits
                </button>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard the current editor contents and load the latest server application?",
                      )
                    ) {
                      void recovery
                        .clear()
                        .then(() => window.location.reload());
                    }
                  }}
                >
                  Load server version
                </button>
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={`validation-item ${draft.status === "withdrawn" ? "warn" : "ok"}`}
          >
            <strong>
              {draft.status === "withdrawn" ? "△ Withdrawn" : "✓ Submitted"}
            </strong>
            <span>
              {draft.status === "withdrawn"
                ? "This application is no longer in the review queue. Its immutable submitted snapshot remains in the audit history."
                : `This immutable application was received ${
                    draft.submittedAt
                      ? `${new Intl.DateTimeFormat("en", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: timezone,
                        }).format(
                          new Date(draft.submittedAt * 1_000),
                        )} (${timezone})`
                      : "successfully"
                  }.`}
            </span>
          </div>
          {draft.status === "submitted" || draft.status === "assigned" ? (
            <details className="card pad">
              <summary>
                <strong>Withdraw application</strong>
              </summary>
              <p className="help mt">
                Withdrawal removes this application from the active review
                queue. The submitted snapshot and audit history are retained.
              </p>
              <label className="toggle">
                <input
                  type="checkbox"
                  name="confirmWithdrawal"
                  value="yes"
                  required
                />{" "}
                I understand this application will be withdrawn.
              </label>
              <button
                className="btn danger mt"
                type="submit"
                name="_intent"
                value="withdraw"
                disabled={navigation.state !== "idle"}
              >
                {navigation.formData?.get("_intent") === "withdraw"
                  ? "Withdrawing…"
                  : "Withdraw application"}
              </button>
            </details>
          ) : null}
        </>
      )}
    </Form>
  );
}

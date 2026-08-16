import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import {
  ApplicantVideoUpload,
  type ApplicantVideoUploadRecord,
} from "~/components/applicant-video-upload";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import { SessionizeProfileImport } from "~/components/sessionize-profile-import";
import { CharacterCount } from "~/components/ui/character-count";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ErrorSummary } from "~/components/ui/error-summary";
import type { ApplicantDraft } from "~/modules/submissions/submission-repository.server";
import {
  DEFAULT_FORM_PRESENTATION,
  type FormField,
  MAX_SUBMISSION_SPEAKERS,
  visibleFields,
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
        placeholder={field.example || undefined}
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
      placeholder={field.example || undefined}
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
  revisionIntentId,
  serverSaved,
  conflict,
  maxSpeakers,
  errors,
  canSubmit = true,
  canRevise = false,
  forceReadOnly = false,
  readOnlyNotice,
  acceptedParticipantsHref,
  action,
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
  revisionIntentId: string;
  serverSaved: boolean;
  conflict: boolean;
  maxSpeakers: number | null;
  errors?: Record<string, string[]>;
  canSubmit?: boolean;
  canRevise?: boolean;
  forceReadOnly?: boolean;
  readOnlyNotice?: string;
  acceptedParticipantsHref?: string | null;
  action?: string;
  timezone: string;
}) {
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const effectiveMaximumSpeakers = Math.min(
    maxSpeakers ?? MAX_SUBMISSION_SPEAKERS,
    MAX_SUBMISSION_SPEAKERS,
  );
  const [answers, setAnswers] = useState(draft.answers);
  const [clientValidationMessage, setClientValidationMessage] = useState<
    string | null
  >(null);
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
  const revisionMode = canRevise && draft.status === "submitted";
  const readOnly = forceReadOnly || (draft.status !== "draft" && !revisionMode);
  const originalSpeakerCount = draft.speakers.length;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new authoritative draft identity or revision may replace unsaved editor state during route revalidation.
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
  const fields = visibleFields(
    {
      introduction: "",
      presentation: DEFAULT_FORM_PRESENTATION,
      fields: schema,
    },
    answers,
  );
  const incompleteRequiredFields = fields.filter((field) => {
    if (!field.required) return false;
    if (field.type === "video" && uploads[field.id]) return false;
    const value = answers[field.id];
    return Array.isArray(value)
      ? value.length === 0
      : !String(value ?? "").trim();
  });
  const duplicateSpeakerEmails = speakers
    .map((speaker) => speaker.email.trim().toLocaleLowerCase())
    .filter((email, index, all) => email && all.indexOf(email) !== index);
  const serverSummaryErrors = Object.entries(errors ?? {}).flatMap(
    ([field, messages]) =>
      messages.map((message) => ({
        message,
        href:
          field === "speakers" ? "#application-speakers" : `#answer-${field}`,
      })),
  );
  const clientSummaryErrors = clientValidationMessage
    ? [
        clientValidationMessage,
        ...incompleteRequiredFields.map((field) => ({
          message: `${field.label} is required.`,
          href: `#answer-${field.id}`,
        })),
      ]
    : [];

  return (
    <Form
      method="post"
      action={action}
      className="stack"
      onChange={() => {
        setDirty(true);
        setClientValidationMessage(null);
      }}
      onInvalid={() => {
        setClientValidationMessage(
          "Complete the highlighted required field before submitting.",
        );
      }}
    >
      {dialog}
      <input type="hidden" name="submissionId" value={draft.id} />
      <input type="hidden" name="revision" value={draft.revision} />
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      <input type="hidden" name="speakers" value={JSON.stringify(speakers)} />
      <input type="hidden" name="uploads" value={JSON.stringify(uploads)} />
      {revisionMode ? (
        <input
          type="hidden"
          name="intentId"
          value={`${revisionIntentId}:${draft.revision}`}
        />
      ) : null}
      <div className="card-title">
        <div>
          <DomainStatusBadge domain="submission" status={draft.status} />
          <h1 className="mt">{draft.title}</h1>
        </div>
        <span className="subtle right">Form version {draft.versionNumber}</span>
      </div>
      <DraftRecoveryFeedback recovery={recovery} className="" />
      <ErrorSummary
        title="Review the application"
        errors={[...serverSummaryErrors, ...clientSummaryErrors]}
      />
      {!readOnly ? (
        <div
          className={`validation-item ${incompleteRequiredFields.length ? "info" : "ok"}`}
          role="status"
        >
          <strong>
            {incompleteRequiredFields.length
              ? `${incompleteRequiredFields.length} required ${incompleteRequiredFields.length === 1 ? "answer" : "answers"} remaining`
              : "All required answers complete"}
          </strong>
          {incompleteRequiredFields.length ? (
            <span>
              {incompleteRequiredFields.map((field, index) => (
                <span key={field.id}>
                  {index ? ", " : ""}
                  <a href={`#answer-${field.id}`}>{field.label}</a>
                </span>
              ))}
            </span>
          ) : (
            <span>
              You can still review optional answers before submitting.
            </span>
          )}
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
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? (
                  <span className="pc-required" aria-hidden="true">
                    Required
                  </span>
                ) : null}
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
                  disabled={
                    readOnly || (revisionMode && Boolean(uploads[field.id]))
                  }
                  required={field.required && !uploads[field.id]}
                  invalid={Boolean(error)}
                  describedBy={describedBy}
                  onChange={update}
                />
              </label>
              {!readOnly && !revisionMode ? (
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
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? (
                  <span className="pc-required">Required</span>
                ) : null}
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
            {field.required ? (
              <span className="pc-required" aria-hidden="true">
                Required
              </span>
            ) : null}
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
            {field.type === "long_text" ? (
              <CharacterCount
                value={String(answers[field.id] ?? "")}
                maximum={5_000}
              />
            ) : null}
            {error ? (
              <span className="field-error" id={errorId}>
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      <fieldset className="card pad" id="application-speakers">
        <legend>
          <strong>Speakers</strong>
        </legend>
        <p className="subtle">
          The first speaker is primary. Additional speakers receive a pending
          claim relationship and an expiring invitation after final submission.
        </p>
        {!readOnly && !revisionMode && applicant.verified ? (
          <SessionizeProfileImport
            publicSlug={publicSlug}
            disabled={readOnly}
            onImport={(profile) => {
              setSpeakers((current) => {
                const primary = current[0] ?? {
                  name: applicant.name,
                  email: applicant.email,
                  biography: "",
                  invitationStatus: "pending",
                };
                return [
                  {
                    ...primary,
                    name: profile.name,
                    biography: profile.biography,
                  },
                  ...current.slice(1),
                ];
              });
              setDirty(true);
            }}
          />
        ) : null}
        {speakers.map((speaker, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: These controlled rows have positional identity; deleting a co-speaker intentionally promotes each following row to the preceding position.
          <div className="form-row mb" key={index}>
            <label className="label">
              Speaker {index + 1} name
              <input
                className="field"
                autoComplete={index === 0 ? "name" : "off"}
                disabled={
                  readOnly ||
                  (revisionMode && index < originalSpeakerCount) ||
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
                  autoComplete={index === 0 ? "email" : "off"}
                  disabled={
                    readOnly ||
                    (revisionMode && index < originalSpeakerCount) ||
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
                (!revisionMode || index >= originalSpeakerCount) &&
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
                  (revisionMode && index < originalSpeakerCount) ||
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
              <CharacterCount value={speaker.biography} maximum={5_000} />
              {index > 0 && speaker.invitationStatus === "claimed" ? (
                <span className="help">
                  This co-speaker owns their claimed profile. They can update it
                  below.
                </span>
              ) : null}
            </label>
          </div>
        ))}
        {!readOnly && speakers.length < effectiveMaximumSpeakers ? (
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
        ) : !readOnly ? (
          <span className="help">
            This form allows at most {effectiveMaximumSpeakers} speaker
            {effectiveMaximumSpeakers === 1 ? "" : "s"}.
          </span>
        ) : null}
        {errors?.speakers ? (
          <span className="field-error">{errors.speakers[0]}</span>
        ) : null}
        {duplicateSpeakerEmails.length ? (
          <span className="field-error" role="alert">
            Each speaker must use a different email address.
          </span>
        ) : null}
      </fieldset>
      {!readOnly ? (
        <>
          <div className="validation-item warn">
            <strong>Before submitting</strong>
            <span>
              {revisionMode
                ? "Saving creates a new submitted revision. The prior submitted revision stays in the audit history."
                : "Final submission records an immutable form-version revision. While applications remain open and review has not started, you may submit a newer revision."}
            </span>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              name={revisionMode ? "confirmRevision" : "confirm"}
              value="yes"
              required
              disabled={revisionMode ? false : !canSubmit}
            />{" "}
            {revisionMode
              ? "I have reviewed these changes and am ready to replace the current submitted version."
              : "I have reviewed this application and am ready to submit it."}
          </label>
          <div className="page-actions">
            <span className={`status ${dirty ? "warning" : "success"}`}>
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <DraftRecoveryStatus state={recovery.state} />
            {!revisionMode ? (
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
            ) : null}
            <button
              className="btn primary"
              type="submit"
              name="_intent"
              value={revisionMode ? "revise_submission" : "submit"}
              disabled={
                navigation.state !== "idle" || (!revisionMode && !canSubmit)
              }
            >
              {navigation.formData?.get("_intent") === "revise_submission"
                ? "Saving revision…"
                : navigation.formData?.get("_intent") === "submit"
                  ? "Submitting…"
                  : revisionMode
                    ? "Save revised application"
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
                  onClick={() =>
                    confirm(
                      {
                        title: "Load the latest server application?",
                        description:
                          "The unsaved editor contents and the browser recovery copy are discarded, then this page reloads the newer server revision. Export your local edits first if you still need them.",
                        records: [draft.title],
                        confirmLabel: "Discard and reload",
                      },
                      () => {
                        void recovery
                          .clear()
                          .then(() => window.location.reload());
                      },
                    )
                  }
                >
                  Load server version
                </button>
              </span>
            </div>
          ) : null}
          {revisionMode ? (
            <details className="card pad pc-disclosure">
              <summary>
                <strong>Withdraw application</strong>
              </summary>
              <p className="help mt">
                Withdrawal removes this application from the active review
                queue. The submitted revisions and audit history are retained.
              </p>
              <label className="toggle">
                <input type="checkbox" name="confirmWithdrawal" value="yes" /> I
                understand this application will be withdrawn.
              </label>
              <button
                className="btn danger mt"
                type="submit"
                name="_intent"
                value="withdraw"
                formNoValidate
                disabled={navigation.state !== "idle"}
              >
                {navigation.formData?.get("_intent") === "withdraw"
                  ? "Withdrawing…"
                  : "Withdraw application"}
              </button>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={`validation-item ${forceReadOnly || draft.status === "withdrawn" ? "warn" : "ok"}`}
          >
            <strong>
              {forceReadOnly
                ? "Read-only application"
                : draft.status === "withdrawn"
                  ? "△ Withdrawn"
                  : "✓ Submitted"}
            </strong>
            <span>
              {forceReadOnly
                ? (readOnlyNotice ??
                  "This application is available for reference but cannot be changed here.")
                : draft.status === "withdrawn"
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
          {acceptedParticipantsHref ? (
            <div className="validation-item info">
              <strong>Accepted proposal participants</strong>
              <span>
                Add or review accepted-session speakers in the participant
                workspace without changing this submitted answer snapshot.
              </span>
              <Link className="btn small" to={acceptedParticipantsHref}>
                Manage participants
              </Link>
            </div>
          ) : null}
          {!forceReadOnly &&
          (draft.status === "submitted" || draft.status === "assigned") ? (
            <details className="card pad pc-disclosure">
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
                formNoValidate
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

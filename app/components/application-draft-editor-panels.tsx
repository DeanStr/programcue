import { type Dispatch, type Ref, type SetStateAction, useRef } from "react";
import type { useNavigation } from "react-router";

import {
  ApplicantVideoUpload,
  type ApplicantVideoUploadRecord,
  applicantVideoFieldSources,
} from "~/components/applicant-video-upload";
import { DraftRecoveryStatus } from "~/components/draft-recovery-feedback";
import { SessionizeProfileImport } from "~/components/sessionize-profile-import";
import { Button, ButtonLink, IconButton } from "~/components/ui/button";
import { CharacterCount } from "~/components/ui/character-count";
import type { useConfirm } from "~/components/ui/confirm-dialog";
import type { ApplicantDraft } from "~/modules/submissions/submission-repository.server";
import type {
  formSectionsForDisplay,
  StoredFormField,
} from "~/modules/submissions/submission-schema";
import type { useDraftRecovery } from "~/platform/drafts/draft-recovery";

export function FieldControl({
  field,
  value,
  onChange,
  disabled,
  invalid = false,
  describedBy,
  required = field.required,
}: {
  field: StoredFormField;
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

type EditableSpeaker = Pick<
  ApplicantDraft["speakers"][number],
  "name" | "email" | "biography" | "invitationStatus"
>;
type DraftAnswers = ApplicantDraft["answers"];
type DraftUploads = Record<string, { assetId: string; versionId: string }>;

type ApplicationAnswersProps = {
  sections: ReturnType<typeof formSectionsForDisplay>;
  errors?: Record<string, string[]>;
  answers: DraftAnswers;
  setAnswers: Dispatch<SetStateAction<DraftAnswers>>;
  setDirty(value: boolean): void;
  readOnly: boolean;
  revisionMode: boolean;
  uploads: DraftUploads;
  setUploads: Dispatch<SetStateAction<DraftUploads>>;
  publicSlug: string;
  draft: ApplicantDraft;
  currentUpload: ApplicantVideoUploadRecord | null;
  uploadTurnstileSiteKey: string | null;
  maximumVideoBytes: number;
  sectionHeadingRef?: Ref<HTMLHeadingElement | null>;
  onUploadTransferChange?: (blocking: boolean) => void;
  stepped?: boolean;
};

export function ApplicationAnswers({
  sections,
  errors,
  answers,
  setAnswers,
  setDirty,
  readOnly,
  revisionMode,
  uploads,
  setUploads,
  publicSlug,
  draft,
  currentUpload,
  uploadTurnstileSiteKey,
  maximumVideoBytes,
  sectionHeadingRef,
  onUploadTransferChange,
  stepped = false,
}: ApplicationAnswersProps) {
  return (
    <>
      {sections.map((section) => (
        <section
          className="application-form-section stack"
          aria-labelledby={
            section.title ? `application-section-${section.id}` : undefined
          }
          key={section.id}
        >
          {section.title ? (
            <header>
              <h2
                id={`application-section-${section.id}`}
                className={
                  stepped ? "application-form-step-heading" : undefined
                }
                tabIndex={stepped ? -1 : undefined}
                ref={sectionHeadingRef}
              >
                {section.title}
              </h2>
              {section.description ? (
                <p className="subtle">{section.description}</p>
              ) : null}
            </header>
          ) : null}
          {section.fields.map((field) => {
            const error = errors?.[field.id]?.[0];
            const helpId = field.help ? `answer-${field.id}-help` : undefined;
            const example = field.example.trim();
            const exampleId = example
              ? `answer-${field.id}-example`
              : undefined;
            const errorId = error ? `answer-${field.id}-error` : undefined;
            const describedBy =
              [helpId, exampleId, errorId].filter(Boolean).join(" ") ||
              undefined;
            const exampleHelp = example ? (
              <span className="help" id={exampleId}>
                Example: {example}
              </span>
            ) : null;
            const update = (value: string | string[]) => {
              setAnswers((current) => ({ ...current, [field.id]: value }));
              setDirty(true);
            };
            if (field.type === "video") {
              const attachedUpload = uploads[field.id];
              const videoSources = applicantVideoFieldSources({
                fieldId: field.id,
                currentUpload,
                attachedUpload,
              });
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
                  {exampleHelp}
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
                  {attachedUpload && (readOnly || revisionMode) ? (
                    <div className="validation-item ok mt">
                      <strong>Private video attached</strong>
                      <span>
                        The immutable submission references its scanned file
                        version.
                      </span>
                    </div>
                  ) : null}
                  {!readOnly && !revisionMode ? (
                    <ApplicantVideoUpload
                      publicSlug={publicSlug}
                      submissionId={draft.id}
                      fieldId={field.id}
                      current={videoSources.current}
                      attachedReference={videoSources.attachedReference}
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
                      onTransferStatusChange={onUploadTransferChange}
                    />
                  ) : null}
                  {error ? (
                    <span className="field-error" id={errorId}>
                      {error}
                    </span>
                  ) : null}
                </fieldset>
              );
            }
            if (field.type === "multi_select")
              return (
                <fieldset
                  className="application-choice-field"
                  key={field.id}
                  id={`answer-${field.id}`}
                  tabIndex={-1}
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
                  {exampleHelp}
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
                {exampleHelp}
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
        </section>
      ))}
    </>
  );
}

type ApplicationSpeakersProps = {
  speakers: EditableSpeaker[];
  setSpeakers: Dispatch<SetStateAction<EditableSpeaker[]>>;
  setDirty(value: boolean): void;
  readOnly: boolean;
  revisionMode: boolean;
  applicant: { name: string; email: string; verified: boolean };
  publicSlug: string;
  originalSpeakerCount: number;
  effectiveMaximumSpeakers: number;
  errors?: Record<string, string[]>;
  duplicateSpeakerEmails: string[];
  headingRef?: Ref<HTMLLegendElement | null>;
};

export function ApplicationSpeakers({
  speakers,
  setSpeakers,
  setDirty,
  readOnly,
  revisionMode,
  applicant,
  publicSlug,
  originalSpeakerCount,
  effectiveMaximumSpeakers,
  errors,
  duplicateSpeakerEmails,
  headingRef,
}: ApplicationSpeakersProps) {
  return (
    <fieldset className="card pad" id="application-speakers" tabIndex={-1}>
      <legend
        className={headingRef ? "application-form-step-heading" : undefined}
        tabIndex={headingRef ? -1 : undefined}
        ref={headingRef}
      >
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
                <IconButton
                  aria-label={`Remove speaker ${index + 1}`}
                  onClick={() => {
                    setSpeakers(
                      speakers.filter((_, itemIndex) => itemIndex !== index),
                    );
                    setDirty(true);
                  }}
                >
                  ×
                </IconButton>
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
        <Button
          size="small"
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
        </Button>
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
  );
}

type ApplicationLifecycleProps = {
  readOnly: boolean;
  revisionMode: boolean;
  canSubmit: boolean;
  dirty: boolean;
  recovery: ReturnType<typeof useDraftRecovery>;
  navigation: ReturnType<typeof useNavigation>;
  conflict: boolean;
  recoveryPayload: {
    answers: DraftAnswers;
    speakers: EditableSpeaker[];
    uploads: DraftUploads;
  };
  draft: ApplicantDraft;
  confirm: ReturnType<typeof useConfirm>["confirm"];
  forceReadOnly: boolean;
  readOnlyNotice?: string;
  timezone: string;
  acceptedParticipantsHref?: string | null;
  persistenceOnly?: boolean;
  transferBlocked?: boolean;
  saveDraftButtonType?: "submit" | "button";
  onSaveDraft?(): void;
};

export function ApplicationLifecycleActions({
  readOnly,
  revisionMode,
  canSubmit,
  dirty,
  recovery,
  navigation,
  conflict,
  recoveryPayload,
  draft,
  confirm,
  forceReadOnly,
  readOnlyNotice,
  timezone,
  acceptedParticipantsHref,
  persistenceOnly = false,
  transferBlocked = false,
  saveDraftButtonType = "submit",
  onSaveDraft,
}: ApplicationLifecycleProps) {
  const discardConfirmationRef = useRef<HTMLInputElement>(null);
  return (
    <>
      {!readOnly ? (
        <>
          {persistenceOnly ? null : (
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
                  key={`${draft.id}:${draft.revision}:${draft.status}:confirm`}
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
            </>
          )}
          <div className="page-actions">
            <span className={`status ${dirty ? "warning" : "success"}`}>
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <DraftRecoveryStatus state={recovery.state} />
            {!revisionMode ? (
              <Button
                type={saveDraftButtonType}
                name="_intent"
                value="save_draft"
                formNoValidate={saveDraftButtonType === "submit"}
                disabled={navigation.state !== "idle" || transferBlocked}
                onClick={
                  saveDraftButtonType === "button" ? onSaveDraft : undefined
                }
              >
                {navigation.formData?.get("_intent") === "save_draft"
                  ? "Saving…"
                  : "Save draft"}
              </Button>
            ) : null}
            {persistenceOnly ? null : (
              <Button
                variant="primary"
                type="submit"
                name="_intent"
                value={revisionMode ? "revise_submission" : "submit"}
                disabled={
                  navigation.state !== "idle" ||
                  transferBlocked ||
                  (!revisionMode && !canSubmit)
                }
              >
                {navigation.formData?.get("_intent") === "revise_submission"
                  ? "Saving revision…"
                  : navigation.formData?.get("_intent") === "submit"
                    ? "Submitting…"
                    : revisionMode
                      ? "Save revised application"
                      : "Submit application"}
              </Button>
            )}
          </div>
          {conflict ? (
            <div className="validation-item error" role="alert">
              <strong>Draft conflict</strong>
              <span>
                The browser recovery copy is intact. Export it or explicitly
                load the newer server revision; nothing was overwritten.
              </span>
              <span className="row-actions right">
                <Button
                  size="small"
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
                </Button>
                <Button
                  size="small"
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
                </Button>
              </span>
            </div>
          ) : null}
          {revisionMode && !persistenceOnly ? (
            <details className="card pad pc-disclosure">
              <summary>
                <strong>Withdraw application</strong>
              </summary>
              <p className="help mt">
                Withdrawal removes this application from the active review
                queue. The submitted revisions and audit history are retained.
              </p>
              <label className="toggle">
                <input
                  key={`${draft.id}:${draft.revision}:${draft.status}:withdraw`}
                  type="checkbox"
                  name="confirmWithdrawal"
                  value="yes"
                />{" "}
                I understand this application will be withdrawn.
              </label>
              <Button
                variant="danger"
                className="mt"
                type="submit"
                name="_intent"
                value="withdraw"
                formNoValidate
                disabled={navigation.state !== "idle"}
              >
                {navigation.formData?.get("_intent") === "withdraw"
                  ? "Withdrawing…"
                  : "Withdraw application"}
              </Button>
            </details>
          ) : null}
          {!revisionMode && !persistenceOnly ? (
            <details className="card pad pc-disclosure">
              <summary>
                <strong>Discard draft</strong>
              </summary>
              <p className="help mt">
                Permanently delete this unsubmitted application and its saved
                answers. Submitted applications use withdrawal instead.
              </p>
              <input
                ref={discardConfirmationRef}
                type="hidden"
                name="confirmDiscard"
                defaultValue="no"
              />
              <Button
                variant="danger"
                className="mt"
                type="submit"
                name="_intent"
                value="discard_draft"
                formNoValidate
                disabled={navigation.state !== "idle" || transferBlocked}
                onClick={(event) => {
                  event.preventDefault();
                  const button = event.currentTarget;
                  const form = button.form;
                  if (!form) return;
                  confirm(
                    {
                      title: "Permanently discard this draft?",
                      description:
                        "The saved answers, browser recovery copy and any private upload will be deleted. This cannot be undone.",
                      records: [draft.title],
                      confirmLabel: "Discard draft",
                    },
                    () => {
                      if (!discardConfirmationRef.current) return;
                      discardConfirmationRef.current.value = "yes";
                      form.requestSubmit(button);
                    },
                  );
                }}
              >
                {navigation.formData?.get("_intent") === "discard_draft"
                  ? "Discarding…"
                  : "Discard draft"}
              </Button>
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
              <ButtonLink size="small" to={acceptedParticipantsHref}>
                Manage participants
              </ButtonLink>
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
              <Button
                variant="danger"
                className="mt"
                type="submit"
                name="_intent"
                value="withdraw"
                formNoValidate
                disabled={navigation.state !== "idle"}
              >
                {navigation.formData?.get("_intent") === "withdraw"
                  ? "Withdrawing…"
                  : "Withdraw application"}
              </Button>
            </details>
          ) : null}
        </>
      )}
    </>
  );
}

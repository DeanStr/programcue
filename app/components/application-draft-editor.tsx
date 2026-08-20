import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, useNavigation } from "react-router";

import type { ApplicantVideoUploadRecord } from "~/components/applicant-video-upload";
import { DraftRecoveryFeedback } from "~/components/draft-recovery-feedback";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ErrorSummary } from "~/components/ui/error-summary";
import type { ApplicantDraft } from "~/modules/submissions/submission-repository.server";
import {
  formSectionsForDisplay,
  MAX_SUBMISSION_SPEAKERS,
  type StoredSubmissionFormSchema,
  visibleFields,
} from "~/modules/submissions/submission-schema";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

import {
  ApplicationAnswers,
  ApplicationLifecycleActions,
  ApplicationSpeakers,
} from "./application-draft-editor-panels";

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
  schema: StoredSubmissionFormSchema;
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
  useEffect(() => {
    const firstInvalidField = Object.keys(errors ?? {}).find(
      (fieldId) => fieldId !== "speakers",
    );
    if (!firstInvalidField) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`answer-${firstInvalidField}`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errors]);
  const fields = visibleFields(schema, answers);
  const sections = formSectionsForDisplay(schema, fields);
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
      id="submitted-application"
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
      <ApplicationAnswers
        sections={sections}
        errors={errors}
        answers={answers}
        setAnswers={setAnswers}
        setDirty={setDirty}
        readOnly={readOnly}
        revisionMode={revisionMode}
        uploads={uploads}
        setUploads={setUploads}
        publicSlug={publicSlug}
        draft={draft}
        currentUpload={currentUpload}
        uploadTurnstileSiteKey={uploadTurnstileSiteKey}
        maximumVideoBytes={maximumVideoBytes}
      />
      <ApplicationSpeakers
        speakers={speakers}
        setSpeakers={setSpeakers}
        setDirty={setDirty}
        readOnly={readOnly}
        revisionMode={revisionMode}
        applicant={applicant}
        publicSlug={publicSlug}
        originalSpeakerCount={originalSpeakerCount}
        effectiveMaximumSpeakers={effectiveMaximumSpeakers}
        errors={errors}
        duplicateSpeakerEmails={duplicateSpeakerEmails}
      />
      <ApplicationLifecycleActions
        readOnly={readOnly}
        revisionMode={revisionMode}
        canSubmit={canSubmit}
        dirty={dirty}
        recovery={recovery}
        navigation={navigation}
        conflict={conflict}
        recoveryPayload={recoveryPayload}
        draft={draft}
        confirm={confirm}
        forceReadOnly={forceReadOnly}
        readOnlyNotice={readOnlyNotice}
        timezone={timezone}
        acceptedParticipantsHref={acceptedParticipantsHref}
      />
    </Form>
  );
}

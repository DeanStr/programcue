import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Form, useNavigation, useSubmit } from "react-router";

import {
  ApplicantFormStepNav,
  ApplicantFormStepStatus,
} from "~/components/applicant-form-step-chrome";
import type { ApplicantVideoUploadRecord } from "~/components/applicant-video-upload";
import { DraftRecoveryFeedback } from "~/components/draft-recovery-feedback";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ErrorSummary } from "~/components/ui/error-summary";
import type { ApplicantDraft } from "~/modules/submissions/submission-repository.server";
import {
  APPLICANT_SPEAKERS_STEP_ID,
  applicantFormStepIdForHref,
  deriveInitialApplicantFormStepId,
  formApplicantSteps,
  formLayout,
  formSectionsForDisplay,
  incompleteRequiredVisibleFields,
  MAX_SUBMISSION_SPEAKERS,
  resolveApplicantFormStepId,
  type StoredSubmissionFormSchema,
  validateFinalAnswers,
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
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const speakersHeadingRef = useRef<HTMLLegendElement>(null);
  const focusStepHeading = useRef(false);
  const advancingStep = useRef(false);
  const ignoreNextImplicitContinue = useRef(false);
  const { confirm, dialog } = useConfirm();
  const effectiveMaximumSpeakers = Math.min(
    maxSpeakers ?? MAX_SUBMISSION_SPEAKERS,
    MAX_SUBMISSION_SPEAKERS,
  );
  const [answers, setAnswers] = useState(draft.answers);
  const [clientValidationMessage, setClientValidationMessage] = useState<
    string | null
  >(null);
  const [clientSectionErrors, setClientSectionErrors] = useState<
    Record<string, string[]>
  >({});
  const [pendingFocusHref, setPendingFocusHref] = useState<string | null>(null);
  const [videoTransferBlocked, setVideoTransferBlocked] = useState(false);
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
  const stepped = formLayout(schema) === "steps" && !readOnly;
  const requestInFlight = navigation.state !== "idle";
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
  const initialStepId = deriveInitialApplicantFormStepId({
    schema,
    answers: draft.answers,
    errors,
  });
  const [currentStepId, setCurrentStepId] = useState(initialStepId);
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
    if (stepped) return;
    const firstInvalidField = Object.keys(errors ?? {}).find(
      (fieldId) => fieldId !== "speakers",
    );
    if (!firstInvalidField) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`answer-${firstInvalidField}`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errors, stepped]);
  const errorSignature = Object.entries(errors ?? {})
    .flatMap(([field, messages]) =>
      messages.map((message) => `${field}:${message}`),
    )
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new server error signature is the only reason to move to the invalid step.
  useEffect(() => {
    if (!stepped || !errors || Object.keys(errors).length === 0) return;
    setCurrentStepId(
      deriveInitialApplicantFormStepId({
        schema,
        answers,
        errors,
      }),
    );
  }, [errorSignature, stepped]);
  const fields = visibleFields(schema, answers);
  const sections = formSectionsForDisplay(schema, fields);
  const steps = formApplicantSteps(schema, answers);
  const resolvedStepId = stepped
    ? resolveApplicantFormStepId(schema, answers, currentStepId)
    : currentStepId;
  useEffect(() => {
    if (!stepped) return;
    if (resolvedStepId !== currentStepId) setCurrentStepId(resolvedStepId);
  }, [currentStepId, resolvedStepId, stepped]);
  useEffect(() => {
    advancingStep.current = false;
    if (!focusStepHeading.current) return;
    focusStepHeading.current = false;
    if (currentStepId === APPLICANT_SPEAKERS_STEP_ID) {
      speakersHeadingRef.current?.focus();
      return;
    }
    sectionHeadingRef.current?.focus();
  }, [currentStepId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentStepId is listed so focus runs after the revealed step has mounted.
  useEffect(() => {
    if (!pendingFocusHref) return;
    const href = pendingFocusHref;
    const focusTarget = () => {
      const target = document.getElementById(href.slice(1));
      if (!target) return false;
      target.focus();
      target.scrollIntoView({ block: "center" });
      return true;
    };
    if (focusTarget()) {
      setPendingFocusHref(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusTarget();
      setPendingFocusHref(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentStepId, pendingFocusHref]);
  const currentStep = steps.find((step) => step.id === resolvedStepId);
  const visibleSections = stepped
    ? sections.filter((section) => section.id === resolvedStepId)
    : sections;
  const showSpeakers =
    !stepped || resolvedStepId === APPLICANT_SPEAKERS_STEP_ID;
  const incompleteRequiredFields = incompleteRequiredVisibleFields(
    schema,
    answers,
    uploads,
  );
  const displayedErrors = { ...clientSectionErrors, ...errors };
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
        ...Object.entries(clientSectionErrors).flatMap(([field, messages]) =>
          messages.map((message) => ({
            message,
            href: `#answer-${field}`,
          })),
        ),
        ...incompleteRequiredFields
          .filter((field) => {
            if (!stepped) return true;
            if (currentStep?.kind !== "section") return false;
            return "sectionId" in field && field.sectionId === currentStep.id;
          })
          .filter((field) => !clientSectionErrors[field.id])
          .map((field) => ({
            message: `${field.label} is required.`,
            href: `#answer-${field.id}`,
          })),
      ]
    : [];

  function revealHref(href: string) {
    if (!stepped || requestInFlight || videoTransferBlocked) return;
    const stepId = applicantFormStepIdForHref(schema, href);
    if (stepId) setCurrentStepId(stepId);
    setPendingFocusHref(href);
  }

  function goToStep(stepId: string) {
    advancingStep.current = true;
    focusStepHeading.current = true;
    setClientValidationMessage(null);
    setClientSectionErrors({});
    setCurrentStepId(stepId);
  }

  function continueStep() {
    if (videoTransferBlocked || requestInFlight || advancingStep.current)
      return;
    const form = formRef.current;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (currentStep?.kind === "section") {
      const fieldIds = new Set(
        sections
          .find((section) => section.id === currentStep.id)
          ?.fields.map((field) => field.id),
      );
      const sectionErrors = Object.fromEntries(
        Object.entries(
          validateFinalAnswers(
            schema,
            answers,
            speakers,
            1,
            effectiveMaximumSpeakers,
            uploads,
          ),
        ).filter(([fieldId]) => fieldIds.has(fieldId)),
      );
      if (Object.keys(sectionErrors).length) {
        setClientSectionErrors(sectionErrors);
        setClientValidationMessage(
          "Complete the highlighted required field before continuing.",
        );
        return;
      }
    }
    const index = steps.findIndex((step) => step.id === resolvedStepId);
    const next = steps[index + 1];
    if (!next) return;
    goToStep(next.id);
  }

  function backStep() {
    if (videoTransferBlocked || requestInFlight) return;
    const index = steps.findIndex((step) => step.id === resolvedStepId);
    const previous = steps[index - 1];
    if (!previous) return;
    goToStep(previous.id);
  }

  function saveDraft() {
    const form = formRef.current;
    if (!form || videoTransferBlocked) return;
    const data = new FormData(form);
    data.set("_intent", "save_draft");
    submit(data, { method: "post", action });
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    if (!stepped || resolvedStepId === APPLICANT_SPEAKERS_STEP_ID) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent =
      submitter instanceof HTMLButtonElement ||
      submitter instanceof HTMLInputElement
        ? submitter.name === "_intent"
          ? submitter.value
          : null
        : null;
    if (intent === "save_draft" || intent === "withdraw") return;
    event.preventDefault();
    if (ignoreNextImplicitContinue.current) {
      ignoreNextImplicitContinue.current = false;
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement) return;
    if (active instanceof HTMLInputElement && active.type === "file") return;
    continueStep();
  }

  function handleFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (!stepped || resolvedStepId === APPLICANT_SPEAKERS_STEP_ID) return;
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      ignoreNextImplicitContinue.current = true;
      queueMicrotask(() => {
        ignoreNextImplicitContinue.current = false;
      });
      return;
    }
    ignoreNextImplicitContinue.current = false;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLButtonElement) return;
    if (target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLInputElement && target.type === "file") return;
    event.preventDefault();
    continueStep();
  }

  return (
    <Form
      id="submitted-application"
      method="post"
      action={action}
      className="stack"
      ref={formRef}
      onSubmit={handleFormSubmit}
      onKeyDown={handleFormKeyDown}
      onChange={() => {
        setDirty(true);
        setClientValidationMessage(null);
        setClientSectionErrors({});
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
        onRevealHref={stepped ? revealHref : undefined}
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
                  <a
                    href={`#answer-${field.id}`}
                    onClick={(event) => {
                      if (!stepped) return;
                      event.preventDefault();
                      revealHref(`#answer-${field.id}`);
                    }}
                  >
                    {field.label}
                  </a>
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
      {stepped ? (
        <ApplicantFormStepStatus steps={steps} currentStepId={resolvedStepId} />
      ) : null}
      <div data-application-step={stepped ? resolvedStepId : "single_page"}>
        <ApplicationAnswers
          sections={visibleSections}
          errors={displayedErrors}
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
          sectionHeadingRef={
            currentStep?.kind === "section" ? sectionHeadingRef : undefined
          }
          onUploadTransferChange={setVideoTransferBlocked}
          stepped={stepped}
        />
        {showSpeakers ? (
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
            errors={displayedErrors}
            duplicateSpeakerEmails={duplicateSpeakerEmails}
            headingRef={
              currentStep?.kind === "speakers" ? speakersHeadingRef : undefined
            }
          />
        ) : null}
      </div>
      {stepped ? (
        <ApplicantFormStepNav
          steps={steps}
          currentStepId={resolvedStepId}
          onBack={backStep}
          onContinue={continueStep}
          backDisabled={videoTransferBlocked || requestInFlight}
          continueDisabled={videoTransferBlocked || requestInFlight}
          showContinue={resolvedStepId !== APPLICANT_SPEAKERS_STEP_ID}
        />
      ) : null}
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
        persistenceOnly={
          stepped && resolvedStepId !== APPLICANT_SPEAKERS_STEP_ID
        }
        transferBlocked={videoTransferBlocked}
        saveDraftButtonType={
          stepped && resolvedStepId !== APPLICANT_SPEAKERS_STEP_ID
            ? "button"
            : "submit"
        }
        onSaveDraft={saveDraft}
      />
    </Form>
  );
}

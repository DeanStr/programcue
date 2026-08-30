import { z } from "zod";
import { requireValue } from "~/lib/required-value";
import {
  EventFieldService,
  type ParticipantProfilePolicies,
  participantVisibleProfile,
} from "~/modules/fields/event-field-service.server";
import { FileService } from "~/modules/files/file-service.server";
import type { PublicForm } from "./applicant-session.server";
import { routeEvaluationCoSpeakerEmails } from "./evaluation-co-speaker-email-routing.server";
import { SubmissionApplicantEventService } from "./submission-applicant-events.server";
import { submissionApplicationAvailability } from "./submission-availability";
import {
  type Applicant,
  type ApplicantDraft,
  type ParticipantApplicantDraft,
  SubmissionStateError,
} from "./submission-repository.server";
import {
  draftPayloadSchema,
  draftSavePayloadSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleAnswers,
  visibleFields,
} from "./submission-schema";
import {
  type ApplicantVideoUploadRow,
  answerValidationError,
  applicantFormView,
  discardDraftSchema,
  intentBoundDraftId,
  PublicFormUnavailableError,
  SubmissionServiceFoundation,
  withdrawSubmissionSchema,
} from "./submission-service-foundation.server";

type VerifiedApplicant = Extract<Applicant, { verified: true }>;
type ApplicantPortalView =
  | (Omit<VerifiedApplicant, "name" | "biography"> &
      Partial<Pick<VerifiedApplicant, "name" | "biography">>)
  | Extract<Applicant, { verified: false }>;

function participantVisibleApplicant(
  applicant: Applicant,
  policies: ParticipantProfilePolicies,
): ApplicantPortalView {
  if (!applicant.verified) return applicant;
  return participantVisibleProfile(applicant, policies) as ApplicantPortalView;
}

function participantVisibleDraft(
  draft: ApplicantDraft,
  policies: ParticipantProfilePolicies,
): ParticipantApplicantDraft {
  return {
    ...draft,
    speakers: draft.speakers.map((speaker) => {
      if (speaker.personId === null) return speaker;
      const visible = {
        ...speaker,
      } as ParticipantApplicantDraft["speakers"][number];
      if (policies.name === "hidden") delete visible.name;
      if (policies.biography === "hidden") delete visible.biography;
      return visible;
    }),
  };
}

export class SubmissionApplicantWorkflows extends SubmissionServiceFoundation {
  async authorizeApplicantProfileImport(request: Request, publicSlug: string) {
    const form = await this.getPublicForm(publicSlug);
    const applicant = await this.applicants.get(request, form);
    if (!applicant?.verified) {
      throw new Response(
        "Verify your applicant email before importing a public profile.",
        { status: 401 },
      );
    }
    this.assertApplicationManagementAccess(applicant);
    return {
      eventId: form.eventId,
      personId: applicant.personId,
      email: applicant.email,
    };
  }

  async authorizeApplicantMultipartUpload(
    request: Request,
    publicSlug: string,
    submissionIdInput: string,
    fieldIdInput: string,
  ) {
    const submissionId = z.string().min(1).max(100).parse(submissionIdInput);
    const fieldId = z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/)
      .parse(fieldIdInput);
    const form = await this.getPublicForm(publicSlug);
    const applicant = await this.applicants.get(request, form);
    if (!applicant) {
      throw new Response(
        "Open the application draft before uploading a video.",
        {
          status: 401,
        },
      );
    }
    this.assertApplicationManagementAccess(applicant);
    const draftForm = await this.repository.getApplicantDraftForm(
      form,
      applicant,
      submissionId,
    );
    const field = draftForm.version.schema.fields.find(
      (candidate) => candidate.id === fieldId,
    );
    if (field?.type !== "video") {
      throw new Response(
        "This application field does not accept video uploads.",
        {
          status: 422,
        },
      );
    }
    const draft = await this.env.DB.prepare(
      `SELECT event.organisation_id AS organisationId
         FROM submissions submission
         JOIN events event ON event.id = submission.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND version.form_id = ? AND version.id = ?
          AND submission.status = 'draft'
          AND (
            (? IS NOT NULL AND submission.submitter_person_id = ?)
            OR
            (? IS NOT NULL AND submission.id = ?
              AND submission.submitter_person_id IS NULL
              AND submission.submitter_email IS NULL)
          )`,
    )
      .bind(
        submissionId,
        form.eventId,
        form.id,
        draftForm.version.id,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
      .first<{ organisationId: string }>();
    if (!draft) {
      throw new Response("Application draft not found.", { status: 404 });
    }
    return {
      organisationId: draft.organisationId,
      eventId: form.eventId,
      personId: applicant.personId,
      submissionId,
      fieldId,
    };
  }

  protected applicationAvailability(
    form: Awaited<ReturnType<SubmissionServiceFoundation["getPublicForm"]>>,
  ) {
    return submissionApplicationAvailability(form);
  }

  protected async applicantApplicationAvailability(
    form: Awaited<ReturnType<SubmissionServiceFoundation["getPublicForm"]>>,
    applicant: Applicant,
    excludeSubmissionId?: string,
  ) {
    if (!applicant.verified || form.perPersonSubmissionLimit === null) {
      return this.applicationAvailability(form);
    }
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE version.form_id = ? AND submission.event_id = ?
          AND submission.submitter_person_id = ?
          AND submission.status <> 'withdrawn'
          AND (? IS NULL OR submission.id <> ?)`,
    )
      .bind(
        form.id,
        form.eventId,
        applicant.personId,
        excludeSubmissionId ?? null,
        excludeSubmissionId ?? null,
      )
      .first<{ count: number }>();
    return submissionApplicationAvailability({
      ...form,
      personSubmissionCount: row?.count ?? 0,
    });
  }

  protected async getApplicantVideoUpload(
    form: PublicForm,
    applicant: Applicant,
    submissionId: string,
  ) {
    const field = form.version.schema.fields.find(
      (candidate) => candidate.type === "video",
    );
    if (!field) return null;
    const row = await this.env.DB.prepare(
      `SELECT asset.id AS assetId, asset.status AS assetStatus,
              asset.current_version_id AS currentVersionId,
              version.id AS versionId, version.original_filename AS filename,
              version.size_bytes AS sizeBytes,
              version.upload_status AS uploadStatus,
              version.signature_status AS signatureStatus,
              version.scan_status AS scanStatus,
              version.released_at AS releasedAt
         FROM file_assets asset
         JOIN file_versions version
           ON version.asset_id = asset.id AND version.event_id = asset.event_id
        WHERE asset.event_id = ? AND asset.target_type = 'submission'
          AND asset.target_id = ? AND asset.asset_kind = 'video'
          AND asset.owner_person_id IS ? AND asset.status <> 'deleted'
        ORDER BY version.version_number DESC
        LIMIT 1`,
    )
      .bind(form.eventId, submissionId, applicant.personId)
      .first<ApplicantVideoUploadRow>();
    if (!row) return null;
    const status =
      row.assetStatus === "active" &&
      row.currentVersionId === row.versionId &&
      row.uploadStatus === "uploaded" &&
      row.signatureStatus === "valid" &&
      row.scanStatus === "clean" &&
      row.releasedAt !== null
        ? ("ready" as const)
        : row.uploadStatus === "uploaded" &&
            row.signatureStatus === "valid" &&
            row.scanStatus === "pending"
          ? ("scanning" as const)
          : ["failed", "aborted"].includes(row.uploadStatus) ||
              ["invalid", "failed"].includes(row.signatureStatus) ||
              ["infected", "failed"].includes(row.scanStatus) ||
              row.assetStatus === "rejected"
            ? ("rejected" as const)
            : ("uploading" as const);
    return {
      fieldId: field.id,
      assetId: row.assetId,
      versionId: row.versionId,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      status,
    };
  }

  async getApplicantPortal(
    publicSlug: string,
    request: Request,
    selectedId?: string | null,
    claimAccess?: { speakerId: string; rawToken?: string },
  ) {
    const claimedContext =
      claimAccess && !claimAccess.rawToken
        ? await this.requireClaimedCoSpeakerContext(
            publicSlug,
            claimAccess.speakerId,
            request,
          )
        : null;
    const form = claimedContext
      ? claimedContext.form
      : claimAccess?.rawToken
        ? await this.requireCoSpeakerClaimForm(
            publicSlug,
            claimAccess.speakerId,
            claimAccess.rawToken,
          )
        : await this.getApplicantAccessForm(publicSlug, selectedId);
    const applicant =
      claimedContext?.applicant ?? (await this.applicants.get(request, form));
    const availability = applicant
      ? await this.applicantApplicationAvailability(form, applicant)
      : this.applicationAvailability(form);
    const revisionAvailability = this.applicationRevisionAvailability(form);
    if (!applicant) {
      const browserForm = applicantFormView(form);
      return {
        form: browserForm,
        applicant: null,
        drafts: [],
        otherEventApplications: [],
        invitations: [],
        speakerProfile: null,
        draftSpeakerFieldAccess: null,
        selected: null,
        selectedForm: browserForm,
        selectedUpload: null,
        availability,
        selectedCanSubmit: false,
        selectedCanRevise: false,
      };
    }
    const [
      availableApplications,
      invitations,
      claimedProfile,
      otherEventApplications,
    ] = await Promise.all([
      applicant.claimOnly
        ? Promise.resolve([])
        : this.repository.getApplicantDrafts(form.id, applicant),
      this.repository.getCoSpeakerInvitations(form.id, applicant),
      applicant.verified
        ? this.env.DB.prepare(
            `SELECT 1 AS available
               FROM submission_speakers speaker
               JOIN submissions submission
                 ON submission.id = speaker.submission_id
                AND submission.event_id = speaker.event_id
               JOIN form_versions version
                 ON version.id = submission.form_version_id
                AND version.event_id = submission.event_id
              WHERE speaker.person_id = ? AND speaker.invitation_status = 'claimed'
                AND version.form_id = ? AND speaker.event_id = ?
              LIMIT 1`,
          )
            .bind(applicant.personId, form.id, form.eventId)
            .first<{ available: number }>()
        : Promise.resolve(null),
      applicant.verified &&
      applicant.personId &&
      !applicant.claimOnly &&
      !claimAccess &&
      !claimedContext
        ? this.env.DB.prepare(
            `SELECT submission.id, submission.title, submission.status,
                      form.name AS formName, form.public_slug AS formSlug
                 FROM submissions submission
                 JOIN form_versions version
                   ON version.id = submission.form_version_id
                  AND version.event_id = submission.event_id
                 JOIN form_definitions form
                   ON form.id = version.form_id
                  AND form.event_id = submission.event_id
                WHERE submission.event_id = ?
                  AND submission.submitter_person_id = ?
                  AND form.id <> ?
                  AND submission.status <> 'withdrawn'
                ORDER BY submission.updated_at DESC`,
          )
            .bind(form.eventId, applicant.personId, form.id)
            .all<{
              id: string;
              title: string;
              status: string;
              formName: string;
              formSlug: string;
            }>()
        : Promise.resolve({ results: [] }),
    ]);
    const drafts =
      form.status === "published" || claimAccess
        ? availableApplications
        : availableApplications.filter(
            (application) => application.status !== "draft",
          );
    const requestedDraft = selectedId !== null && selectedId !== undefined;
    const selected = requestedDraft
      ? (drafts.find((draft) => draft.id === selectedId) ?? null)
      : (drafts.find((draft) => draft.status === "draft") ??
        drafts.at(0) ??
        null);
    if (requestedDraft && !selected) {
      throw new Response("Application draft not found", { status: 404 });
    }
    const selectedForm = selected
      ? await this.repository.getApplicantDraftForm(
          form,
          applicant,
          selected.id,
        )
      : form;
    const selectedUpload =
      selected?.status === "draft" && selectedForm
        ? await this.getApplicantVideoUpload(
            selectedForm,
            applicant,
            selected.id,
          )
        : null;
    const selectedCanSubmit =
      selected?.status === "draft" && applicant.verified
        ? (
            await this.applicantApplicationAvailability(
              form,
              applicant,
              selected.id,
            )
          ).accepting
        : false;
    const profilePolicies = applicant.verified
      ? await new EventFieldService(this.env).profilePolicies(
          await this.publicScope(form.eventId),
        )
      : null;
    const applicantView = profilePolicies
      ? participantVisibleApplicant(applicant, profilePolicies)
      : applicant;
    const participantDrafts = profilePolicies
      ? drafts.map((draft) => participantVisibleDraft(draft, profilePolicies))
      : drafts;
    const participantSelected = selected
      ? (participantDrafts.find((draft) => draft.id === selected.id) ?? null)
      : null;
    let speakerProfile = null;
    if (applicant.verified && claimedProfile && profilePolicies) {
      const visible = participantVisibleProfile(
        {
          name: applicant.name,
          biography: applicant.biography,
        },
        profilePolicies,
      );
      if (
        profilePolicies.name !== "hidden" ||
        profilePolicies.biography !== "hidden"
      ) {
        speakerProfile = {
          ...visible,
          revision: applicant.profileRevision,
          fieldAccess: {
            name: profilePolicies.name,
            biography: profilePolicies.biography,
          },
        };
      }
    }
    return {
      form: applicantFormView(form),
      applicant: applicantView,
      drafts: participantDrafts,
      otherEventApplications: otherEventApplications.results,
      invitations,
      speakerProfile,
      draftSpeakerFieldAccess: profilePolicies
        ? {
            name: profilePolicies.name,
            biography: profilePolicies.biography,
          }
        : null,
      selected: participantSelected,
      selectedForm: applicantFormView(selectedForm),
      selectedUpload,
      availability,
      selectedCanSubmit,
      selectedCanRevise:
        Boolean(selected) &&
        requireValue(selected, "Required selected is unavailable.").status ===
          "submitted" &&
        revisionAvailability.accepting,
    };
  }

  async createDraft(
    publicSlug: string,
    applicant: Applicant,
    intentId: string = crypto.randomUUID(),
  ) {
    this.assertApplicationManagementAccess(applicant);
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectIntentCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.create",
      intentId,
      { publicSlug, applicant },
      async () => {
        const draftId = await intentBoundDraftId(
          form.id,
          "authenticated",
          applicant.personId,
          intentId,
        );
        const replay = await this.repository.findDraftCreationReplay(
          form,
          applicant,
          draftId,
        );
        if (replay) return replay.id;
        const availability = await this.applicantApplicationAvailability(
          form,
          applicant,
        );
        if (!availability.accepting) {
          throw new PublicFormUnavailableError(availability.reason);
        }
        const events = new SubmissionApplicantEventService(this.env);
        const prepared = await events.prepareDraftCreated(
          scope,
          applicant,
          draftId,
        );
        const created = await this.repository.createDraft(
          form,
          applicant,
          prepared,
          draftId,
        );
        await events.dispatch(prepared);
        return created;
      },
    );
  }

  async startAnonymousDraft(
    publicSlug: string,
    password: string,
    intentId: string = crypto.randomUUID(),
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectIntentCommand(
      { ...scope, personId: null },
      "submission.anonymous_draft.start",
      intentId,
      { publicSlug, password },
      async () =>
        this.startAnonymousDraftD1(
          form,
          scope,
          password,
          await intentBoundDraftId(form.id, "anonymous", null, intentId),
        ),
      { replay: "reject" },
    );
  }

  protected async startAnonymousDraftD1(
    form: PublicForm,
    scope: { organisationId: string; eventId: string },
    password: string,
    draftId: string,
  ) {
    const applicant: Applicant = {
      personId: null,
      email: "",
      name: "",
      verified: false,
      anonymousDraftId: draftId,
      biography: "",
      profileRevision: 0,
    };
    const replay = await this.repository.findDraftCreationReplay(
      form,
      applicant,
      draftId,
    );
    if (!replay) {
      const availability = this.applicationAvailability(form);
      if (!availability.accepting) {
        throw new PublicFormUnavailableError(availability.reason);
      }
    }
    const session = await this.applicants.startAnonymous(
      form,
      draftId,
      password,
      { requireExistingDraft: Boolean(replay) },
    );
    if (replay)
      return {
        draftId,
        cookie: session.cookie,
        setCookies: session.setCookies,
      };
    try {
      const events = new SubmissionApplicantEventService(this.env);
      const prepared = await events.prepareDraftCreated(
        scope,
        session.applicant,
        draftId,
      );
      await this.repository.createDraft(
        form,
        session.applicant,
        prepared,
        draftId,
      );
      await events.dispatch(prepared);
    } catch (error) {
      await this.env.DB.prepare("DELETE FROM verification_tokens WHERE id = ?")
        .bind(session.tokenId)
        .run();
      throw error;
    }
    return { draftId, cookie: session.cookie, setCookies: session.setCookies };
  }

  async saveDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.save",
      { publicSlug, applicant, rawPayload },
      () => this.saveDraftD1(currentForm, applicant, rawPayload),
    );
  }

  protected async saveDraftD1(
    currentForm: PublicForm,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    const restoredPayload =
      await this.restoreProtectedParticipantDraftSpeakerFields(
        currentForm,
        applicant,
        rawPayload,
        true,
      );
    const routed = await routeEvaluationCoSpeakerEmails(
      this.env,
      currentForm.eventId,
      applicant,
      draftSavePayloadSchema.parse(restoredPayload),
    );
    const payload = routed.payload;
    if (
      applicant.verified &&
      payload.speakers[0]?.email.toLowerCase() !== applicant.email.toLowerCase()
    ) {
      throw answerValidationError({
        speakers: [
          "The primary speaker email must match the verified applicant email.",
        ],
      });
    }
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const errors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(errors).length) throw answerValidationError(errors);
    return this.repository.saveDraft(form, applicant, payload, {
      evaluatorEmailRoutings: routed.evaluatorEmailRoutings,
    });
  }

  async submitDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before submitting this application.",
      );
    }
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.submit",
      { publicSlug, applicant, rawPayload },
      () => this.submitDraftD1(currentForm, applicant, rawPayload),
    );
  }

  async discardDraft(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const input = discardDraftSchema.parse(rawInput);
    const currentForm = await this.getDraftDiscardAccessForm(
      publicSlug,
      input.submissionId,
      input.revision,
    );
    const scope = await this.publicScope(currentForm.eventId);
    const findReplay = () =>
      this.repository.findDraftDiscardReplay(
        currentForm,
        applicant,
        input.submissionId,
        input.revision,
        scope.organisationId,
      );
    const replay = await findReplay();
    if (replay) return replay;
    try {
      const form = await this.repository.getApplicantDraftForm(
        currentForm,
        applicant,
        input.submissionId,
      );
      return await this.projectCommand(
        { ...scope, personId: applicant.personId },
        "submission.draft.discard",
        { publicSlug, input },
        async () => {
          const lock = await this.repository.beginDraftDiscard(
            form,
            applicant,
            input.submissionId,
            input.revision,
            crypto.randomUUID(),
          );
          const assets = await this.repository.getDraftFileAssets(
            form,
            applicant,
            input.submissionId,
            input.revision,
            lock.operationId,
          );
          const pendingAssets = assets.filter((asset) => asset.requiresErasure);
          if (applicant.verified) {
            const fileService = new FileService(this.env);
            for (const asset of pendingAssets) {
              try {
                await fileService.eraseAsset(
                  {
                    personId: applicant.personId,
                    name: applicant.name,
                    email: applicant.email,
                    role: "submitter",
                    organisationId: scope.organisationId,
                    eventId: form.eventId,
                    demo: false,
                    evaluation: applicant.evaluation,
                  },
                  {
                    assetId: asset.id,
                    confirmed: true,
                    reason: "application_draft_discarded",
                  },
                );
              } catch (error) {
                throw new SubmissionStateError(
                  error instanceof Error
                    ? error.message
                    : "The draft upload could not be erased. Retry the discard.",
                );
              }
            }
          }
          return this.repository.completeDraftDiscard(
            form,
            applicant,
            input.submissionId,
            input.revision,
            {
              organisationId: scope.organisationId,
              operationId: lock.operationId,
            },
          );
        },
      );
    } catch (error) {
      if (error instanceof Response && error.status === 404) {
        const committed = await findReplay();
        if (committed) return committed;
      }
      throw error;
    }
  }

  async submitDraftForParticipantApi(
    publicSlug: string,
    applicant: Extract<Applicant, { verified: true }>,
    rawPayload: unknown,
    operationId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.participant_api.submit",
      { publicSlug, applicant, rawPayload, operationId },
      () => this.submitDraftD1(currentForm, applicant, rawPayload, operationId),
    );
  }

  protected async submitDraftD1(
    currentForm: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawPayload: unknown,
    operationId?: string,
  ) {
    const restoredPayload =
      await this.restoreProtectedParticipantDraftSpeakerFields(
        currentForm,
        applicant,
        rawPayload,
        false,
      );
    const parsedPayload = draftPayloadSchema.parse(restoredPayload);
    const availability = await this.applicantApplicationAvailability(
      currentForm,
      applicant,
      parsedPayload.submissionId,
    );
    if (!availability.accepting)
      throw new PublicFormUnavailableError(availability.reason);
    const routed = await routeEvaluationCoSpeakerEmails(
      this.env,
      currentForm.eventId,
      applicant,
      parsedPayload,
    );
    const payload = routed.payload;
    if (
      payload.speakers[0]?.email.toLowerCase() !== applicant.email.toLowerCase()
    ) {
      throw answerValidationError({
        speakers: [
          "The primary speaker email must match the verified applicant email.",
        ],
      });
    }
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const shapeErrors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(shapeErrors).length)
      throw answerValidationError(shapeErrors);
    const answers = visibleAnswers(form.version.schema, payload.answers);
    const visibleVideoFields = new Set(
      visibleFields(form.version.schema, answers)
        .filter((field) => field.type === "video")
        .map((field) => field.id),
    );
    const uploads = Object.fromEntries(
      Object.entries(payload.uploads).filter(
        ([fieldId]) =>
          visibleVideoFields.has(fieldId) &&
          !String(answers[fieldId] ?? "").trim(),
      ),
    );
    const submittedPayload = {
      ...payload,
      answers,
      uploads,
    };
    const errors = validateFinalAnswers(
      form.version.schema,
      submittedPayload.answers,
      submittedPayload.speakers,
      form.minSpeakers,
      form.maxSpeakers,
      submittedPayload.uploads,
    );
    if (Object.keys(errors).length) {
      throw answerValidationError(errors);
    }
    const categoryAnswer = submittedPayload.answers.category;
    const selectedTrackNames = Array.isArray(categoryAnswer)
      ? categoryAnswer
      : typeof categoryAnswer === "string" && categoryAnswer
        ? [categoryAnswer]
        : [];
    if (form.kind === "direct_session" && selectedTrackNames.length !== 1) {
      throw new SubmissionStateError(
        "Choose exactly one track for a direct session. A scheduled session cannot silently discard additional track choices.",
      );
    }
    const trackSelections = selectedTrackNames.map((trackName) => {
      const trackId = form.version.routing.trackIds[trackName];
      if (!trackId || form.version.routing.trackNames[trackId] !== trackName) {
        throw new SubmissionStateError(
          `Track “${trackName}” is no longer valid for this form version.`,
        );
      }
      return { trackId, trackName };
    });
    const routedTeamIds =
      form.kind === "submission"
        ? [
            ...new Set(
              selectedTrackNames
                .map((trackName) => form.version.routing.categories[trackName])
                .filter((teamId): teamId is string => Boolean(teamId)),
            ),
          ]
        : [];
    for (const [fieldId, reference] of Object.entries(
      submittedPayload.uploads,
    )) {
      const upload = await this.env.DB.prepare(
        `SELECT asset.status AS assetStatus,
                asset.current_version_id AS currentVersionId,
                version.upload_status AS uploadStatus,
                version.signature_status AS signatureStatus,
                version.scan_status AS scanStatus,
                version.released_at AS releasedAt
           FROM file_assets asset
           JOIN file_versions version
             ON version.id = ? AND version.asset_id = asset.id
            AND version.event_id = asset.event_id
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.target_type = 'submission' AND asset.target_id = ?
            AND asset.asset_kind = 'video' AND asset.owner_person_id = ?
            AND asset.status <> 'deleted'`,
      )
        .bind(
          reference.versionId,
          reference.assetId,
          form.eventId,
          submittedPayload.submissionId,
          applicant.personId,
        )
        .first<{
          assetStatus: string;
          currentVersionId: string | null;
          uploadStatus: string;
          signatureStatus: string;
          scanStatus: string;
          releasedAt: number | null;
        }>();
      if (!upload) {
        throw new SubmissionStateError(
          `The native video selected for ${fieldId} no longer belongs to this draft. Upload it again or use an HTTPS link.`,
        );
      }
      if (
        upload.assetStatus !== "active" ||
        upload.currentVersionId !== reference.versionId ||
        upload.uploadStatus !== "uploaded" ||
        upload.signatureStatus !== "valid" ||
        upload.scanStatus !== "clean" ||
        upload.releasedAt === null
      ) {
        const message =
          upload.uploadStatus === "uploaded" &&
          upload.signatureStatus === "valid" &&
          upload.scanStatus === "pending"
            ? "The uploaded video is still being scanned. Refresh after the scan finishes before submitting."
            : "The uploaded video did not pass upload and security validation. Upload a replacement or use an HTTPS link.";
        throw new SubmissionStateError(message);
      }
    }
    return this.repository.submitDraft(form, applicant, submittedPayload, {
      trackSelections,
      routedTeamIds,
      upload:
        Object.entries(submittedPayload.uploads).map(
          ([fieldId, reference]) => ({ fieldId, ...reference }),
        )[0] ?? null,
      operationId,
      evaluatorEmailRoutings: routed.evaluatorEmailRoutings,
    });
  }

  async withdrawSubmission(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before withdrawing this application.",
      );
    }
    const input = withdrawSubmissionSchema.parse(rawInput);
    const currentForm = await this.getPublicForm(publicSlug);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      input.submissionId,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.withdraw",
      { publicSlug, input },
      async () => {
        const events = new SubmissionApplicantEventService(this.env);
        const operationId = crypto.randomUUID();
        const prepared = await events.prepareWithdrawn(
          scope,
          applicant,
          input.submissionId,
          operationId,
          input.revision + 1,
        );
        const withdrawn = await this.repository.withdrawSubmission(
          form,
          applicant,
          input.submissionId,
          input.revision,
          prepared,
          { operationId },
        );
        await events.dispatch(prepared);
        return withdrawn;
      },
    );
  }

  async withdrawSubmissionForParticipantApi(
    publicSlug: string,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
    operationId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const input = withdrawSubmissionSchema.parse(rawInput);
    const currentForm = await this.getPublicForm(publicSlug);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      input.submissionId,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.participant_api.withdraw",
      { publicSlug, input, operationId },
      async () => {
        const events = new SubmissionApplicantEventService(this.env);
        const prepared = await events.prepareWithdrawn(
          scope,
          applicant,
          input.submissionId,
          operationId,
          input.revision + 1,
        );
        const withdrawn = await this.repository.withdrawSubmission(
          form,
          applicant,
          input.submissionId,
          input.revision,
          prepared,
          { operationId },
        );
        await events.dispatch(prepared);
        return withdrawn;
      },
    );
  }
}

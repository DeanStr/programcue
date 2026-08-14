import { z } from "zod";
import {
  airtableIntentCommand,
  type AirtableCommandIdentity,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_ORGANISATION_ID } from "~/platform/demo/demo-identities";
import {
  resolveEvaluatorEmailAlias,
  type EvaluatorEmailRouting,
} from "~/platform/evaluation/evaluator-email-alias.server";
import { type PublicForm } from "./applicant-session.server";
import { SubmissionApplicantEventService } from "./submission-applicant-events.server";
import { dispatchCoSpeakerInvitationsForSubmissionRevision } from "./co-speaker-invitation.server";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type SubmittedRevisionCommand,
  type SubmittedRevisionCommit,
} from "./submission-repository.server";
import {
  draftPayloadSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleAnswers,
  visibleFields,
} from "./submission-schema";
import {
  PublicFormUnavailableError,
  answerValidationError,
  applicantFormView,
  intentBoundDraftId,
  withdrawSubmissionSchema,
  type ApplicantVideoUploadRow,
} from "./submission-service-foundation.server";

const SUBMITTED_REVISION_SCOPE = "submission.submitted.revise" as const;

const submittedRevisionCommitSchema = z
  .object({
    submissionId: z.string().min(1).max(100),
    organisationId: z.string().min(1),
    eventId: z.string().min(1),
    revision: z.number().int().positive(),
    invitationCount: z.number().int().nonnegative(),
    webhookCount: z.number().int().nonnegative(),
    auditEventId: z.string().min(1),
  })
  .strict();

function submittedRevisionActorId(personId: string) {
  return `person:${personId}`;
}

async function routeEvaluationCoSpeakerEmails<
  Payload extends { speakers: Array<{ email: string }> },
>(
  env: CloudflareEnvironment,
  eventId: string,
  applicant: Applicant,
  payload: Payload,
): Promise<{
  payload: Payload;
  evaluatorEmailRoutings: EvaluatorEmailRouting[];
}> {
  if (!applicant.verified || applicant.evaluation !== true) {
    return { payload, evaluatorEmailRoutings: [] };
  }
  const resolutions = await Promise.all(
    payload.speakers.map(async (speaker, index) => {
      if (index === 0) return { speaker, routing: null };
      const resolution = await resolveEvaluatorEmailAlias(
        env,
        {
          organisationId: DEMO_ORGANISATION_ID,
          eventId,
          evaluation: true,
        },
        speaker.email,
      );
      return {
        speaker: { ...speaker, email: resolution.email },
        routing: resolution.routing,
      };
    }),
  );
  const speakers = resolutions.map((resolution) => resolution.speaker);
  const evaluatorEmailRoutings = resolutions.flatMap((resolution) =>
    resolution.routing ? [resolution.routing] : [],
  );
  if (
    new Set(speakers.map((speaker) => speaker.email)).size !== speakers.length
  ) {
    throw answerValidationError({
      speakers: ["Each speaker must resolve to a different evaluator inbox."],
    });
  }
  return {
    payload: { ...payload, speakers } as Payload,
    evaluatorEmailRoutings,
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
    if (form.status !== "published") {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    if (
      form.closesAt !== null &&
      form.closesAt < Math.floor(Date.now() / 1_000)
    ) {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    if (
      form.submissionLimit !== null &&
      form.submittedCount >= form.submissionLimit
    ) {
      return {
        accepting: false as const,
        reason: "This call for speakers has reached its submission limit.",
      };
    }
    return { accepting: true as const, reason: null };
  }

  protected applicationRevisionAvailability(
    form: Awaited<ReturnType<SubmissionServiceFoundation["getPublicForm"]>>,
  ) {
    if (form.status !== "published") {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    if (
      form.closesAt !== null &&
      form.closesAt < Math.floor(Date.now() / 1_000)
    ) {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    return { accepting: true as const, reason: null };
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
        : await this.getPublicForm(publicSlug);
    const applicant =
      claimedContext?.applicant ?? (await this.applicants.get(request, form));
    const availability = this.applicationAvailability(form);
    const revisionAvailability = this.applicationRevisionAvailability(form);
    if (!applicant) {
      const browserForm = applicantFormView(form);
      return {
        form: browserForm,
        applicant: null,
        drafts: [],
        invitations: [],
        speakerProfile: null,
        selected: null,
        selectedForm: browserForm,
        selectedUpload: null,
        availability,
        selectedCanRevise: false,
      };
    }
    const [drafts, invitations, claimedProfile] = await Promise.all([
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
    ]);
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
    return {
      form: applicantFormView(form),
      applicant,
      drafts,
      invitations,
      speakerProfile:
        applicant.verified && claimedProfile
          ? {
              name: applicant.name,
              biography: applicant.biography,
              revision: applicant.profileRevision,
            }
          : null,
      selected,
      selectedForm: applicantFormView(selectedForm),
      selectedUpload,
      availability,
      selectedCanRevise:
        Boolean(selected) &&
        selected!.status === "submitted" &&
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
        const availability = this.applicationAvailability(form);
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
    if (replay) return { draftId, cookie: session.cookie };
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
    return { draftId, cookie: session.cookie };
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
    const routed = await routeEvaluationCoSpeakerEmails(
      this.env,
      currentForm.eventId,
      applicant,
      draftPayloadSchema.parse(rawPayload),
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

  async reviseSubmitted(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
    intentId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before revising this application.",
      );
    }
    const parsedPayload = draftPayloadSchema.parse(rawPayload);
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    const identity = await airtableIntentCommand(
      SUBMITTED_REVISION_SCOPE,
      { ...scope, personId: applicant.personId },
      intentId,
      { publicSlug, payload: parsedPayload },
    );
    return this.airtable.executeIdempotent(
      { ...scope, personId: applicant.personId },
      identity,
      () =>
        this.reviseSubmittedD1(
          currentForm,
          scope,
          applicant,
          parsedPayload,
          identity,
        ),
    );
  }

  private async readSubmittedRevisionReplay(
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    identity: AirtableCommandIdentity,
  ): Promise<{ commandId: string; committed: SubmittedRevisionCommit } | null> {
    const actorId = submittedRevisionActorId(applicant.personId);
    const record = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status,
              response_json AS responseJson, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        scope.organisationId,
        scope.eventId,
        actorId,
        SUBMITTED_REVISION_SCOPE,
        identity.idempotencyKey,
      )
      .first<{
        id: string;
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
        entityId: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== identity.requestHash) {
      throw new SubmissionStateError(
        "This revision identifier was already used with different application details. Refresh before trying again.",
      );
    }
    if (record.status !== "completed") {
      throw new SubmissionStateError(
        record.status === "processing"
          ? "This revision request is still being processed. Retry the same revision shortly."
          : "This revision request did not complete. Refresh and submit a new explicit revision.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed submitted-revision command is missing its durable result.",
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(record.responseJson);
    } catch {
      throw new Error(
        "The completed submitted-revision command has an invalid durable result.",
      );
    }
    const committed = submittedRevisionCommitSchema.parse(decoded);
    if (
      committed.organisationId !== scope.organisationId ||
      committed.eventId !== scope.eventId ||
      committed.submissionId !== record.entityId
    ) {
      throw new Error(
        "The completed submitted-revision command is outside its durable event or submission scope.",
      );
    }
    return { commandId: record.id, committed };
  }

  private async resumeSubmittedRevision(
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    commandId: string,
    committed: SubmittedRevisionCommit,
  ) {
    const invitations = await dispatchCoSpeakerInvitationsForSubmissionRevision(
      {
        env: this.env,
        organisationId: scope.organisationId,
        eventId: scope.eventId,
        submissionId: committed.submissionId,
        commandId,
        expectedCount: committed.invitationCount,
      },
    );
    const webhookDeliveries = await new SubmissionApplicantEventService(
      this.env,
    ).resumeRevised(
      scope,
      applicant,
      committed.submissionId,
      commandId,
      committed.revision,
      committed.auditEventId,
    );
    if (webhookDeliveries.length !== committed.webhookCount) {
      throw new Error(
        "The committed submission revision is missing a durable webhook operation.",
      );
    }
    return {
      submissionId: committed.submissionId,
      organisationId: committed.organisationId,
      eventId: committed.eventId,
      revision: committed.revision,
      invitations,
      webhookQueueFailed: webhookDeliveries.some(
        (delivery) => delivery.status === "queue_failed",
      ),
    };
  }

  private async reviseSubmittedD1(
    currentForm: PublicForm,
    scope: { organisationId: string; eventId: string },
    applicant: Extract<Applicant, { verified: true }>,
    parsedPayload: ReturnType<typeof draftPayloadSchema.parse>,
    identity: AirtableCommandIdentity,
  ) {
    const replay = await this.readSubmittedRevisionReplay(
      scope,
      applicant,
      identity,
    );
    if (replay) {
      return this.resumeSubmittedRevision(
        scope,
        applicant,
        replay.commandId,
        replay.committed,
      );
    }
    const revisionAvailability =
      this.applicationRevisionAvailability(currentForm);
    if (!revisionAvailability.accepting) {
      throw new PublicFormUnavailableError(revisionAvailability.reason);
    }
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
    if (form.kind !== "submission") {
      throw new SubmissionStateError(
        "Only a submitted proposal can be revised through this workflow.",
      );
    }
    const shapeErrors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(shapeErrors).length) {
      throw answerValidationError(shapeErrors);
    }
    const answers = visibleAnswers(form.version.schema, payload.answers);
    const submittedPayload = { ...payload, answers };
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
    const trackSelections = selectedTrackNames.map((trackName) => {
      const trackId = form.version.routing.trackIds[trackName];
      if (!trackId || form.version.routing.trackNames[trackId] !== trackName) {
        throw new SubmissionStateError(
          `Track “${trackName}” is no longer valid for this form version.`,
        );
      }
      return { trackId, trackName };
    });
    if (trackSelections.length === 0) {
      throw new SubmissionStateError(
        "A submission must retain at least one submitted event track.",
      );
    }
    const routedTeamIds = [
      ...new Set(
        selectedTrackNames
          .map((trackName) => form.version.routing.categories[trackName])
          .filter((teamId): teamId is string => Boolean(teamId)),
      ),
    ];
    const command: SubmittedRevisionCommand = {
      recordId: crypto.randomUUID(),
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorId: submittedRevisionActorId(applicant.personId),
      scope: SUBMITTED_REVISION_SCOPE,
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
    };
    const events = new SubmissionApplicantEventService(this.env);
    const prepared = await events.prepareRevised(
      scope,
      applicant,
      submittedPayload.submissionId,
      command.recordId,
      submittedPayload.revision + 1,
    );
    let committed: SubmittedRevisionCommit;
    try {
      committed = await this.repository.reviseSubmitted(
        form,
        applicant,
        submittedPayload,
        {
          trackSelections,
          routedTeamIds,
          command,
          event: prepared,
          evaluatorEmailRoutings: routed.evaluatorEmailRoutings,
        },
      );
    } catch (error) {
      if (!(error instanceof SubmissionRevisionConflictError)) throw error;
      const converged = await this.readSubmittedRevisionReplay(
        scope,
        applicant,
        identity,
      );
      if (!converged) throw error;
      return this.resumeSubmittedRevision(
        scope,
        applicant,
        converged.commandId,
        converged.committed,
      );
    }
    return this.resumeSubmittedRevision(
      scope,
      applicant,
      command.recordId,
      committed,
    );
  }

  protected async submitDraftD1(
    currentForm: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawPayload: unknown,
    operationId?: string,
  ) {
    const availability = this.applicationAvailability(currentForm);
    if (!availability.accepting)
      throw new PublicFormUnavailableError(availability.reason);
    const routed = await routeEvaluationCoSpeakerEmails(
      this.env,
      currentForm.eventId,
      applicant,
      draftPayloadSchema.parse(rawPayload),
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

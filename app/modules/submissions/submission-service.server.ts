import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { SubmissionAdministrationWorkflows } from "./submission-administration-workflows.server";
import { SubmissionApplicantWorkflows } from "./submission-applicant-workflows.server";
import { SubmissionCoSpeakerWorkflows } from "./submission-co-speaker-workflows.server";
import { SubmissionFormWorkflows } from "./submission-form-workflows.server";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";

export {
  PublicFormUnavailableError,
  type SubmissionApiActor,
} from "./submission-service-foundation.server";

/** Stable submission façade composed from independent workflow services. */
export class SubmissionService {
  static workspaceToInput(
    ...args: Parameters<
      typeof SubmissionAdministrationWorkflows.workspaceToInput
    >
  ) {
    return SubmissionAdministrationWorkflows.workspaceToInput(...args);
  }

  static synchronizeFormEventChoices(
    ...args: Parameters<
      typeof SubmissionAdministrationWorkflows.synchronizeFormEventChoices
    >
  ) {
    return SubmissionAdministrationWorkflows.synchronizeFormEventChoices(
      ...args,
    );
  }

  private readonly shared: SubmissionServiceFoundation;
  private readonly forms: SubmissionFormWorkflows;
  private readonly coSpeakers: SubmissionCoSpeakerWorkflows;
  private readonly applicantWorkflows: SubmissionApplicantWorkflows;
  private readonly administration: SubmissionAdministrationWorkflows;
  readonly repository: SubmissionServiceFoundation["repository"];
  readonly applicants: SubmissionServiceFoundation["applicants"];

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.shared = new SubmissionServiceFoundation(env, collaborators);
    this.forms = new SubmissionFormWorkflows(env, collaborators);
    this.coSpeakers = new SubmissionCoSpeakerWorkflows(env, collaborators);
    this.applicantWorkflows = new SubmissionApplicantWorkflows(
      env,
      collaborators,
    );
    this.administration = new SubmissionAdministrationWorkflows(
      env,
      collaborators,
    );
    this.repository = this.shared.repository;
    this.applicants = this.shared.applicants;
  }

  getApplicationEventScope(
    ...args: Parameters<SubmissionServiceFoundation["getApplicationEventScope"]>
  ) {
    return this.shared.getApplicationEventScope(...args);
  }
  getConfiguredSessionFormats(
    ...args: Parameters<
      SubmissionServiceFoundation["getConfiguredSessionFormats"]
    >
  ) {
    return this.shared.getConfiguredSessionFormats(...args);
  }
  getPublicForm(
    ...args: Parameters<SubmissionServiceFoundation["getPublicForm"]>
  ) {
    return this.shared.getPublicForm(...args);
  }
  requireClaimedCoSpeakerContext(
    ...args: Parameters<
      SubmissionServiceFoundation["requireClaimedCoSpeakerContext"]
    >
  ) {
    return this.shared.requireClaimedCoSpeakerContext(...args);
  }

  getAdminWorkspace(
    ...args: Parameters<SubmissionFormWorkflows["getAdminWorkspace"]>
  ) {
    return this.forms.getAdminWorkspace(...args);
  }
  listAdminForms(
    ...args: Parameters<SubmissionFormWorkflows["listAdminForms"]>
  ) {
    return this.forms.listAdminForms(...args);
  }
  getLatestPublishedFormSlug(
    ...args: Parameters<SubmissionFormWorkflows["getLatestPublishedFormSlug"]>
  ) {
    return this.forms.getLatestPublishedFormSlug(...args);
  }
  defaultFormInput(
    ...args: Parameters<SubmissionFormWorkflows["defaultFormInput"]>
  ) {
    return this.forms.defaultFormInput(...args);
  }
  getDefaultFormInput(
    ...args: Parameters<SubmissionFormWorkflows["getDefaultFormInput"]>
  ) {
    return this.forms.getDefaultFormInput(...args);
  }
  saveForm(...args: Parameters<SubmissionFormWorkflows["saveForm"]>) {
    return this.forms.saveForm(...args);
  }
  publishForm(...args: Parameters<SubmissionFormWorkflows["publishForm"]>) {
    return this.forms.publishForm(...args);
  }
  listRoutingTeams(
    ...args: Parameters<SubmissionFormWorkflows["listRoutingTeams"]>
  ) {
    return this.forms.listRoutingTeams(...args);
  }
  listRoutingTracks(
    ...args: Parameters<SubmissionFormWorkflows["listRoutingTracks"]>
  ) {
    return this.forms.listRoutingTracks(...args);
  }

  inviteAcceptedCoSpeaker(
    ...args: Parameters<SubmissionCoSpeakerWorkflows["inviteAcceptedCoSpeaker"]>
  ) {
    return this.coSpeakers.inviteAcceptedCoSpeaker(...args);
  }
  recoverAcceptedCoSpeakerInvitation(
    ...args: Parameters<
      SubmissionCoSpeakerWorkflows["recoverAcceptedCoSpeakerInvitation"]
    >
  ) {
    return this.coSpeakers.recoverAcceptedCoSpeakerInvitation(...args);
  }
  updateClaimedSpeakerProfile(
    ...args: Parameters<
      SubmissionCoSpeakerWorkflows["updateClaimedSpeakerProfile"]
    >
  ) {
    return this.coSpeakers.updateClaimedSpeakerProfile(...args);
  }
  updateClaimedCoSpeakerProfile(
    ...args: Parameters<
      SubmissionCoSpeakerWorkflows["updateClaimedCoSpeakerProfile"]
    >
  ) {
    return this.coSpeakers.updateClaimedCoSpeakerProfile(...args);
  }
  claimCoSpeaker(
    ...args: Parameters<SubmissionCoSpeakerWorkflows["claimCoSpeaker"]>
  ) {
    return this.coSpeakers.claimCoSpeaker(...args);
  }
  getCoSpeakerClaim(
    ...args: Parameters<SubmissionCoSpeakerWorkflows["getCoSpeakerClaim"]>
  ) {
    return this.coSpeakers.getCoSpeakerClaim(...args);
  }
  claimCoSpeakerToken(
    ...args: Parameters<SubmissionCoSpeakerWorkflows["claimCoSpeakerToken"]>
  ) {
    return this.coSpeakers.claimCoSpeakerToken(...args);
  }
  resendCoSpeakerInvitation(
    ...args: Parameters<
      SubmissionCoSpeakerWorkflows["resendCoSpeakerInvitation"]
    >
  ) {
    return this.coSpeakers.resendCoSpeakerInvitation(...args);
  }

  authorizeApplicantProfileImport(
    ...args: Parameters<
      SubmissionApplicantWorkflows["authorizeApplicantProfileImport"]
    >
  ) {
    return this.applicantWorkflows.authorizeApplicantProfileImport(...args);
  }
  authorizeApplicantMultipartUpload(
    ...args: Parameters<
      SubmissionApplicantWorkflows["authorizeApplicantMultipartUpload"]
    >
  ) {
    return this.applicantWorkflows.authorizeApplicantMultipartUpload(...args);
  }
  getApplicantPortal(
    ...args: Parameters<SubmissionApplicantWorkflows["getApplicantPortal"]>
  ) {
    return this.applicantWorkflows.getApplicantPortal(...args);
  }
  createDraft(
    ...args: Parameters<SubmissionApplicantWorkflows["createDraft"]>
  ) {
    return this.applicantWorkflows.createDraft(...args);
  }
  startAnonymousDraft(
    ...args: Parameters<SubmissionApplicantWorkflows["startAnonymousDraft"]>
  ) {
    return this.applicantWorkflows.startAnonymousDraft(...args);
  }
  saveDraft(...args: Parameters<SubmissionApplicantWorkflows["saveDraft"]>) {
    return this.applicantWorkflows.saveDraft(...args);
  }
  submitDraft(
    ...args: Parameters<SubmissionApplicantWorkflows["submitDraft"]>
  ) {
    return this.applicantWorkflows.submitDraft(...args);
  }
  submitDraftForParticipantApi(
    ...args: Parameters<
      SubmissionApplicantWorkflows["submitDraftForParticipantApi"]
    >
  ) {
    return this.applicantWorkflows.submitDraftForParticipantApi(...args);
  }
  reviseSubmitted(
    ...args: Parameters<SubmissionApplicantWorkflows["reviseSubmitted"]>
  ) {
    return this.applicantWorkflows.reviseSubmitted(...args);
  }
  withdrawSubmission(
    ...args: Parameters<SubmissionApplicantWorkflows["withdrawSubmission"]>
  ) {
    return this.applicantWorkflows.withdrawSubmission(...args);
  }
  withdrawSubmissionForParticipantApi(
    ...args: Parameters<
      SubmissionApplicantWorkflows["withdrawSubmissionForParticipantApi"]
    >
  ) {
    return this.applicantWorkflows.withdrawSubmissionForParticipantApi(...args);
  }

  listAdminSubmissions(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["listAdminSubmissions"]
    >
  ) {
    return this.administration.listAdminSubmissions(...args);
  }
  listAdminSubmissionPage(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["listAdminSubmissionPage"]
    >
  ) {
    return this.administration.listAdminSubmissionPage(...args);
  }
  getAdminSubmissionQueueContext(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["getAdminSubmissionQueueContext"]
    >
  ) {
    return this.administration.getAdminSubmissionQueueContext(...args);
  }
  getAdminSubmission(
    ...args: Parameters<SubmissionAdministrationWorkflows["getAdminSubmission"]>
  ) {
    return this.administration.getAdminSubmission(...args);
  }
  createDirectSession(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["createDirectSession"]
    >
  ) {
    return this.administration.createDirectSession(...args);
  }
  createDirectSessionForApi(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["createDirectSessionForApi"]
    >
  ) {
    return this.administration.createDirectSessionForApi(...args);
  }
  createManualApplication(
    ...args: Parameters<
      SubmissionAdministrationWorkflows["createManualApplication"]
    >
  ) {
    return this.administration.createManualApplication(...args);
  }
}

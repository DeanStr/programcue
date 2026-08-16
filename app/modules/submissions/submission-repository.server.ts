import { SubmissionAdminRepository } from "./submission-admin-repository.server";
import { SubmissionApplicantRepository } from "./submission-applicant-repository.server";
import { SubmissionFormRepository } from "./submission-form-repository.server";
import { closeDateFromEpoch } from "./submission-repository-shared";

export type {
  AdminSubmission,
  Applicant,
  ApplicantDraft,
  CoSpeakerInvitation,
  FormSummary,
  FormVersion,
  FormWorkspace,
  SubmittedRevisionCommand,
  SubmittedRevisionCommit,
} from "./submission-repository-shared";
export {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "./submission-repository-shared";

/**
 * Stable repository facade used by routes and services. The concrete
 * repositories keep form administration, applicant workflow, and administrator
 * read models independently navigable without changing the public boundary.
 */
export class D1SubmissionRepository {
  static closeDateFromEpoch = closeDateFromEpoch;

  private readonly forms: SubmissionFormRepository;
  private readonly applicants: SubmissionApplicantRepository;
  private readonly administration: SubmissionAdminRepository;

  constructor(env: CloudflareEnvironment) {
    this.forms = new SubmissionFormRepository(env);
    this.applicants = new SubmissionApplicantRepository(env);
    this.administration = new SubmissionAdminRepository(env);
  }

  getAdminWorkspace(
    ...args: Parameters<SubmissionFormRepository["getAdminWorkspace"]>
  ) {
    return this.forms.getAdminWorkspace(...args);
  }

  createForm(...args: Parameters<SubmissionFormRepository["createForm"]>) {
    return this.forms.createForm(...args);
  }

  saveForm(...args: Parameters<SubmissionFormRepository["saveForm"]>) {
    return this.forms.saveForm(...args);
  }

  publishForm(...args: Parameters<SubmissionFormRepository["publishForm"]>) {
    return this.forms.publishForm(...args);
  }

  getPublicForm(
    ...args: Parameters<SubmissionFormRepository["getPublicForm"]>
  ) {
    return this.forms.getPublicForm(...args);
  }

  getCoSpeakerClaimForm(
    ...args: Parameters<SubmissionFormRepository["getCoSpeakerClaimForm"]>
  ) {
    return this.forms.getCoSpeakerClaimForm(...args);
  }

  getApplicantDrafts(
    ...args: Parameters<SubmissionApplicantRepository["getApplicantDrafts"]>
  ) {
    return this.applicants.getApplicantDrafts(...args);
  }

  getCoSpeakerInvitations(
    ...args: Parameters<
      SubmissionApplicantRepository["getCoSpeakerInvitations"]
    >
  ) {
    return this.applicants.getCoSpeakerInvitations(...args);
  }

  claimCoSpeaker(
    ...args: Parameters<SubmissionApplicantRepository["claimCoSpeaker"]>
  ) {
    return this.applicants.claimCoSpeaker(...args);
  }

  getApplicantDraftForm(
    ...args: Parameters<SubmissionApplicantRepository["getApplicantDraftForm"]>
  ) {
    return this.applicants.getApplicantDraftForm(...args);
  }

  findDraftCreationReplay(
    ...args: Parameters<
      SubmissionApplicantRepository["findDraftCreationReplay"]
    >
  ) {
    return this.applicants.findDraftCreationReplay(...args);
  }

  createDraft(
    ...args: Parameters<SubmissionApplicantRepository["createDraft"]>
  ) {
    return this.applicants.createDraft(...args);
  }

  saveDraft(...args: Parameters<SubmissionApplicantRepository["saveDraft"]>) {
    return this.applicants.saveDraft(...args);
  }

  withdrawSubmission(
    ...args: Parameters<SubmissionApplicantRepository["withdrawSubmission"]>
  ) {
    return this.applicants.withdrawSubmission(...args);
  }

  submitDraft(
    ...args: Parameters<SubmissionApplicantRepository["submitDraft"]>
  ) {
    return this.applicants.submitDraft(...args);
  }

  reviseSubmitted(
    ...args: Parameters<SubmissionApplicantRepository["reviseSubmitted"]>
  ) {
    return this.applicants.reviseSubmitted(...args);
  }

  listAdminSubmissions(
    ...args: Parameters<SubmissionAdminRepository["listAdminSubmissions"]>
  ) {
    return this.administration.listAdminSubmissions(...args);
  }

  countAdminSubmissions(
    ...args: Parameters<SubmissionAdminRepository["countAdminSubmissions"]>
  ) {
    return this.administration.countAdminSubmissions(...args);
  }

  getAdminSubmissionSummary(
    ...args: Parameters<SubmissionAdminRepository["getAdminSubmissionSummary"]>
  ) {
    return this.administration.getAdminSubmissionSummary(...args);
  }

  listAdminSubmissionCategories(
    ...args: Parameters<
      SubmissionAdminRepository["listAdminSubmissionCategories"]
    >
  ) {
    return this.administration.listAdminSubmissionCategories(...args);
  }

  getAdminSubmission(
    ...args: Parameters<SubmissionAdminRepository["getAdminSubmission"]>
  ) {
    return this.administration.getAdminSubmission(...args);
  }
}

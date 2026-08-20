export function applicationDraftHref(
  draftId: string,
  claimedSpeakerId: string | null,
) {
  return `?${new URLSearchParams({
    ...(claimedSpeakerId ? { claimedSpeaker: claimedSpeakerId } : {}),
    draft: draftId,
  })}`;
}

export function applicationAccessReturnTo(
  publicSlug: string,
  requestedSubmissionId: string | null,
) {
  return `/apply/${encodeURIComponent(publicSlug)}${
    requestedSubmissionId
      ? applicationDraftHref(requestedSubmissionId, null)
      : ""
  }`;
}

export function acceptedParticipantManagementHref(
  eventId: string,
  submissionId: string,
) {
  const returnTo = `/participant/applications?${new URLSearchParams({
    application: submissionId,
  })}#participant-application-detail`;
  return `/events/select?${new URLSearchParams({ eventId, returnTo })}`;
}

type EvaluationApplicantContext = {
  identityLabel: string | null;
  verificationRequiresEvaluationLock: boolean;
};

export function evaluationApplicantContextMessage(
  context: EvaluationApplicantContext,
  accessMode: "email_verified" | "password_protected" | "account_required",
) {
  if (accessMode === "account_required") {
    return "This form requires an ordinary Program Cue account, which evaluation access deliberately does not inherit. Lock evaluation before signing in.";
  }
  if (context.verificationRequiresEvaluationLock) {
    return "This application can be saved anonymously. Before verifying your email, lock evaluation access; your anonymous draft will remain available.";
  }
  return "This public application uses a separate applicant session. Drafts can start anonymously; email verification is required before submission.";
}

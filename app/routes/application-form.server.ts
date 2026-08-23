import { data } from "react-router";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { evaluationApplicantSessionContext } from "~/modules/submissions/applicant-session.server";
import {
  assertApplicationNoticeConfiguration,
  verifyApplicationNotice,
} from "~/modules/submissions/application-notice.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionStateError } from "~/modules/submissions/submission-repository.server";
import {
  PublicFormUnavailableError,
  SubmissionService,
} from "~/modules/submissions/submission-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { EVALUATION_IDENTITIES } from "~/platform/evaluation/evaluation-session.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import { publicAbuseClientConfiguration } from "~/platform/http/public-abuse-protection.server";
import type { Route } from "./+types/application-form";

import {
  type ActionResult,
  applicationNoticeMatchesPortal,
  compatibleParticipantWorkspaceHref,
  handleAuthenticatedApplicationIntent,
  handleClaimedSpeakerIntent,
  handlePublicApplicationIntent,
  slugFrom,
  translateApplicationActionError,
} from "./application-form-intents.server";

export type { ActionResult };

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSubmissionForm(env);
  const service = new SubmissionService(env);
  const url = new URL(request.url);
  const claimToken = url.searchParams.get("claim");
  const claimSpeakerId = url.searchParams.get("speaker");
  try {
    const claimedSpeakerId = url.searchParams.get("claimedSpeaker");
    const portal = await service.getApplicantPortal(
      slugFrom(params),
      request,
      url.searchParams.get("draft"),
      claimToken && claimSpeakerId
        ? { speakerId: claimSpeakerId, rawToken: claimToken }
        : claimedSpeakerId
          ? { speakerId: claimedSpeakerId }
          : undefined,
    );
    const evaluationContext = await evaluationApplicantSessionContext(
      env,
      request,
      portal.form,
    );
    const isFixedEvaluationApplicant =
      portal.applicant?.verified === true &&
      portal.applicant.evaluation === true;
    const evaluationApplicantContext =
      evaluationContext && !isFixedEvaluationApplicant
        ? {
            identityLabel: evaluationContext.session.identityKey
              ? EVALUATION_IDENTITIES[evaluationContext.session.identityKey]
                  .label
              : null,
            verificationRequiresEvaluationLock: !evaluationContext.fixtureForm,
          }
        : null;
    const showLanding = !portal.applicant && !claimToken && !claimSpeakerId;
    const publishedProgramme = showLanding
      ? await new PublicProgrammeService(env).getPublishedLandingSummary(
          portal.form.eventSlug,
          portal.form.version.schema.presentation.showFeaturedSpeakers ? 8 : 0,
        )
      : null;
    const claimRecord =
      claimToken && claimSpeakerId
        ? await service.getCoSpeakerClaim(
            slugFrom(params),
            claimSpeakerId,
            claimToken,
          )
        : null;
    const claim = claimRecord
      ? {
          id: claimRecord.id,
          displayName: claimRecord.displayName,
          submissionTitle: claimRecord.submissionTitle,
          expired: claimRecord.expired,
        }
      : null;
    const needsAccessChallenge =
      portal.form.accessMode !== "account_required" &&
      !portal.applicant?.verified;
    const needsUploadChallenge =
      portal.selected?.status === "draft" &&
      portal.selectedForm.version.schema.fields.some(
        (field) => field.type === "video",
      );
    const abuseConfiguration =
      needsAccessChallenge || needsUploadChallenge
        ? publicAbuseClientConfiguration(env, request)
        : null;
    const turnstileSiteKey = needsAccessChallenge
      ? (abuseConfiguration?.turnstileSiteKey ?? null)
      : null;
    const uploadTurnstileSiteKey = needsUploadChallenge
      ? (abuseConfiguration?.turnstileSiteKey ?? null)
      : null;
    const noticeReceipt = await verifyApplicationNotice(
      env,
      url.searchParams.get("notice"),
      slugFrom(params),
    );
    const applicationNotice = applicationNoticeMatchesPortal(
      noticeReceipt,
      portal.selected,
    )
      ? noticeReceipt
      : null;
    const webhookWarning = applicationNotice?.webhookWarning ?? false;
    const realtimeWarning = applicationNotice?.realtimeWarning ?? false;
    const notice = webhookWarning
      ? "Your change was saved, but the organisers' systems could not be notified. They can retry the notification from Operations."
      : realtimeWarning
        ? "The application draft was permanently discarded, but other open views could not be updated automatically. Refresh them before continuing."
        : applicationNotice?.kind === "withdrawn"
          ? "This application was withdrawn. Its submitted snapshot remains in the audit history."
          : applicationNotice?.kind === "discarded"
            ? "The application draft was permanently discarded."
            : applicationNotice?.kind === "claimed"
              ? "Co-speaker invitation claimed. You now own this speaker profile."
              : applicationNotice?.kind === "profile_updated"
                ? "Your speaker profile was updated."
                : applicationNotice?.kind === "submission_blocked"
                  ? "Your latest changes were saved, but the draft was not submitted because a required form, routing or invitation setting changed. Review the current notice before trying again."
                  : applicationNotice?.kind === "submitted"
                    ? "Your application has been submitted."
                    : applicationNotice?.kind === "revised"
                      ? "Your revised application has been submitted."
                      : applicationNotice?.kind === "saved"
                        ? "Your draft has been saved."
                        : applicationNotice?.kind === "created"
                          ? "Your private draft has been created."
                          : "";
    const participantWorkspaceHref = await compatibleParticipantWorkspaceHref(
      env,
      request,
      portal,
    );
    return {
      ...portal,
      featuredSpeakers:
        publishedProgramme &&
        portal.form.version.schema.presentation.showFeaturedSpeakers
          ? publishedProgramme.speakers.map((speaker) => ({
              id: speaker.id,
              displayName: speaker.displayName,
              imageUrl: speaker.imageUrl,
              organisationName: speaker.organisationName,
              jobTitle: speaker.jobTitle,
            }))
          : [],
      programmeUrl: publishedProgramme
        ? `/public/programme/${encodeURIComponent(portal.form.eventSlug)}`
        : null,
      claim,
      claimRequested: Boolean(claimToken || claimSpeakerId),
      evaluationApplicantContext,
      turnstileSiteKey,
      uploadTurnstileSiteKey,
      noticeWarning: webhookWarning || realtimeWarning,
      noticeKind: applicationNotice?.kind ?? null,
      participantWorkspaceHref,
      intentId: crypto.randomUUID(),
      recoverySavedDraftId:
        portal.selected &&
        applicationNotice &&
        ["saved", "submitted", "revised", "submission_blocked"].includes(
          applicationNotice.kind,
        )
          ? portal.selected.id
          : null,
      discardedDraftRecoveryId:
        applicationNotice?.kind === "discarded"
          ? applicationNotice.submissionId
          : null,
      notice,
    };
  } catch (error) {
    if (error instanceof PublicFormUnavailableError) {
      return data({ unavailable: error.message }, { status: 410 });
    }
    if (
      error instanceof SubmissionStateError &&
      (claimToken || claimSpeakerId)
    ) {
      return data(
        { unavailable: "This co-speaker invitation is unavailable." },
        { status: 404 },
      );
    }
    throw error;
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;

  const { env } = getCloudflareContext(context);
  await ensureDemoSubmissionForm(env);
  const service = new SubmissionService(env);
  const slug = slugFrom(params);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  if (
    ![
      "request_code",
      "verify_code",
      "start_anonymous",
      "claim_token",
      "sign_out",
      "create_draft",
      "claim_speaker",
      "save_draft",
      "submit",
      "revise_submission",
      "withdraw",
      "discard_draft",
      "update_profile",
    ].includes(intent)
  ) {
    return data<ActionResult>(
      { ok: false, message: "Unsupported application action." },
      { status: 400 },
    );
  }
  if (
    [
      "start_anonymous",
      "claim_token",
      "create_draft",
      "save_draft",
      "submit",
      "revise_submission",
      "withdraw",
      "discard_draft",
      "update_profile",
    ].includes(intent)
  ) {
    // Validate signing before any mutation; a committed change must never be
    // followed by an unsigned or fabricated success acknowledgement.
    assertApplicationNoticeConfiguration(env);
  }
  try {
    const actionUrl = new URL(request.url);
    const claimedSpeakerId = actionUrl.searchParams.get("claimedSpeaker");
    const claimedSpeakerResponse = await handleClaimedSpeakerIntent({
      intent,
      actionUrl,
      request,
      claimedSpeakerId,
      formData,
      service,
      slug,
      env,
    });
    if (claimedSpeakerResponse) return claimedSpeakerResponse;
    const claimedSignOutContext =
      intent === "sign_out" && claimedSpeakerId
        ? await service.requireClaimedCoSpeakerContext(
            slug,
            claimedSpeakerId,
            request,
          )
        : null;
    const requestedSubmissionId = actionUrl.searchParams.get("draft");
    const discardSubmissionId =
      intent === "discard_draft"
        ? String(formData.get("submissionId") ?? "")
        : null;
    const discardRevision =
      intent === "discard_draft" ? Number(formData.get("revision")) : null;
    const form =
      claimedSignOutContext?.form ??
      (discardSubmissionId &&
      discardRevision !== null &&
      Number.isSafeInteger(discardRevision) &&
      discardRevision > 0
        ? await service.getDraftDiscardAccessForm(
            slug,
            discardSubmissionId,
            discardRevision,
          )
        : await service.getApplicantAccessForm(slug, requestedSubmissionId));
    const publicIntentResponse = await handlePublicApplicationIntent({
      intent,
      formData,
      form,
      request,
      requestedSubmissionId,
      service,
      slug,
      env,
      claimedSignOutContext,
      claimedSpeakerId,
    });
    if (publicIntentResponse) return publicIntentResponse;
    const applicant = await service.applicants.get(request, form, {
      ...(discardSubmissionId
        ? { committedDiscardId: discardSubmissionId }
        : {}),
    });
    if (!applicant)
      throw new Response("Verify your email before changing an application.", {
        status: 401,
      });
    return handleAuthenticatedApplicationIntent({
      intent,
      formData,
      form,
      applicant,
      service,
      slug,
      env,
    });
  } catch (error) {
    return translateApplicationActionError({
      error,
      intent,
      formData,
      env,
      slug,
    });
  }
}

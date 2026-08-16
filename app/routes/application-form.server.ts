import { data, redirect } from "react-router";
import { ZodError } from "zod";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  ApplicantConfigurationError,
  ApplicantDeliveryError,
  ApplicantInputError,
} from "~/modules/submissions/applicant-session.server";
import {
  type ApplicationNotice,
  assertApplicationNoticeConfiguration,
  createApplicationNotice,
  verifyApplicationNotice,
} from "~/modules/submissions/application-notice.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import {
  PublicFormUnavailableError,
  SubmissionService,
} from "~/modules/submissions/submission-service.server";
import { signOutSession } from "~/platform/auth/auth.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";
import {
  WebhookService,
  webhookActorForAudit,
} from "~/platform/operations/webhook-service.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/application-form";

export type ActionResult = {
  ok: boolean;
  stage?: "code";
  email?: string;
  demoCode?: string | null;
  message: string;
  committed?: boolean;
  submissionId?: string;
  revision?: number;
  errors?: Record<string, string[]>;
  conflict?: boolean;
};

function slugFrom(params: Route.LoaderArgs["params"]) {
  const slug = params.slug;
  if (!slug) throw new Response("Application form not found", { status: 404 });
  return slug;
}

function applicationNoticeMatchesPortal(
  notice: ApplicationNotice | null,
  selected: { id: string; status: string } | null | undefined,
) {
  if (!notice) return false;
  if (notice.submissionId === null)
    return notice.kind === "claimed" || notice.kind === "profile_updated";
  if (!selected || selected.id !== notice.submissionId) return false;
  if (["created", "saved", "submission_blocked"].includes(notice.kind))
    return selected.status === "draft";
  if (notice.kind === "withdrawn") return selected.status === "withdrawn";
  if (notice.kind === "submitted")
    return selected.status !== "draft" && selected.status !== "withdrawn";
  if (notice.kind === "revised") return selected.status === "submitted";
  return false;
}

async function applicationNoticeQuery(
  env: CloudflareEnvironment,
  input: Omit<ApplicationNotice, "version" | "expiresAt">,
) {
  return new URLSearchParams({
    ...(input.submissionId ? { draft: input.submissionId } : {}),
    notice: await createApplicationNotice(env, input),
  });
}

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
        ? publicAbuseClientConfiguration(env)
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
    const notice = webhookWarning
      ? "Your change was saved, but the organisers' systems could not be notified. They can retry the notification from Operations."
      : applicationNotice?.kind === "withdrawn"
        ? "This application was withdrawn. Its submitted snapshot remains in the audit history."
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
      turnstileSiteKey,
      uploadTurnstileSiteKey,
      noticeWarning: webhookWarning,
      intentId: crypto.randomUUID(),
      recoverySavedDraftId:
        portal.selected &&
        applicationNotice &&
        ["saved", "submitted", "revised", "submission_blocked"].includes(
          applicationNotice.kind,
        )
          ? portal.selected.id
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

class InvalidApplicationPayloadError extends Error {}

async function queueApplicantWebhook(
  env: CloudflareEnvironment,
  actor: { personId: string | null },
  scope: { organisationId: string; eventId: string },
  input: {
    eventType:
      | "submission.created"
      | "submission.submitted"
      | "submission.withdrawn"
      | "session.created";
    entityType: "submission" | "session";
    entityId: string;
    idempotencyKey: string;
    data: Record<string, unknown>;
  },
) {
  try {
    const deliveries = await new WebhookService(env).queueEvent(
      webhookActorForAudit(
        { ...scope, personId: actor.personId },
        "public_form",
      ),
      { ...input, correlationId: crypto.randomUUID() },
    );
    return deliveries.some((delivery) => delivery.status === "queue_failed")
      ? "One or more outbound webhook deliveries require a retry."
      : null;
  } catch (error) {
    console.error("Failed to record submission webhook event", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return "The outbound webhook event could not be recorded.";
  }
}

async function queueDraftCreatedWebhook(
  env: CloudflareEnvironment,
  eventId: string,
  actor: { personId: string | null },
  submissionId: string,
  anonymous: boolean,
) {
  try {
    const scope = await new SubmissionService(env).getApplicationEventScope(
      eventId,
    );
    return queueApplicantWebhook(env, actor, scope, {
      eventType: "submission.created",
      entityType: "submission",
      entityId: submissionId,
      idempotencyKey: `submission.created:${submissionId}`,
      data: {
        source: "public_application_form",
        status: "draft",
        anonymous,
      },
    });
  } catch (error) {
    console.error("Failed to resolve the draft webhook event scope", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return "The outbound webhook event could not be recorded.";
  }
}

function parsePayload(formData: FormData) {
  try {
    return {
      submissionId: formData.get("submissionId"),
      revision: formData.get("revision"),
      answers: JSON.parse(String(formData.get("answers") ?? "{}")),
      speakers: JSON.parse(String(formData.get("speakers") ?? "[]")),
      uploads: JSON.parse(String(formData.get("uploads") ?? "{}")),
    };
  } catch {
    throw new InvalidApplicationPayloadError(
      "This form could not be read. Refresh the page and try again.",
    );
  }
}

async function handleClaimedSpeakerIntent(input: {
  intent: string;
  actionUrl: URL;
  request: Request;
  claimedSpeakerId: string | null;
  formData: FormData;
  service: SubmissionService;
  slug: string;
  env: CloudflareEnvironment;
}) {
  const {
    intent,
    actionUrl,
    request,
    claimedSpeakerId,
    formData,
    service,
    slug,
    env,
  } = input;
  if (intent === "claim_token") {
    const speakerId = String(
      formData.get("speakerId") ?? actionUrl.searchParams.get("speaker") ?? "",
    );
    const rawToken = String(
      formData.get("claimToken") ?? actionUrl.searchParams.get("claim") ?? "",
    );
    const result = await service.claimCoSpeakerToken(slug, speakerId, rawToken);
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "claimed",
      submissionId: null,
      webhookWarning: false,
    });
    query.set("claimedSpeaker", speakerId);
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`, {
      headers: { "set-cookie": result.cookie },
    });
  }
  if (intent === "update_profile" && claimedSpeakerId) {
    await service.updateClaimedCoSpeakerProfile(
      slug,
      claimedSpeakerId,
      request,
      {
        revision: formData.get("revision"),
        name: formData.get("name"),
        biography: formData.get("biography"),
      },
    );
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "profile_updated",
      submissionId: null,
      webhookWarning: false,
    });
    query.set("claimedSpeaker", claimedSpeakerId);
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  return null;
}

function verificationStage(intent: string, formData: FormData) {
  return intent === "verify_code"
    ? {
        stage: "code" as const,
        email: String(formData.get("email") ?? ""),
      }
    : {};
}

async function translateApplicationActionError(input: {
  error: unknown;
  intent: string;
  formData: FormData;
  env: CloudflareEnvironment;
  slug: string;
}) {
  const { error, intent, formData, env, slug } = input;
  if (error instanceof Response) throw error;
  if (error instanceof ZodError) {
    return data<ActionResult>(
      {
        ok: false,
        ...verificationStage(intent, formData),
        message: "Complete the required application fields.",
        errors: error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  if (
    error instanceof ApplicantInputError ||
    error instanceof InvalidApplicationPayloadError
  ) {
    return data<ActionResult>(
      {
        ok: false,
        ...verificationStage(intent, formData),
        message: error.message,
      },
      { status: 400 },
    );
  }
  if (error instanceof AbuseRateLimitError) {
    return data<ActionResult>(
      {
        ok: false,
        ...verificationStage(intent, formData),
        message: error.message,
      },
      {
        status: 429,
        headers: { "retry-after": String(error.retryAfterSeconds) },
      },
    );
  }
  if (error instanceof TurnstileRejectedError) {
    return data<ActionResult>(
      {
        ok: false,
        ...verificationStage(intent, formData),
        message: error.message,
      },
      { status: 422 },
    );
  }
  if (
    error instanceof TurnstileUnavailableError ||
    error instanceof AbuseProtectionConfigurationError
  ) {
    console.error("Public application abuse protection failed", {
      errorName: error.name,
    });
    return data<ActionResult>(
      {
        ok: false,
        ...verificationStage(intent, formData),
        message:
          "The security check is temporarily unavailable. Try again later.",
      },
      { status: 503 },
    );
  }
  if (error instanceof SubmissionDraftSavedError) {
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "submission_blocked",
      submissionId: error.submissionId,
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  if (
    error instanceof SubmissionRevisionConflictError ||
    error instanceof SubmissionStateError ||
    error instanceof PublicFormUnavailableError
  ) {
    return data<ActionResult>(
      {
        ok: false,
        message: error.message,
        conflict: error instanceof SubmissionRevisionConflictError,
      },
      { status: 409 },
    );
  }
  if (
    error instanceof ApplicantConfigurationError ||
    error instanceof ApplicantDeliveryError
  ) {
    return data<ActionResult>(
      {
        ok: false,
        ...(intent === "request_code"
          ? {}
          : verificationStage(intent, formData)),
        message: error.message,
      },
      { status: 503 },
    );
  }
  throw error;
}

type ApplicationPublicForm = Awaited<
  ReturnType<SubmissionService["getPublicForm"]>
>;
type ApplicationApplicant = NonNullable<
  Awaited<ReturnType<SubmissionService["applicants"]["get"]>>
>;
type ClaimedSignOutContext = Awaited<
  ReturnType<SubmissionService["requireClaimedCoSpeakerContext"]>
> | null;

async function handlePublicApplicationIntent({
  intent,
  formData,
  form,
  request,
  service,
  slug,
  env,
  claimedSignOutContext,
  claimedSpeakerId,
}: {
  intent: string;
  formData: FormData;
  form: ApplicationPublicForm;
  request: Request;
  service: SubmissionService;
  slug: string;
  env: CloudflareEnvironment;
  claimedSignOutContext: ClaimedSignOutContext;
  claimedSpeakerId: string | null;
}) {
  if (intent === "request_code") {
    const email = String(formData.get("email") ?? "");
    await enforcePublicAbuseProtection({
      env,
      request,
      action: "application_request_code",
      tenantId: form.eventId,
      email,
      turnstileToken: String(formData.get("turnstile-token") ?? ""),
    });
    const result = await service.applicants.requestCode(
      form,
      email,
      String(formData.get("password") ?? ""),
      request,
    );
    return data<ActionResult>({
      ok: true,
      stage: "code",
      email: email.trim().toLowerCase(),
      demoCode: result.demoCode,
      message: result.demoCode
        ? "Demo verification is ready; no email was claimed as sent."
        : "Check your email for a six-digit verification code.",
    });
  }
  if (intent === "verify_code") {
    await enforcePublicAbuseProtection({
      env,
      request,
      action: "application_verify_code",
      tenantId: form.eventId,
      email: String(formData.get("email") ?? ""),
      turnstileToken: String(formData.get("turnstile-token") ?? ""),
    });
    const result = await service.applicants.verifyCode(
      form,
      String(formData.get("email") ?? ""),
      String(formData.get("code") ?? ""),
      request,
    );
    return redirect(`/apply/${encodeURIComponent(slug)}`, {
      headers: { "set-cookie": result.cookie },
    });
  }
  if (intent === "sign_out") {
    if (form.accessMode === "account_required") {
      const applicantCookie = await service.applicants.signOut(request, form);
      const result = await signOutSession(env, request);
      if (!result.ok) return result;
      const returnTo = claimedSignOutContext
        ? `/apply/${encodeURIComponent(slug)}?${new URLSearchParams({ claimedSpeaker: claimedSpeakerId! })}`
        : `/apply/${encodeURIComponent(slug)}`;
      const headers = new Headers(result.headers);
      headers.append("set-cookie", applicantCookie);
      return redirect(`/sign-in?${new URLSearchParams({ returnTo })}`, {
        status: 303,
        headers,
      });
    }
    return redirect(
      claimedSignOutContext ? "/" : `/apply/${encodeURIComponent(slug)}`,
      {
        headers: {
          "set-cookie": await service.applicants.signOut(request, form),
        },
      },
    );
  }
  if (intent === "start_anonymous") {
    await enforcePublicAbuseProtection({
      env,
      request,
      action: "application_start_anonymous",
      tenantId: form.eventId,
      email: "anonymous",
      turnstileToken: String(formData.get("turnstile-token") ?? ""),
    });
    const result = await service.startAnonymousDraft(
      slug,
      String(formData.get("password") ?? ""),
      String(formData.get("intentId") ?? ""),
    );
    const webhookWarning = await queueDraftCreatedWebhook(
      env,
      form.eventId,
      { personId: null },
      result.draftId,
      true,
    );
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "created",
      submissionId: result.draftId,
      webhookWarning: Boolean(webhookWarning),
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`, {
      headers: { "set-cookie": result.cookie },
    });
  }
  return null;
}

async function handleAuthenticatedApplicationIntent({
  intent,
  formData,
  form,
  applicant,
  service,
  slug,
  env,
}: {
  intent: string;
  formData: FormData;
  form: ApplicationPublicForm;
  applicant: ApplicationApplicant;
  service: SubmissionService;
  slug: string;
  env: CloudflareEnvironment;
}) {
  if (intent === "create_draft") {
    const id = await service.createDraft(
      slug,
      applicant,
      String(formData.get("intentId") ?? ""),
    );
    const webhookWarning = await queueDraftCreatedWebhook(
      env,
      form.eventId,
      { personId: applicant.personId },
      id,
      false,
    );
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "created",
      submissionId: id,
      webhookWarning: Boolean(webhookWarning),
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  if (intent === "claim_speaker") {
    await service.claimCoSpeaker(
      slug,
      applicant,
      String(formData.get("invitationId") ?? ""),
    );
    return redirect(`/apply/${encodeURIComponent(slug)}`);
  }
  if (intent === "update_profile") {
    await service.updateClaimedSpeakerProfile(slug, applicant, {
      revision: formData.get("revision"),
      name: formData.get("name"),
      biography: formData.get("biography"),
    });
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "profile_updated",
      submissionId: null,
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  if (intent === "withdraw") {
    if (formData.get("confirmWithdrawal") !== "yes") {
      return data<ActionResult>(
        {
          ok: false,
          message: "Confirm that you want to withdraw this application.",
        },
        { status: 422 },
      );
    }
    const result = await service.withdrawSubmission(slug, applicant, {
      submissionId: formData.get("submissionId"),
      revision: formData.get("revision"),
    });
    const [webhookWarning, realtimeFailure] = await Promise.all([
      queueApplicantWebhook(env, { personId: applicant.personId }, result, {
        eventType: "submission.withdrawn",
        entityType: "submission",
        entityId: result.submissionId,
        idempotencyKey: `submission.withdrawn:${result.submissionId}`,
        data: { status: "withdrawn", revision: result.revision },
      }),
      recordRouteChange(
        env,
        { organisationId: result.organisationId, eventId: result.eventId },
        {
          entityType: "submission",
          entityId: result.submissionId,
          changeType: "updated",
        },
      ),
    ]);
    const warnings = [webhookWarning, realtimeFailure?.message].filter(
      (warning): warning is string => Boolean(warning),
    );
    if (warnings.length) {
      return data<ActionResult>(
        {
          ok: false,
          committed: true,
          submissionId: result.submissionId,
          revision: result.revision,
          message: `Application withdrawn successfully. ${warnings.join(" ")}`,
        },
        { status: 207 },
      );
    }
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "withdrawn",
      submissionId: result.submissionId,
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  const payload = parsePayload(formData);
  if (intent === "save_draft") {
    await service.saveDraft(slug, applicant, payload);
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "saved",
      submissionId: String(payload.submissionId),
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  if (intent === "revise_submission") {
    if (formData.get("confirmRevision") !== "yes") {
      return data<ActionResult>(
        {
          ok: false,
          message: "Confirm that the revised application is ready to save.",
        },
        { status: 422 },
      );
    }
    const result = await service.reviseSubmitted(
      slug,
      applicant,
      payload,
      String(formData.get("intentId") ?? ""),
    );
    const realtimeFailure = await recordRouteChange(
      env,
      {
        organisationId: result.organisationId,
        eventId: result.eventId,
      },
      {
        entityType: "submission",
        entityId: result.submissionId,
        changeType: "updated",
      },
    );
    if (
      result.invitations.queueFailed > 0 ||
      result.webhookQueueFailed ||
      realtimeFailure
    ) {
      const warnings = [
        result.invitations.queueFailed > 0
          ? `${result.invitations.queueFailed} new co-speaker invitation${result.invitations.queueFailed === 1 ? "" : "s"} could not be queued; the saved operation requires attention.`
          : null,
        result.webhookQueueFailed
          ? "One or more outbound webhooks could not be queued."
          : null,
        realtimeFailure?.message ?? null,
      ].filter((warning): warning is string => Boolean(warning));
      return data<ActionResult>(
        {
          ok: false,
          committed: true,
          submissionId: result.submissionId,
          revision: result.revision,
          message: `Application revision saved successfully. ${warnings.join(" ")}`,
        },
        { status: 207 },
      );
    }
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "revised",
      submissionId: result.submissionId,
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  if (intent === "submit") {
    if (formData.get("confirm") !== "yes") {
      return data<ActionResult>(
        {
          ok: false,
          message: "Confirm that the application is ready to submit.",
        },
        { status: 422 },
      );
    }
    const result = await service.submitDraft(slug, applicant, payload);
    const webhookWarnings = await Promise.all([
      queueApplicantWebhook(env, { personId: applicant.personId }, result, {
        eventType: "submission.submitted",
        entityType: "submission",
        entityId: result.submissionId,
        idempotencyKey: `submission.submitted:${result.submissionId}`,
        data: {
          status: result.status,
          directSessionId: result.directSessionId,
        },
      }),
      result.directSessionId
        ? queueApplicantWebhook(env, { personId: applicant.personId }, result, {
            eventType: "session.created",
            entityType: "session",
            entityId: result.directSessionId,
            idempotencyKey: `session.created:${result.directSessionId}`,
            data: {
              source: "public_direct_session_form",
              intakeReference: result.submissionId,
            },
          })
        : Promise.resolve(null),
    ]);
    const realtimeFailure = await recordRouteChange(
      env,
      {
        organisationId: result.organisationId,
        eventId: result.eventId,
      },
      {
        entityType: "submission",
        entityId: result.submissionId,
        changeType: "created",
      },
    );
    if (
      result.confirmation.status === "queue_failed" ||
      result.invitations.queueFailed > 0 ||
      realtimeFailure ||
      webhookWarnings.some(Boolean)
    ) {
      const warnings = [
        result.confirmation.status === "queue_failed"
          ? "Its confirmation email could not be queued; the saved operation requires a retry."
          : null,
        result.invitations.queueFailed > 0
          ? `${result.invitations.queueFailed} co-speaker invitation${result.invitations.queueFailed === 1 ? "" : "s"} could not be queued; the saved operations require a retry.`
          : null,
        realtimeFailure?.message ?? null,
        ...webhookWarnings,
      ].filter((warning): warning is string => Boolean(warning));
      return data<ActionResult>(
        {
          ok: false,
          committed: true,
          submissionId: result.submissionId,
          message: `Application submitted successfully. ${warnings.join(" ")}`,
        },
        { status: 207 },
      );
    }
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "submitted",
      submissionId: String(payload.submissionId),
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  throw new Error("Application action dispatch reached an invalid state.");
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
    const form =
      claimedSignOutContext?.form ?? (await service.getPublicForm(slug));
    const publicIntentResponse = await handlePublicApplicationIntent({
      intent,
      formData,
      form,
      request,
      service,
      slug,
      env,
      claimedSignOutContext,
      claimedSpeakerId,
    });
    if (publicIntentResponse) return publicIntentResponse;
    const applicant = await service.applicants.get(request, form);
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

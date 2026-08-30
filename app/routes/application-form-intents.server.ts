import { data, redirect } from "react-router";
import { ZodError } from "zod";
import { requireValue } from "~/lib/required-value";
import {
  ApplicantConfigurationError,
  ApplicantDeliveryError,
  ApplicantInputError,
} from "~/modules/submissions/applicant-session.server";
import {
  type ApplicationNotice,
  type ApplicationNoticeInput,
  createApplicationNotice,
} from "~/modules/submissions/application-notice.server";
import {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import {
  PublicFormUnavailableError,
  SubmissionService,
} from "~/modules/submissions/submission-service.server";
import { createAuth, signOutSession } from "~/platform/auth/auth.server";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
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
  discardedDraftId?: string;
  revision?: number;
  errors?: Record<string, string[]>;
  conflict?: boolean;
};

export function slugFrom(params: Route.LoaderArgs["params"]) {
  const slug = params.slug;
  if (!slug) throw new Response("Application form not found", { status: 404 });
  return slug;
}

function appendApplicantCookies(headers: Headers, cookies: readonly string[]) {
  for (const cookie of cookies) {
    if (cookie) headers.append("set-cookie", cookie);
  }
}

function isDraftDiscardLockError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("application draft discard is in progress")
  );
}

function redirectWithApplicantCookies(
  location: string,
  cookies: readonly string[],
  init: { status?: number; headers?: HeadersInit } = {},
) {
  const headers = new Headers(init.headers);
  appendApplicantCookies(headers, cookies);
  return redirect(location, { ...init, headers });
}

export function applicationNoticeMatchesPortal(
  notice: ApplicationNotice | null,
  selected: { id: string; status: string } | null | undefined,
) {
  if (!notice) return false;
  if (notice.kind === "discarded") return notice.submissionId !== null;
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

export async function applicationNoticeQuery(
  env: CloudflareEnvironment,
  input: ApplicationNoticeInput,
) {
  return new URLSearchParams({
    ...(input.submissionId && input.kind !== "discarded"
      ? { draft: input.submissionId }
      : {}),
    notice: await createApplicationNotice(env, input),
  });
}

export async function compatibleParticipantWorkspaceHref(
  env: CloudflareEnvironment,
  request: Request,
  portal: Awaited<ReturnType<SubmissionService["getApplicantPortal"]>>,
) {
  const { applicant, selected } = portal;
  if (
    !applicant?.verified ||
    applicant.claimOnly ||
    applicant.evaluation ||
    !selected
  ) {
    return null;
  }
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session?.user?.emailVerified || session.user.id !== applicant.personId) {
    return null;
  }
  const membership = await env.DB.prepare(
    `SELECT 1 AS available
       FROM memberships
      WHERE event_id = ? AND person_id = ?
        AND role IN ('speaker','submitter')
        AND accepted_at IS NOT NULL AND revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(portal.form.eventId, applicant.personId)
    .first<{ available: number }>();
  if (!membership) return null;
  const returnTo = `/participant/applications?${new URLSearchParams({
    application: selected.id,
  })}#participant-application-detail`;
  return `/events/select?${new URLSearchParams({
    eventId: portal.form.eventId,
    returnTo,
  })}`;
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

export async function handleClaimedSpeakerIntent(input: {
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
    return redirectWithApplicantCookies(
      `/apply/${encodeURIComponent(slug)}?${query}`,
      result.setCookies,
    );
  }
  if (intent === "update_profile" && claimedSpeakerId) {
    await service.updateClaimedCoSpeakerProfile(
      slug,
      claimedSpeakerId,
      request,
      {
        revision: formData.get("revision"),
        name: formData.has("name") ? formData.get("name") : undefined,
        biography: formData.has("biography")
          ? formData.get("biography")
          : undefined,
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

export async function translateApplicationActionError(input: {
  error: unknown;
  intent: string;
  formData: FormData;
  env: CloudflareEnvironment;
  slug: string;
}) {
  const { error, intent, formData, env, slug } = input;
  const draftDiscardLocked = isDraftDiscardLockError(error);
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
    error instanceof PublicFormUnavailableError ||
    draftDiscardLocked
  ) {
    return data<ActionResult>(
      {
        ok: false,
        message: draftDiscardLocked
          ? "This application draft is being permanently discarded. Retry the discard to finish private-file erasure."
          : error instanceof Error
            ? error.message
            : "The application could not be changed.",
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

export async function handlePublicApplicationIntent({
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
}: {
  intent: string;
  formData: FormData;
  form: ApplicationPublicForm;
  request: Request;
  requestedSubmissionId: string | null;
  service: SubmissionService;
  slug: string;
  env: CloudflareEnvironment;
  claimedSignOutContext: ClaimedSignOutContext;
  claimedSpeakerId: string | null;
}) {
  const requestedApplicationPath = `/apply/${encodeURIComponent(slug)}${
    requestedSubmissionId
      ? `?${new URLSearchParams({ draft: requestedSubmissionId })}`
      : ""
  }`;
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
    return redirectWithApplicantCookies(
      requestedApplicationPath,
      result.setCookies,
    );
  }
  if (intent === "sign_out") {
    if (form.accessMode === "account_required") {
      const applicantCookie = await service.applicants.signOut(request, form);
      const result = await signOutSession(env, request);
      if (!result.ok) return result;
      const returnTo = claimedSignOutContext
        ? `/apply/${encodeURIComponent(slug)}?${new URLSearchParams({ claimedSpeaker: requireValue(claimedSpeakerId, "Required claimedSpeakerId is unavailable.") })}`
        : requestedApplicationPath;
      const headers = new Headers(result.headers);
      appendApplicantCookies(headers, applicantCookie);
      return redirect(`/sign-in?${new URLSearchParams({ returnTo })}`, {
        status: 303,
        headers,
      });
    }
    return redirectWithApplicantCookies(
      claimedSignOutContext ? "/" : requestedApplicationPath,
      await service.applicants.signOut(request, form),
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
    return redirectWithApplicantCookies(
      `/apply/${encodeURIComponent(slug)}?${query}`,
      result.setCookies,
    );
  }
  return null;
}

export async function handleAuthenticatedApplicationIntent({
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
      name: formData.has("name") ? formData.get("name") : undefined,
      biography: formData.has("biography")
        ? formData.get("biography")
        : undefined,
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
  if (intent === "discard_draft") {
    if (formData.get("confirmDiscard") !== "yes") {
      return data<ActionResult>(
        {
          ok: false,
          message: "Confirm that you want to permanently discard this draft.",
        },
        { status: 422 },
      );
    }
    const result = await service.discardDraft(slug, applicant, {
      submissionId: formData.get("submissionId"),
      revision: formData.get("revision"),
    });
    const realtimeFailure = await recordRouteChange(
      env,
      { organisationId: result.organisationId, eventId: result.eventId },
      {
        entityType: "submission",
        entityId: result.submissionId,
        changeType: "deleted",
      },
    );
    const query = await applicationNoticeQuery(env, {
      slug,
      kind: "discarded",
      submissionId: result.submissionId,
      webhookWarning: false,
      realtimeWarning: Boolean(realtimeFailure),
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
      submissionId: result.submissionId,
      webhookWarning: false,
    });
    return redirect(`/apply/${encodeURIComponent(slug)}?${query}`);
  }
  throw new Error("Application action dispatch reached an invalid state.");
}

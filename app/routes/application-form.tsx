import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/application-form";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import {
  ApplicantConfigurationError,
  ApplicantDeliveryError,
  ApplicantInputError,
} from "~/modules/submissions/applicant-session.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  assertApplicationNoticeConfiguration,
  createApplicationNotice,
  verifyApplicationNotice,
  type ApplicationNotice,
} from "~/modules/submissions/application-notice.server";
import {
  PublicFormUnavailableError,
  SubmissionService,
} from "~/modules/submissions/submission-service.server";
import {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type ApplicantDraft,
} from "~/modules/submissions/submission-repository.server";
import {
  visibleFields,
  type FormField,
} from "~/modules/submissions/submission-schema";
import { signOutSession } from "~/platform/auth/auth.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import { TurnstileWidget } from "~/components/turnstile-widget";
import {
  createProgramCueMultipartSession,
  readProgramCueMultipartResponse,
  type ProgramCueMultipartOperation,
  type ProgramCueMultipartRequest,
  type ProgramCueMultipartSession,
} from "~/modules/files/uppy-multipart-client";
import { maximumMegabytes } from "~/modules/files/file-policy";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";

export const meta: Route.MetaFunction = () => [
  { title: "Call for Speakers · Program Cue" },
];

type ActionResult = {
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
  try {
    const portal = await service.getApplicantPortal(
      slugFrom(params),
      request,
      url.searchParams.get("draft"),
    );
    const claimToken = url.searchParams.get("claim");
    const claimSpeakerId = url.searchParams.get("speaker");
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
      (!portal.applicant || !portal.applicant.verified);
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
      ? "This change is stored in D1, but its outbound webhook could not be recorded or queued. Check the integration operation before retrying."
      : applicationNotice?.kind === "withdrawn"
        ? "This application was withdrawn. Its submitted snapshot remains in the audit history."
        : applicationNotice?.kind === "claimed"
          ? "Co-speaker invitation claimed. You now own this speaker profile."
          : applicationNotice?.kind === "profile_updated"
            ? "Your speaker profile was updated."
            : applicationNotice?.kind === "submission_blocked"
              ? "Your latest changes were saved, but the draft was not submitted because a required form, routing or invitation setting changed. Review the current notice before trying again."
              : applicationNotice?.kind === "submitted"
                ? "This application is submitted and stored in D1."
                : applicationNotice?.kind === "saved"
                  ? "This draft is stored in D1."
                  : applicationNotice?.kind === "created"
                    ? "This private draft is stored in D1."
                    : "";
    return {
      ...portal,
      claim,
      claimRequested: Boolean(claimToken || claimSpeakerId),
      turnstileSiteKey,
      uploadTurnstileSiteKey,
      noticeWarning: webhookWarning,
      intentId: crypto.randomUUID(),
      recoverySavedDraftId:
        portal.selected &&
        applicationNotice &&
        ["saved", "submitted", "submission_blocked"].includes(
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
      { ...scope, personId: actor.personId },
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
      "The application payload is invalid. Refresh and try again.",
    );
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSubmissionForm(env);
  const service = new SubmissionService(env);
  const slug = slugFrom(params);
  const form = await service.getPublicForm(slug);
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
      "withdraw",
      "update_profile",
    ].includes(intent)
  ) {
    // Validate signing before any mutation; a committed change must never be
    // followed by an unsigned or fabricated success acknowledgement.
    assertApplicationNoticeConfiguration(env);
  }
  try {
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
        const returnTo = `/apply/${encodeURIComponent(slug)}`;
        const headers = new Headers(result.headers);
        headers.append("set-cookie", applicantCookie);
        return redirect(`/sign-in?${new URLSearchParams({ returnTo })}`, {
          status: 303,
          headers,
        });
      }
      return redirect(`/apply/${encodeURIComponent(slug)}`, {
        headers: {
          "set-cookie": await service.applicants.signOut(request, form),
        },
      });
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
    if (intent === "claim_token") {
      const actionUrl = new URL(request.url);
      const speakerId = String(
        formData.get("speakerId") ??
          actionUrl.searchParams.get("speaker") ??
          "",
      );
      const rawToken = String(
        formData.get("claimToken") ?? actionUrl.searchParams.get("claim") ?? "",
      );
      const result = await service.claimCoSpeakerToken(
        slug,
        speakerId,
        rawToken,
      );
      const query = await applicationNoticeQuery(env, {
        slug,
        kind: "claimed",
        submissionId: null,
        webhookWarning: false,
      });
      return redirect(`/apply/${encodeURIComponent(slug)}?${query}`, {
        headers: { "set-cookie": result.cookie },
      });
    }

    const applicant = await service.applicants.get(request, form);
    if (!applicant)
      throw new Response("Verify your email before changing an application.", {
        status: 401,
      });
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
          ? queueApplicantWebhook(
              env,
              { personId: applicant.personId },
              result,
              {
                eventType: "session.created",
                entityType: "session",
                entityId: result.directSessionId,
                idempotencyKey: `session.created:${result.directSessionId}`,
                data: {
                  source: "public_direct_session_form",
                  intakeReference: result.submissionId,
                },
              },
            )
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
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ZodError) {
      return data<ActionResult>(
        {
          ok: false,
          ...(intent === "verify_code"
            ? {
                stage: "code" as const,
                email: String(formData.get("email") ?? ""),
              }
            : {}),
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
          ...(intent === "verify_code"
            ? {
                stage: "code" as const,
                email: String(formData.get("email") ?? ""),
              }
            : {}),
          message: error.message,
        },
        { status: 400 },
      );
    }
    if (error instanceof AbuseRateLimitError) {
      return data<ActionResult>(
        {
          ok: false,
          ...(intent === "verify_code"
            ? {
                stage: "code" as const,
                email: String(formData.get("email") ?? ""),
              }
            : {}),
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
          ...(intent === "verify_code"
            ? {
                stage: "code" as const,
                email: String(formData.get("email") ?? ""),
              }
            : {}),
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
          ...(intent === "verify_code"
            ? {
                stage: "code" as const,
                email: String(formData.get("email") ?? ""),
              }
            : {}),
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
            : intent === "verify_code"
              ? {
                  stage: "code" as const,
                  email: String(formData.get("email") ?? ""),
                }
              : {}),
          message: error.message,
        },
        { status: 503 },
      );
    }
    throw error;
  }
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
  invalid = false,
  describedBy,
  required = field.required,
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange(value: string | string[]): void;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
}) {
  const common = {
    id: `answer-${field.id}`,
    name: `answer-${field.id}`,
    disabled,
    required,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  if (field.type === "long_text")
    return (
      <textarea
        {...common}
        className="textarea"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        maxLength={5_000}
      />
    );
  if (field.type === "select")
    return (
      <select
        {...common}
        className="select"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  if (field.type === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="stack">
        {field.options.map((option) => (
          <label key={option} className="toggle">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option]
                    : selected.filter((item) => item !== option),
                )
              }
            />{" "}
            {option}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      {...common}
      className="field"
      type={field.type === "url" || field.type === "video" ? "url" : "text"}
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
      maxLength={field.id === "title" ? 180 : 5_000}
    />
  );
}

function AccessPanel({
  loaderData,
  actionData,
}: {
  loaderData: Extract<Awaited<ReturnType<typeof loader>>, { form: unknown }>;
  actionData?: ActionResult;
}) {
  const form = loaderData.form;
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  if (form.accessMode === "account_required") {
    const returnTo = `/apply/${encodeURIComponent(form.publicSlug)}`;
    return (
      <section
        className="card pad"
        style={{ maxWidth: 560, margin: "48px auto" }}
      >
        <span className="status info">Account required</span>
        <h1 className="mt">Sign in to apply</h1>
        <p className="subtle">
          This organiser requires a verified Program Cue account before
          applications can be created.
        </p>
        <Link
          className="btn primary"
          to={`/sign-in?${new URLSearchParams({ returnTo })}`}
        >
          Continue to sign in
        </Link>
      </section>
    );
  }
  if (actionData?.stage === "code") {
    return (
      <section
        className="card pad"
        style={{ maxWidth: 560, margin: "48px auto" }}
      >
        <span className="status success">Email accepted</span>
        <h1 className="mt">Enter your verification code</h1>
        <p className="subtle">
          We use this to keep your drafts private and connect multiple
          applications to you.
        </p>
        {!actionData.ok ? (
          <div className="validation-item error mb" role="alert">
            <strong>△</strong>
            <span>{actionData.message}</span>
          </div>
        ) : null}
        {actionData.demoCode ? (
          <div className="validation-item warn mb">
            <strong>Demo only</strong>
            <span>
              Use code <code>{actionData.demoCode}</code>. No email was sent.
            </span>
          </div>
        ) : null}
        <Form method="post" className="stack">
          <input type="hidden" name="_intent" value="verify_code" />
          <input type="hidden" name="email" value={actionData.email} />
          <label className="label">
            Six-digit code
            <input
              className="field"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </label>
          <TurnstileWidget
            siteKey={loaderData.turnstileSiteKey}
            action="application_verify_code"
          />
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify and open drafts"}
          </button>
        </Form>
      </section>
    );
  }
  return (
    <section
      className="card pad"
      style={{ maxWidth: 560, margin: "48px auto" }}
    >
      <span className="status info">Private drafts</span>
      <h1 className="mt">{form.name}</h1>
      <p>{form.version.schema.introduction}</p>
      <p className="subtle">
        {form.allowAnonymousDrafts
          ? "Start a private draft now, then verify your email before final submission."
          : "Verify your email before saving or submitting. Your code expires after ten minutes."}
      </p>
      {actionData && !actionData.ok ? (
        <div className="validation-item error mb" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {form.allowAnonymousDrafts ? (
        <Form method="post" className="stack mb">
          <input type="hidden" name="_intent" value="start_anonymous" />
          <input
            type="hidden"
            name="intentId"
            value={`${loaderData.intentId}:anonymous`}
          />
          {form.accessMode === "password_protected" ? (
            <label className="label">
              Form password
              <input
                className="field"
                name="password"
                type="password"
                required
              />
            </label>
          ) : null}
          <TurnstileWidget
            siteKey={loaderData.turnstileSiteKey}
            action="application_start_anonymous"
          />
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? "Starting…" : "Start a draft"}
          </button>
        </Form>
      ) : null}
      <div className="divider" />
      <Form method="post" className="stack mt">
        <input type="hidden" name="_intent" value="request_code" />
        <label className="label">
          Email address
          <input
            className="field"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </label>
        {form.accessMode === "password_protected" ? (
          <label className="label">
            Form password
            <input className="field" name="password" type="password" required />
          </label>
        ) : null}
        <TurnstileWidget
          siteKey={loaderData.turnstileSiteKey}
          action="application_request_code"
        />
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Requesting code…" : "Send verification code"}
        </button>
      </Form>
    </section>
  );
}

function AnonymousVerificationPanel({
  form,
  actionData,
  turnstileSiteKey,
}: {
  form: Extract<Awaited<ReturnType<typeof loader>>, { form: unknown }>["form"];
  actionData?: ActionResult;
  turnstileSiteKey: string | null;
}) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  return (
    <section className="card pad mb">
      <div className="card-title">
        <div>
          <span className="status warning">Verification required</span>
          <h2 className="mt">Protect and submit this draft</h2>
        </div>
      </div>
      <p className="subtle">
        Your anonymous browser session can save this draft for 14 days. Verify
        an email address before final submission or to recover it after this
        browser session ends.
      </p>
      {actionData?.stage === "code" ? (
        <Form method="post" className="stack">
          <input type="hidden" name="_intent" value="verify_code" />
          <input type="hidden" name="email" value={actionData.email} />
          {actionData.demoCode ? (
            <div className="validation-item warn">
              <strong>Demo only</strong>
              <span>
                Use code <code>{actionData.demoCode}</code>. No email was sent.
              </span>
            </div>
          ) : null}
          {!actionData.ok ? (
            <div className="validation-item error" role="alert">
              <strong>△</strong>
              <span>{actionData.message}</span>
            </div>
          ) : null}
          <label className="label">
            Six-digit code
            <input
              className="field"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              required
            />
          </label>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action="application_verify_code"
          />
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify email"}
          </button>
        </Form>
      ) : (
        <Form method="post" className="form-row">
          <input type="hidden" name="_intent" value="request_code" />
          <label className="label">
            Email address
            <input
              className="field"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action="application_request_code"
          />
          <button
            className="btn primary"
            style={{ alignSelf: "end" }}
            type="submit"
            disabled={pending}
          >
            {pending ? "Sending…" : "Send verification code"}
          </button>
        </Form>
      )}
    </section>
  );
}

function SpeakerProfilePanel({
  profile,
}: {
  profile: { name: string; biography: string; revision: number };
}) {
  const navigation = useNavigation();
  return (
    <details className="card pad mb">
      <summary>
        <strong>Your claimed speaker profile</strong>{" "}
        <span className="subtle">Edit the biography you own</span>
      </summary>
      <Form method="post" className="stack mt">
        <input type="hidden" name="_intent" value="update_profile" />
        <input type="hidden" name="revision" value={profile.revision} />
        <label className="label">
          Display name
          <input
            className="field"
            name="name"
            defaultValue={profile.name}
            required
          />
        </label>
        <label className="label">
          Biography
          <textarea
            className="textarea"
            name="biography"
            maxLength={5_000}
            defaultValue={profile.biography}
          />
        </label>
        <button
          className="btn primary"
          type="submit"
          disabled={navigation.state !== "idle"}
        >
          {navigation.formData?.get("_intent") === "update_profile"
            ? "Saving…"
            : "Save my profile"}
        </button>
      </Form>
    </details>
  );
}

function ClaimPanel({
  claim,
  actionData,
}: {
  claim: {
    id: string;
    displayName: string;
    submissionTitle: string;
    expired: boolean;
  } | null;
  actionData?: ActionResult;
}) {
  const navigation = useNavigation();
  return (
    <section
      className="card pad"
      style={{ maxWidth: 620, margin: "48px auto" }}
    >
      <span
        className={`status ${claim && !claim.expired ? "success" : "warning"}`}
      >
        Co-speaker invitation
      </span>
      {actionData && !actionData.ok ? (
        <div className="validation-item error mt" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {claim ? (
        <>
          <h1 className="mt">Join {claim.submissionTitle}</h1>
          <p>
            This invitation is for <strong>{claim.displayName}</strong>.
            Claiming it verifies the invited email address and gives you
            ownership of your speaker profile.
          </p>
          {claim.expired ? (
            <div className="validation-item warn" role="alert">
              <strong>Expired</strong>
              <span>Ask an administrator to resend this invitation.</span>
            </div>
          ) : (
            <Form method="post">
              <input type="hidden" name="_intent" value="claim_token" />
              <input type="hidden" name="speakerId" value={claim.id} />
              <button
                className="btn primary"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                {navigation.state === "submitting"
                  ? "Claiming…"
                  : "Claim speaker profile"}
              </button>
            </Form>
          )}
        </>
      ) : (
        <>
          <h1 className="mt">Invitation unavailable</h1>
          <p className="subtle">
            This claim link is invalid, expired or was replaced by a newer
            invitation. Ask an administrator to resend it.
          </p>
        </>
      )}
    </section>
  );
}

type ApplicantVideoUploadRecord = {
  fieldId: string;
  assetId: string;
  versionId: string;
  filename: string;
  sizeBytes: number;
  status: "uploading" | "scanning" | "ready" | "rejected";
};

type ApplicantVideoOperationRef = { current: symbol | null };

export function claimApplicantVideoUploadOperation(
  uploadOperation: ApplicantVideoOperationRef,
  cancellationOperation: ApplicantVideoOperationRef,
  hasActiveSession: boolean,
): symbol | null {
  if (
    uploadOperation.current ||
    cancellationOperation.current ||
    hasActiveSession
  ) {
    return null;
  }
  const operation = Symbol("applicant-video-upload");
  uploadOperation.current = operation;
  return operation;
}

async function applicantMultipartRequest<T>(
  publicSlug: string,
  operation: ProgramCueMultipartOperation,
  body: Record<string, unknown>,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) {
  const response = await fetch(
    `/apply/${encodeURIComponent(publicSlug)}/files/multipart/${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options?.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    },
  );
  return readProgramCueMultipartResponse<T>(
    response,
    operation,
    "Video upload request",
  );
}

function ApplicantVideoUpload({
  publicSlug,
  submissionId,
  fieldId,
  current,
  siteKey,
  disabled,
  maximumBytes,
  onReferenceChange,
}: {
  publicSlug: string;
  submissionId: string;
  fieldId: string;
  current: ApplicantVideoUploadRecord | null;
  siteKey: string | null;
  disabled: boolean;
  maximumBytes: number;
  onReferenceChange(reference: { assetId: string; versionId: string }): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSession = useRef<ProgramCueMultipartSession | null>(null);
  const completedUpload = useRef<{
    assetId: string;
    versionId: string;
  } | null>(null);
  const uploadOperation = useRef<symbol | null>(null);
  const cancellationOperation = useRef<symbol | null>(null);
  const [cancellationInFlight, setCancellationInFlight] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<{
    status: "idle" | "uploading" | "paused" | "error" | "scanning" | "ready";
    message: string;
  }>(() => {
    if (current?.status === "ready")
      return {
        status: "ready",
        message: `${current.filename} passed security validation and is ready to submit.`,
      };
    if (current?.status === "scanning")
      return {
        status: "scanning",
        message: `${current.filename} is quarantined while its security scan finishes.`,
      };
    if (current?.status === "uploading")
      return {
        status: "error",
        message: `${current.filename} did not finish uploading. Re-select the same file to resume its uploaded parts, or choose a replacement.`,
      };
    if (current?.status === "rejected")
      return {
        status: "error",
        message: `${current.filename} did not pass upload or security validation. Upload a replacement.`,
      };
    return { status: "idle", message: "" };
  });

  useEffect(
    () => () => {
      uploadOperation.current = null;
      cancellationOperation.current = null;
      uploadSession.current?.disposePreservingUpload();
    },
    [],
  );
  useEffect(() => {
    const completed = completedUpload.current;
    const active = uploadSession.current;
    if (
      !completed ||
      !active ||
      current?.assetId !== completed.assetId ||
      current.versionId !== completed.versionId
    )
      return;
    active.markAttached();
    active.disposePreservingUpload();
    completedUpload.current = null;
    uploadSession.current = null;
  }, [current?.assetId, current?.versionId]);

  async function cancel() {
    const active = uploadSession.current;
    if (!active || cancellationOperation.current) return;
    const operation = Symbol("applicant-video-cancellation");
    cancellationOperation.current = operation;
    uploadOperation.current = null;
    setCancellationInFlight(true);
    try {
      await active.cancel();
      if (uploadSession.current === active) uploadSession.current = null;
      setState({ status: "error", message: "Video upload cancelled." });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The upload stopped, but its R2 cleanup did not finish.",
      });
    } finally {
      if (cancellationOperation.current === operation) {
        cancellationOperation.current = null;
        setCancellationInFlight(false);
      }
    }
  }

  function pauseResume() {
    const active = uploadSession.current;
    if (!active || cancellationOperation.current) return;
    const paused = active.pauseResume();
    setState({
      status: paused ? "paused" : "uploading",
      message: paused
        ? "Video upload paused. Resume to continue from the parts already in private storage."
        : "Resuming the private video upload…",
    });
  }

  async function finishVideoTransfer(
    active: ProgramCueMultipartSession,
    operation: symbol,
  ) {
    const completed = await active.upload();
    if (uploadOperation.current !== operation) {
      active.disposePreservingUpload();
      return;
    }
    completedUpload.current = completed;
    active.disposePreservingUpload();
    onReferenceChange({
      assetId: completed.assetId,
      versionId: completed.versionId,
    });
    setState({
      status: "scanning",
      message:
        "Upload complete. The video remains private and cannot be submitted until its security scan passes.",
    });
  }

  async function resumeFailedTransfer() {
    const active = uploadSession.current;
    if (
      !active ||
      uploadOperation.current ||
      cancellationOperation.current ||
      state.status !== "error"
    )
      return;
    const operation = Symbol("applicant-video-upload-resume");
    uploadOperation.current = operation;
    setState({
      status: "uploading",
      message: "Resuming the private video upload…",
    });
    try {
      await finishVideoTransfer(active, operation);
    } catch (error) {
      if (uploadOperation.current !== operation) return;
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Video upload failed.",
      });
    } finally {
      if (uploadOperation.current === operation) {
        uploadOperation.current = null;
      }
    }
  }

  async function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file || file.size < 1) {
      setState({
        status: "error",
        message: "Choose a non-empty MP4 or WebM video.",
      });
      return;
    }
    if (!(["video/mp4", "video/webm"] as string[]).includes(file.type)) {
      setState({
        status: "error",
        message: "Video uploads must be MP4 or WebM.",
      });
      return;
    }
    if (file.size > maximumBytes) {
      setState({
        status: "error",
        message: `Video uploads cannot exceed this event's ${maximumMegabytes(maximumBytes)} MB limit.`,
      });
      return;
    }
    if (siteKey && !turnstileToken) {
      setState({
        status: "error",
        message: "Complete the security check before starting the upload.",
      });
      return;
    }
    const operation = claimApplicantVideoUploadOperation(
      uploadOperation,
      cancellationOperation,
      Boolean(uploadSession.current),
    );
    if (!operation) return;
    try {
      setProgress(0);
      setState({
        status: "uploading",
        message: "Checking for a resumable private video upload…",
      });
      const request: ProgramCueMultipartRequest = (operation, body, options) =>
        applicantMultipartRequest(
          publicSlug,
          operation,
          {
            submissionId,
            fieldId,
            ...body,
            ...(operation === "initiate" ? { turnstileToken } : {}),
          },
          options,
        );
      const active = await createProgramCueMultipartSession({
        file,
        assetKind: "video",
        resumeScope: `applicant:${publicSlug}:${submissionId}:${fieldId}`,
        request,
        onProgress: (percentage) => {
          if (uploadOperation.current !== operation) return;
          setProgress(percentage);
          setState({
            status: "uploading",
            message: `Uploading the private video with Uppy… ${percentage}%`,
          });
        },
        onPauseChange: (paused) => {
          if (uploadOperation.current !== operation) return;
          if (!paused) return;
          setState({
            status: "paused",
            message:
              "Video upload paused. Resume to continue from the parts already in private storage.",
          });
        },
      });
      if (uploadOperation.current !== operation) {
        active.disposePreservingUpload();
        return;
      }
      uploadSession.current = active;
      setState({
        status: "uploading",
        message: "Uploading the private video with Uppy…",
      });
      await finishVideoTransfer(active, operation);
    } catch (error) {
      if (uploadOperation.current !== operation) return;
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Video upload failed.",
      });
    } finally {
      if (uploadOperation.current === operation) {
        uploadOperation.current = null;
      }
      setTurnstileToken("");
      setTurnstileResetKey((value) => value + 1);
    }
  }

  const uploading = state.status === "uploading";
  const transferActive = uploading || state.status === "paused";
  const uploadBlocked =
    disabled ||
    transferActive ||
    cancellationInFlight ||
    Boolean(uploadSession.current) ||
    Boolean(uploadOperation.current);
  return (
    <div className="card pad mt stack">
      <div>
        <strong>Private native video</strong>
        <p className="help">
          Upload MP4 or WebM directly to private storage. Files up to{" "}
          {maximumMegabytes(maximumBytes)} MB use resumable Uppy multipart
          transfer and remain quarantined until scanned.
        </p>
      </div>
      <input
        ref={fileInput}
        className="field"
        type="file"
        accept="video/mp4,video/webm,.mp4,.webm"
        disabled={uploadBlocked}
        aria-label="Choose an MP4 or WebM pitch video"
      />
      <TurnstileWidget
        siteKey={siteKey}
        action="application_file_upload"
        onTokenChange={setTurnstileToken}
        resetKey={turnstileResetKey}
      />
      {transferActive ? (
        <progress max={100} value={progress} aria-label="Video upload progress">
          {progress}%
        </progress>
      ) : null}
      <div className="page-actions">
        <button
          className="btn"
          type="button"
          disabled={uploadBlocked}
          onClick={upload}
        >
          {current ? "Upload replacement" : "Upload video"}
        </button>
        {transferActive ? (
          <button
            className="btn"
            type="button"
            disabled={cancellationInFlight}
            onClick={pauseResume}
          >
            {state.status === "paused" ? "Resume upload" : "Pause upload"}
          </button>
        ) : null}
        {transferActive ? (
          <button
            className="btn danger"
            type="button"
            disabled={cancellationInFlight}
            onClick={cancel}
          >
            {cancellationInFlight ? "Cancelling…" : "Cancel upload"}
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        uploadSession.current ? (
          <button
            className="btn"
            type="button"
            disabled={cancellationInFlight}
            onClick={resumeFailedTransfer}
          >
            Resume upload
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        uploadSession.current ? (
          <button
            className="btn danger"
            type="button"
            disabled={cancellationInFlight}
            onClick={cancel}
          >
            {cancellationInFlight ? "Cancelling…" : "Cancel upload"}
          </button>
        ) : null}
        {state.status === "scanning" ? (
          <button
            className="btn"
            type="button"
            onClick={() => window.location.reload()}
          >
            Refresh scan status
          </button>
        ) : null}
      </div>
      {state.message ? (
        <div
          className={`validation-item ${state.status === "error" ? "error" : state.status === "ready" ? "ok" : "warn"}`}
          role={state.status === "error" ? "alert" : "status"}
        >
          <strong>
            {state.status === "ready"
              ? "Ready"
              : state.status === "error"
                ? "Upload issue"
                : "Private video"}
          </strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </div>
  );
}

function DraftEditor({
  draft,
  schema,
  applicant,
  publicSlug,
  currentUpload,
  uploadTurnstileSiteKey,
  maximumVideoBytes,
  recoveryPersonId,
  recoveryEventId,
  serverSaved,
  conflict,
  maxSpeakers,
  errors,
  canSubmit = true,
  timezone,
}: {
  draft: ApplicantDraft;
  schema: Route.ComponentProps["loaderData"] extends infer _
    ? Array<FormField>
    : never;
  applicant: { name: string; email: string; verified: boolean };
  publicSlug: string;
  currentUpload: ApplicantVideoUploadRecord | null;
  uploadTurnstileSiteKey: string | null;
  maximumVideoBytes: number;
  recoveryPersonId: string;
  recoveryEventId: string;
  serverSaved: boolean;
  conflict: boolean;
  maxSpeakers: number | null;
  errors?: Record<string, string[]>;
  canSubmit?: boolean;
  timezone: string;
}) {
  const navigation = useNavigation();
  const [answers, setAnswers] = useState(draft.answers);
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
  const readOnly = draft.status !== "draft";
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
  const fields = visibleFields({ introduction: "", fields: schema }, answers);

  return (
    <Form method="post" className="stack" onChange={() => setDirty(true)}>
      <input type="hidden" name="submissionId" value={draft.id} />
      <input type="hidden" name="revision" value={draft.revision} />
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      <input type="hidden" name="speakers" value={JSON.stringify(speakers)} />
      <input type="hidden" name="uploads" value={JSON.stringify(uploads)} />
      <div className="card-title">
        <div>
          <span
            className={`status ${draft.status === "draft" ? "info" : draft.status === "withdrawn" ? "warning" : "success"}`}
          >
            {draft.status}
          </span>
          <h1 className="mt">{draft.title}</h1>
        </div>
        <span className="subtle right">Form version {draft.versionNumber}</span>
      </div>
      <DraftRecoveryFeedback recovery={recovery} className="" />
      {errors && Object.keys(errors).length ? (
        <div className="validation-item error" role="alert">
          <strong>Review required</strong>
          <span>{Object.values(errors).flat()[0]}</span>
        </div>
      ) : null}
      {fields.map((field) => {
        const error = errors?.[field.id]?.[0];
        const helpId = field.help ? `answer-${field.id}-help` : undefined;
        const errorId = error ? `answer-${field.id}-error` : undefined;
        const describedBy =
          [helpId, errorId].filter(Boolean).join(" ") || undefined;
        const update = (value: string | string[]) => {
          setAnswers((current) => ({ ...current, [field.id]: value }));
          setDirty(true);
        };
        if (field.type === "video")
          return (
            <fieldset
              className="application-choice-field"
              key={field.id}
              aria-required={field.required || undefined}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.help ? (
                <span className="help" id={helpId}>
                  {field.help}
                </span>
              ) : null}
              <label className="label" htmlFor={`answer-${field.id}`}>
                HTTPS video link
                <FieldControl
                  field={field}
                  value={answers[field.id]}
                  disabled={readOnly}
                  required={field.required && !uploads[field.id]}
                  invalid={Boolean(error)}
                  describedBy={describedBy}
                  onChange={update}
                />
              </label>
              {!readOnly ? (
                <ApplicantVideoUpload
                  publicSlug={publicSlug}
                  submissionId={draft.id}
                  fieldId={field.id}
                  current={
                    currentUpload?.fieldId === field.id ? currentUpload : null
                  }
                  siteKey={uploadTurnstileSiteKey}
                  disabled={readOnly}
                  maximumBytes={maximumVideoBytes}
                  onReferenceChange={(reference) => {
                    setUploads((current) => ({
                      ...current,
                      [field.id]: reference,
                    }));
                    setDirty(true);
                  }}
                />
              ) : uploads[field.id] ? (
                <div className="validation-item ok mt">
                  <strong>Private video attached</strong>
                  <span>
                    The immutable submission references its scanned file
                    version.
                  </span>
                </div>
              ) : null}
              {error ? (
                <span className="field-error" id={errorId}>
                  {error}
                </span>
              ) : null}
            </fieldset>
          );
        if (field.type === "multi_select")
          return (
            <fieldset
              className="application-choice-field"
              key={field.id}
              aria-required={field.required || undefined}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
            >
              <legend className="label">
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.help ? (
                <span className="help" id={helpId}>
                  {field.help}
                </span>
              ) : null}
              <FieldControl
                field={field}
                value={answers[field.id]}
                disabled={readOnly}
                invalid={Boolean(error)}
                describedBy={describedBy}
                onChange={update}
              />
              {error ? (
                <span className="field-error" id={errorId}>
                  {error}
                </span>
              ) : null}
            </fieldset>
          );
        return (
          <label
            className="label"
            key={field.id}
            htmlFor={`answer-${field.id}`}
          >
            {field.label}
            {field.required ? " *" : ""}
            {field.help ? (
              <span className="help" id={helpId}>
                {field.help}
              </span>
            ) : null}
            <FieldControl
              field={field}
              value={answers[field.id]}
              disabled={readOnly}
              invalid={Boolean(error)}
              describedBy={describedBy}
              onChange={update}
            />
            {error ? (
              <span className="field-error" id={errorId}>
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      <fieldset className="card pad">
        <legend>
          <strong>Speakers</strong>
        </legend>
        <p className="subtle">
          The first speaker is primary. Additional speakers receive a pending
          claim relationship and an expiring invitation after final submission.
        </p>
        {speakers.map((speaker, index) => (
          <div className="form-row mb" key={index}>
            <label className="label">
              Speaker {index + 1} name
              <input
                className="field"
                disabled={
                  readOnly ||
                  (index > 0 && speaker.invitationStatus === "claimed")
                }
                required
                value={speaker.name}
                onChange={(event) => {
                  const next = [...speakers];
                  next[index] = { ...speaker, name: event.target.value };
                  setSpeakers(next);
                  setDirty(true);
                }}
              />
            </label>
            <label className="label">
              Email
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="field"
                  type="email"
                  disabled={
                    readOnly ||
                    (index === 0 && applicant.verified) ||
                    (index > 0 && speaker.invitationStatus === "claimed")
                  }
                  required
                  value={speaker.email}
                  onChange={(event) => {
                    const next = [...speakers];
                    next[index] = { ...speaker, email: event.target.value };
                    setSpeakers(next);
                    setDirty(true);
                  }}
                />
                {index > 0 &&
                !readOnly &&
                speaker.invitationStatus !== "claimed" ? (
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`Remove speaker ${index + 1}`}
                    onClick={() => {
                      setSpeakers(
                        speakers.filter((_, itemIndex) => itemIndex !== index),
                      );
                      setDirty(true);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </label>
            <label className="label">
              Biography
              <textarea
                className="textarea"
                disabled={
                  readOnly ||
                  (index > 0 && speaker.invitationStatus === "claimed")
                }
                maxLength={5_000}
                value={speaker.biography}
                onChange={(event) => {
                  const next = [...speakers];
                  next[index] = {
                    ...speaker,
                    biography: event.target.value,
                  };
                  setSpeakers(next);
                  setDirty(true);
                }}
              />
              {index > 0 && speaker.invitationStatus === "claimed" ? (
                <span className="help">
                  This co-speaker owns their claimed profile. They can update it
                  below.
                </span>
              ) : null}
            </label>
          </div>
        ))}
        {!readOnly &&
        (maxSpeakers === null || speakers.length < maxSpeakers) ? (
          <button
            className="btn small"
            type="button"
            onClick={() => {
              setSpeakers([
                ...speakers,
                {
                  name: "",
                  email: "",
                  biography: "",
                  invitationStatus: "pending",
                },
              ]);
              setDirty(true);
            }}
          >
            + Add co-speaker
          </button>
        ) : !readOnly && maxSpeakers !== null ? (
          <span className="help">
            This form allows at most {maxSpeakers} speaker
            {maxSpeakers === 1 ? "" : "s"}.
          </span>
        ) : null}
        {errors?.speakers ? (
          <span className="field-error">{errors.speakers[0]}</span>
        ) : null}
      </fieldset>
      {!readOnly ? (
        <>
          <div className="validation-item warn">
            <strong>Before submitting</strong>
            <span>
              Final submission freezes this form-version snapshot. You can still
              view it afterward.
            </span>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              name="confirm"
              value="yes"
              required
              disabled={!canSubmit}
            />{" "}
            I have reviewed this application and am ready to submit it.
          </label>
          <div className="page-actions">
            <span className={`status ${dirty ? "warning" : "success"}`}>
              {dirty ? "Unsaved changes" : "Loaded from D1"}
            </span>
            <DraftRecoveryStatus state={recovery.state} />
            <button
              className="btn"
              type="submit"
              name="_intent"
              value="save_draft"
              formNoValidate
              disabled={navigation.state !== "idle"}
            >
              {navigation.formData?.get("_intent") === "save_draft"
                ? "Saving…"
                : "Save draft"}
            </button>
            <button
              className="btn primary"
              type="submit"
              name="_intent"
              value="submit"
              disabled={navigation.state !== "idle" || !canSubmit}
            >
              {navigation.formData?.get("_intent") === "submit"
                ? "Submitting…"
                : "Submit application"}
            </button>
          </div>
          {conflict ? (
            <div className="validation-item error" role="alert">
              <strong>Draft conflict</strong>
              <span>
                The browser recovery copy is intact. Export it or explicitly
                load the newer server revision; nothing was overwritten.
              </span>
              <span className="row-actions right">
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    const blob = new Blob(
                      [JSON.stringify(recoveryPayload, null, 2)],
                      { type: "application/json" },
                    );
                    const href = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = href;
                    link.download = `${draft.id}-application-recovery.json`;
                    link.click();
                    URL.revokeObjectURL(href);
                  }}
                >
                  Export local edits
                </button>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard the current editor contents and load the latest server application?",
                      )
                    ) {
                      void recovery
                        .clear()
                        .then(() => window.location.reload());
                    }
                  }}
                >
                  Load server version
                </button>
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={`validation-item ${draft.status === "withdrawn" ? "warn" : "ok"}`}
          >
            <strong>
              {draft.status === "withdrawn" ? "△ Withdrawn" : "✓ Submitted"}
            </strong>
            <span>
              {draft.status === "withdrawn"
                ? "This application is no longer in the review queue. Its immutable submitted snapshot remains in the audit history."
                : `This immutable application was received ${
                    draft.submittedAt
                      ? `${new Intl.DateTimeFormat("en", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: timezone,
                        }).format(
                          new Date(draft.submittedAt * 1_000),
                        )} (${timezone})`
                      : "successfully"
                  }.`}
            </span>
          </div>
          {draft.status === "submitted" || draft.status === "assigned" ? (
            <details className="card pad">
              <summary>
                <strong>Withdraw application</strong>
              </summary>
              <p className="help mt">
                Withdrawal removes this application from the active review
                queue. The submitted snapshot and audit history are retained.
              </p>
              <label className="toggle">
                <input
                  type="checkbox"
                  name="confirmWithdrawal"
                  value="yes"
                  required
                />{" "}
                I understand this application will be withdrawn.
              </label>
              <button
                className="btn danger mt"
                type="submit"
                name="_intent"
                value="withdraw"
                disabled={navigation.state !== "idle"}
              >
                {navigation.formData?.get("_intent") === "withdraw"
                  ? "Withdrawing…"
                  : "Withdraw application"}
              </button>
            </details>
          ) : null}
        </>
      )}
    </Form>
  );
}

export default function ApplicationForm({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  if ("unavailable" in loaderData)
    return (
      <main id="main" className="design-board">
        <section
          className="card pad"
          style={{ maxWidth: 620, margin: "8vh auto" }}
        >
          <span className="brand-mark">P</span>
          <h1>Applications unavailable</h1>
          <p className="subtle">{loaderData.unavailable}</p>
        </section>
      </main>
    );
  const {
    form,
    applicant,
    drafts,
    invitations,
    speakerProfile,
    selected,
    selectedForm,
    availability,
    claim,
    claimRequested,
  } = loaderData;

  return (
    <div
      className="public-shell event-branded"
      style={{ "--event-accent": form.brandAccent } as React.CSSProperties}
    >
      <header className="public-top">
        <Link
          className="brand"
          to={`/apply/${form.publicSlug}`}
          style={{ color: "var(--ink)", padding: 0 }}
        >
          <span className="brand-mark">P</span>
          <span>Program Cue</span>
        </Link>
        <span className="subtle">{form.eventName}</span>
        {applicant ? (
          <Form method="post" style={{ marginLeft: "auto" }}>
            <input type="hidden" name="_intent" value="sign_out" />
            <button type="submit" className="btn">
              {applicant.verified
                ? `Sign out ${applicant.email}`
                : "Discard anonymous session"}
            </button>
          </Form>
        ) : null}
      </header>
      <main
        id="main"
        style={{
          maxWidth: applicant ? 1120 : 760,
          margin: "30px auto",
          padding: "0 16px",
        }}
      >
        {claimRequested ? (
          <ClaimPanel claim={claim} actionData={actionData} />
        ) : !applicant ? (
          <AccessPanel loaderData={loaderData} actionData={actionData} />
        ) : (
          <>
            <section
              className="card pad mb"
              style={{ borderTop: `4px solid ${form.brandAccent}` }}
            >
              <div className="card-title">
                <div>
                  <span
                    className={`status ${availability.accepting ? "success" : "warning"}`}
                  >
                    {availability.accepting
                      ? "Open"
                      : "Not accepting submissions"}{" "}
                    · version {form.version.versionNumber}
                  </span>
                  <h1 className="mt">{form.name}</h1>
                  <p className="subtle">
                    {form.eventName} · {form.version.schema.introduction}
                  </p>
                </div>
                {applicant.verified && !applicant.claimOnly ? (
                  <Form method="post">
                    <input type="hidden" name="_intent" value="create_draft" />
                    <input
                      type="hidden"
                      name="intentId"
                      value={`${loaderData.intentId}:authenticated`}
                    />
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={
                        navigation.state !== "idle" || !availability.accepting
                      }
                    >
                      + New application
                    </button>
                  </Form>
                ) : applicant.claimOnly ? (
                  <Link
                    className="btn primary"
                    to={`/sign-in?${new URLSearchParams({
                      returnTo: `/apply/${encodeURIComponent(form.publicSlug)}`,
                    })}`}
                  >
                    Sign in to apply
                  </Link>
                ) : (
                  <span className="help right">
                    Verify your email to start another application.
                  </span>
                )}
              </div>
              {availability.reason ? (
                <div className="validation-item warn mt">
                  <strong>Notice</strong>
                  <span>
                    {availability.reason} Existing drafts remain available to
                    view and save.
                  </span>
                </div>
              ) : form.closesAt ? (
                <p className="help">
                  Applications close{" "}
                  {new Date(form.closesAt * 1_000).toLocaleDateString("en", {
                    timeZone: form.eventTimezone,
                  })}{" "}
                  ({form.eventTimezone}).
                </p>
              ) : null}
            </section>
            {loaderData.notice ? (
              <div
                className={`validation-item ${loaderData.noticeWarning ? "warn" : "ok"} card pad mb`}
                role="status"
              >
                <strong>{loaderData.noticeWarning ? "△" : "✓"}</strong>
                <span>{loaderData.notice}</span>
              </div>
            ) : null}
            {actionData && !actionData.ok ? (
              <div
                className={`validation-item ${actionData.committed ? "warn" : "error"} card pad mb`}
                role={actionData.committed ? "status" : "alert"}
              >
                <strong>△</strong>
                <span>{actionData.message}</span>
              </div>
            ) : null}
            {!applicant.verified ? (
              <AnonymousVerificationPanel
                form={form}
                actionData={actionData}
                turnstileSiteKey={loaderData.turnstileSiteKey}
              />
            ) : null}
            {speakerProfile ? (
              <SpeakerProfilePanel profile={speakerProfile} />
            ) : null}
            {invitations.length ? (
              <section className="card pad mb">
                <div className="card-title">
                  <div>
                    <span className="status warning">
                      Co-speaker invitation
                    </span>
                    <h2 className="mt">Applications that include you</h2>
                  </div>
                </div>
                {invitations.map((invitation) => (
                  <div className="row-main mt" key={invitation.id}>
                    <span className="avatar sm">
                      {invitation.displayName
                        .split(/\s+/)
                        .map((part) => part[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span>
                      <strong>{invitation.submissionTitle}</strong>
                      <small>Invited as {invitation.displayName}</small>
                    </span>
                    <Form method="post" className="right">
                      <input
                        type="hidden"
                        name="_intent"
                        value="claim_speaker"
                      />
                      <input
                        type="hidden"
                        name="invitationId"
                        value={invitation.id}
                      />
                      <button className="btn small" type="submit">
                        Claim speaker profile
                      </button>
                    </Form>
                  </div>
                ))}
              </section>
            ) : null}
            <div className="application-layout">
              <aside className="card pad application-drafts">
                <div className="card-title">
                  <h2>Your applications</h2>
                  <span className="pill right">{drafts.length}</span>
                </div>
                {drafts.length ? (
                  <div className="stack">
                    {drafts.map((draft) => (
                      <Link
                        className={`queue-card${selected?.id === draft.id ? " active" : ""}`}
                        to={`?draft=${encodeURIComponent(draft.id)}`}
                        key={draft.id}
                      >
                        <span
                          className={`status ${draft.status === "draft" ? "info" : "success"}`}
                        >
                          {draft.status}
                        </span>
                        <h3>{draft.title}</h3>
                        <small className="subtle">
                          v{draft.versionNumber} · {draft.speakers.length}{" "}
                          speaker{draft.speakers.length === 1 ? "" : "s"}
                        </small>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="subtle">
                    {applicant.claimOnly
                      ? "Your claim link grants access only to your speaker profile. Sign in to view or manage applications."
                      : "Create a draft to begin. You can maintain more than one application."}
                  </p>
                )}
              </aside>
              <section className="card pad">
                {selected ? (
                  <DraftEditor
                    key={`${selected.id}-${
                      actionData?.committed &&
                      actionData.submissionId === selected.id &&
                      actionData.revision !== undefined
                        ? actionData.revision
                        : selected.revision
                    }`}
                    draft={
                      actionData?.committed &&
                      actionData.submissionId === selected.id &&
                      actionData.revision !== undefined
                        ? { ...selected, revision: actionData.revision }
                        : selected
                    }
                    schema={selectedForm.version.schema.fields}
                    applicant={applicant}
                    publicSlug={form.publicSlug}
                    currentUpload={loaderData.selectedUpload}
                    uploadTurnstileSiteKey={loaderData.uploadTurnstileSiteKey}
                    maximumVideoBytes={
                      selectedForm.filePolicy.videoMaximumBytes
                    }
                    recoveryPersonId={
                      applicant.personId ??
                      (applicant.anonymousDraftId
                        ? `anonymous:${applicant.anonymousDraftId}`
                        : "")
                    }
                    recoveryEventId={form.eventId}
                    serverSaved={
                      loaderData.recoverySavedDraftId === selected.id ||
                      (Boolean(actionData?.committed) &&
                        actionData?.submissionId === selected.id)
                    }
                    conflict={Boolean(actionData?.conflict)}
                    maxSpeakers={selectedForm.maxSpeakers}
                    errors={actionData?.errors}
                    canSubmit={availability.accepting && applicant.verified}
                    timezone={form.eventTimezone}
                  />
                ) : (
                  <div style={{ textAlign: "center", padding: "52px 20px" }}>
                    <span className="brand-mark">＋</span>
                    <h2>
                      {applicant.claimOnly
                        ? "Sign in to manage applications"
                        : "Create your first application"}
                    </h2>
                    <p className="subtle">
                      {applicant.claimOnly
                        ? "A co-speaker claim link grants access to your speaker profile only."
                        : "Drafts are private and saved against the current published form version."}
                    </p>
                    {applicant.claimOnly ? (
                      <Link
                        className="btn primary"
                        to={`/sign-in?${new URLSearchParams({
                          returnTo: `/apply/${encodeURIComponent(form.publicSlug)}`,
                        })}`}
                      >
                        Continue to sign in
                      </Link>
                    ) : (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="_intent"
                          value="create_draft"
                        />
                        <input
                          type="hidden"
                          name="intentId"
                          value={`${loaderData.intentId}:first`}
                        />
                        <button
                          className="btn primary"
                          type="submit"
                          disabled={!availability.accepting}
                        >
                          Start application
                        </button>
                      </Form>
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

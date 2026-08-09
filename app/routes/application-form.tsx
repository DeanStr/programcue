import { useEffect, useMemo, useState } from "react";
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
  ApplicantConfigurationError,
  ApplicantDeliveryError,
  ApplicantInputError,
} from "~/modules/submissions/applicant-session.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
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
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

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
};

function slugFrom(params: Route.LoaderArgs["params"]) {
  const slug = params.slug;
  if (!slug) throw new Response("Application form not found", { status: 404 });
  return slug;
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
    const notice =
      portal.selected?.status === "submitted" &&
      url.searchParams.has("submitted")
        ? "This application is submitted and stored in D1."
        : portal.selected?.status === "draft" && url.searchParams.has("saved")
          ? "This draft is stored in D1."
          : portal.selected?.status === "draft" &&
              url.searchParams.has("created")
            ? "This private draft is stored in D1."
            : "";
    return { ...portal, notice };
  } catch (error) {
    if (error instanceof PublicFormUnavailableError) {
      return data({ unavailable: error.message }, { status: 410 });
    }
    throw error;
  }
}

class InvalidApplicationPayloadError extends Error {}

function parsePayload(formData: FormData) {
  try {
    return {
      submissionId: formData.get("submissionId"),
      revision: formData.get("revision"),
      answers: JSON.parse(String(formData.get("answers") ?? "{}")),
      speakers: JSON.parse(String(formData.get("speakers") ?? "[]")),
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
      "sign_out",
      "create_draft",
      "claim_speaker",
      "save_draft",
      "submit",
    ].includes(intent)
  ) {
    return data<ActionResult>(
      { ok: false, message: "Unsupported application action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "request_code") {
      const email = String(formData.get("email") ?? "");
      const result = await service.applicants.requestCode(
        form,
        email,
        String(formData.get("password") ?? ""),
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
      const result = await service.applicants.verifyCode(
        form,
        String(formData.get("email") ?? ""),
        String(formData.get("code") ?? ""),
      );
      return redirect(`/apply/${encodeURIComponent(slug)}`, {
        headers: { "set-cookie": result.cookie },
      });
    }
    if (intent === "sign_out") {
      if (form.accessMode === "account_required") {
        const result = await signOutSession(env, request);
        if (!result.ok) return result;
        const returnTo = `/apply/${encodeURIComponent(slug)}`;
        return redirect(`/sign-in?${new URLSearchParams({ returnTo })}`, {
          status: 303,
          headers: result.headers,
        });
      }
      return redirect(`/apply/${encodeURIComponent(slug)}`, {
        headers: {
          "set-cookie": await service.applicants.signOut(request, form),
        },
      });
    }

    const applicant = await service.applicants.get(request, form);
    if (!applicant)
      throw new Response("Verify your email before changing an application.", {
        status: 401,
      });
    if (intent === "create_draft") {
      const id = await service.createDraft(slug, applicant);
      return redirect(
        `/apply/${encodeURIComponent(slug)}?draft=${encodeURIComponent(id)}&created=1`,
      );
    }
    if (intent === "claim_speaker") {
      await service.claimCoSpeaker(
        slug,
        applicant,
        String(formData.get("invitationId") ?? ""),
      );
      return redirect(`/apply/${encodeURIComponent(slug)}`);
    }
    const payload = parsePayload(formData);
    if (intent === "save_draft") {
      await service.saveDraft(slug, applicant, payload);
      return redirect(
        `/apply/${encodeURIComponent(slug)}?draft=${encodeURIComponent(String(payload.submissionId))}&saved=1`,
      );
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
      if (result.confirmation.status === "queue_failed" || realtimeFailure) {
        const warnings = [
          result.confirmation.status === "queue_failed"
            ? "Its confirmation email could not be queued; the saved operation requires a retry."
            : null,
          realtimeFailure?.message ?? null,
        ].filter((warning): warning is string => Boolean(warning));
        return data<ActionResult>(
          {
            ok: false,
            committed: true,
            message: `Application submitted successfully. ${warnings.join(" ")}`,
          },
          { status: 207 },
        );
      }
      return redirect(
        `/apply/${encodeURIComponent(slug)}?draft=${encodeURIComponent(String(payload.submissionId))}&submitted=1`,
      );
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
    if (error instanceof SubmissionDraftSavedError) {
      return data<ActionResult>(
        {
          ok: false,
          committed: true,
          submissionId: error.submissionId,
          revision: error.draftRevision,
          message: error.message,
        },
        { status: 409 },
      );
    }
    if (
      error instanceof SubmissionRevisionConflictError ||
      error instanceof SubmissionStateError ||
      error instanceof PublicFormUnavailableError
    ) {
      return data<ActionResult>(
        { ok: false, message: error.message },
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
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange(value: string | string[]): void;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const common = {
    id: `answer-${field.id}`,
    name: `answer-${field.id}`,
    disabled,
    required: field.required,
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
      type={field.type === "url" ? "url" : "text"}
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
      <h1 className="mt">Start or continue an application</h1>
      <p className="subtle">
        Verify your email before saving or submitting. Your code expires after
        ten minutes.
      </p>
      {actionData && !actionData.ok ? (
        <div className="validation-item error mb" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      <Form method="post" className="stack">
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
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Requesting code…" : "Send verification code"}
        </button>
      </Form>
    </section>
  );
}

function DraftEditor({
  draft,
  schema,
  applicant,
  errors,
  canSubmit = true,
  timezone,
}: {
  draft: ApplicantDraft;
  schema: Route.ComponentProps["loaderData"] extends infer _
    ? Array<FormField>
    : never;
  applicant: { name: string; email: string };
  errors?: Record<string, string[]>;
  canSubmit?: boolean;
  timezone: string;
}) {
  const navigation = useNavigation();
  const [answers, setAnswers] = useState(draft.answers);
  const [speakers, setSpeakers] = useState(
    draft.speakers.length
      ? draft.speakers.map(({ name, email }) => ({ name, email }))
      : [{ name: applicant.name, email: applicant.email }],
  );
  const [dirty, setDirty] = useState(false);
  const readOnly = draft.status !== "draft";
  useEffect(() => {
    setAnswers(draft.answers);
    setSpeakers(
      draft.speakers.length
        ? draft.speakers.map(({ name, email }) => ({ name, email }))
        : [{ name: applicant.name, email: applicant.email }],
    );
    setDirty(false);
  }, [
    draft.id,
    draft.revision,
    draft.answers,
    draft.speakers,
    applicant.email,
    applicant.name,
  ]);
  const fields = visibleFields({ introduction: "", fields: schema }, answers);

  return (
    <Form method="post" className="stack" onChange={() => setDirty(true)}>
      <input type="hidden" name="submissionId" value={draft.id} />
      <input type="hidden" name="revision" value={draft.revision} />
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      <input type="hidden" name="speakers" value={JSON.stringify(speakers)} />
      <div className="card-title">
        <div>
          <span
            className={`status ${draft.status === "submitted" ? "success" : "info"}`}
          >
            {draft.status}
          </span>
          <h1 className="mt">{draft.title}</h1>
        </div>
        <span className="subtle right">Form version {draft.versionNumber}</span>
      </div>
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
          claim relationship; delivery of invitations is handled separately.
        </p>
        {speakers.map((speaker, index) => (
          <div className="form-row mb" key={index}>
            <label className="label">
              Speaker {index + 1} name
              <input
                className="field"
                disabled={readOnly}
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
                  disabled={readOnly}
                  required
                  value={speaker.email}
                  onChange={(event) => {
                    const next = [...speakers];
                    next[index] = { ...speaker, email: event.target.value };
                    setSpeakers(next);
                    setDirty(true);
                  }}
                />
                {index > 0 && !readOnly ? (
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
          </div>
        ))}
        {!readOnly ? (
          <button
            className="btn small"
            type="button"
            onClick={() => {
              setSpeakers([...speakers, { name: "", email: "" }]);
              setDirty(true);
            }}
          >
            + Add co-speaker
          </button>
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
        </>
      ) : (
        <div className="validation-item ok">
          <strong>✓ Submitted</strong>
          <span>
            This immutable application was received{" "}
            {draft.submittedAt
              ? `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(draft.submittedAt * 1_000))} (${timezone})`
              : "successfully"}
            .
          </span>
        </div>
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
    selected,
    selectedForm,
    availability,
  } = loaderData;

  return (
    <div className="public-shell">
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
              Sign out {applicant.email}
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
        {!applicant ? (
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
                <Form method="post">
                  <input type="hidden" name="_intent" value="create_draft" />
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
              <div className="validation-item ok card pad mb" role="status">
                <strong>✓</strong>
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
                          className={`status ${draft.status === "submitted" ? "success" : "info"}`}
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
                    Create a draft to begin. You can maintain more than one
                    application.
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
                    errors={actionData?.errors}
                    canSubmit={availability.accepting}
                    timezone={form.eventTimezone}
                  />
                ) : (
                  <div style={{ textAlign: "center", padding: "52px 20px" }}>
                    <span className="brand-mark">＋</span>
                    <h2>Create your first application</h2>
                    <p className="subtle">
                      Drafts are private and saved against the current published
                      form version.
                    </p>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="_intent"
                        value="create_draft"
                      />
                      <button
                        className="btn primary"
                        type="submit"
                        disabled={!availability.accepting}
                      >
                        Start application
                      </button>
                    </Form>
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

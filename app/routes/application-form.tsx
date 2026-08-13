import type { CSSProperties } from "react";
import { Plus } from "lucide-react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/application-form";
import type { action, loader, ActionResult } from "./application-form.server";
import { claimApplicantVideoUploadOperation } from "~/components/applicant-video-upload";
import { BrandMark } from "~/components/brand-mark";
import { DraftEditor } from "~/components/application-draft-editor";
import { PublicApplicationLanding } from "~/components/application-public-landing";
import { TurnstileWidget } from "~/components/turnstile-widget";

export { action, loader } from "./application-form.server";
export { claimApplicantVideoUploadOperation };

export const meta: Route.MetaFunction = ({ loaderData }) => {
  if (loaderData && "form" in loaderData) {
    return [
      { title: `${loaderData.form.name} · ${loaderData.form.eventName}` },
      {
        name: "description",
        content: loaderData.form.version.schema.introduction,
      },
      { property: "og:type", content: "website" },
      {
        property: "og:title",
        content: `${loaderData.form.eventName} — ${loaderData.form.name}`,
      },
      {
        property: "og:description",
        content: loaderData.form.version.schema.introduction,
      },
    ];
  }
  return [{ title: "Call for Speakers · Program Cue" }];
};

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
  const accepting = loaderData.availability.accepting;
  if (form.accessMode === "account_required") {
    const returnTo = `/apply/${encodeURIComponent(form.publicSlug)}`;
    return (
      <section className="card cfp-access-card">
        <span className={`status ${accepting ? "info" : "warning"}`}>
          {accepting ? "Account required" : "Not accepting new applications"}
        </span>
        <h2>
          {accepting ? "Sign in to apply" : "Sign in to view applications"}
        </h2>
        <p className="subtle">
          {accepting
            ? "This organiser requires a verified Program Cue account before applications can be created."
            : "New applications are unavailable. Signed-in applicants can still return to existing applications."}
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
      <section className="card cfp-access-card">
        <span className="status success">Email accepted</span>
        <h2>Enter your verification code</h2>
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
    <section className="card cfp-access-card">
      <span className={`status ${accepting ? "info" : "warning"}`}>
        {accepting
          ? "Private, recoverable drafts"
          : "Not accepting new applications"}
      </span>
      <h2>
        {!accepting
          ? "Already started?"
          : form.allowAnonymousDrafts
            ? "Ready to propose a session?"
            : "Verify to begin"}
      </h2>
      <p className="subtle">
        {!accepting
          ? "New applications are unavailable. Verify your email to recover an existing draft."
          : form.allowAnonymousDrafts
            ? "Begin now. We will ask you to verify an email only before final submission."
            : "Verify your email before saving or submitting. Your code expires after ten minutes."}
      </p>
      {actionData && !actionData.ok ? (
        <div className="validation-item error mb" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {form.allowAnonymousDrafts ? (
        <Form method="post" className="stack cfp-access-primary">
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
          <button
            className="btn primary"
            type="submit"
            disabled={pending || !accepting}
          >
            {pending
              ? "Starting…"
              : accepting
                ? "Start application"
                : "Applications unavailable"}
          </button>
        </Form>
      ) : null}
      <div className={form.allowAnonymousDrafts ? "cfp-returning" : "mt"}>
        {form.allowAnonymousDrafts ? (
          <>
            <h3>Already started?</h3>
            <p className="help">
              Recover verified drafts on this or another device.
            </p>
          </>
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
            action="application_request_code"
          />
          <button
            className={`btn${form.allowAnonymousDrafts ? "" : " primary"}`}
            type="submit"
            disabled={pending}
          >
            {pending ? "Requesting code…" : "Send verification code"}
          </button>
        </Form>
      </div>
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
          <BrandMark />
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
    featuredSpeakers,
    programmeUrl,
  } = loaderData;

  if (!claimRequested && !applicant) {
    return (
      <div
        className="public-shell event-branded"
        style={{ "--event-accent": form.brandAccent } as CSSProperties}
      >
        <header className="public-top">
          <Link
            aria-label={`${form.eventName} application home`}
            className="brand"
            to={`/apply/${form.publicSlug}`}
            style={{ color: "var(--ink)", padding: 0 }}
          >
            {form.participantLogoUrl ? (
              <img
                className="participant-logo"
                src={form.participantLogoUrl}
                alt={`${form.eventName} logo`}
                referrerPolicy="no-referrer"
              />
            ) : (
              <BrandMark />
            )}
            <span>Program Cue</span>
          </Link>
          <span className="subtle">{form.eventName}</span>
          {form.participantSupportUrl ? (
            <a
              className="tiny"
              href={form.participantSupportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Participant support
            </a>
          ) : null}
          {programmeUrl ? (
            <Link className="btn right" to={programmeUrl}>
              Programme
            </Link>
          ) : null}
        </header>
        <PublicApplicationLanding
          form={form}
          accepting={availability.accepting}
          availabilityReason={availability.reason}
          featuredSpeakers={featuredSpeakers}
          programmeUrl={programmeUrl}
          accessPanel={
            <AccessPanel loaderData={loaderData} actionData={actionData} />
          }
        />
      </div>
    );
  }

  return (
    <div
      className="public-shell event-branded"
      style={{ "--event-accent": form.brandAccent } as CSSProperties}
    >
      <header className="public-top">
        <Link
          aria-label={`${form.eventName} application home`}
          className="brand"
          to={`/apply/${form.publicSlug}`}
          style={{ color: "var(--ink)", padding: 0 }}
        >
          {form.participantLogoUrl ? (
            <img
              className="participant-logo"
              src={form.participantLogoUrl}
              alt={`${form.eventName} logo`}
              referrerPolicy="no-referrer"
            />
          ) : (
            <BrandMark />
          )}
          <span>Program Cue</span>
        </Link>
        <span className="subtle">{form.eventName}</span>
        {form.participantSupportUrl ? (
          <a
            className="tiny"
            href={form.participantSupportUrl}
            target="_blank"
            rel="noreferrer"
          >
            Participant support
          </a>
        ) : null}
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
        {form.participantWelcomeText ? (
          <section className="card pad mb participant-welcome">
            <span className="pc-page-eyebrow">From the event team</span>
            <p>{form.participantWelcomeText}</p>
          </section>
        ) : null}
        {claimRequested ? (
          <ClaimPanel claim={claim} actionData={actionData} />
        ) : applicant ? (
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
                    <span className="pc-state-icon" aria-hidden="true">
                      <Plus size={20} />
                    </span>
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
        ) : null}
      </main>
    </div>
  );
}

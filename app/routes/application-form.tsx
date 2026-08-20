import type { CSSProperties } from "react";
import {
  Form,
  Link,
  useActionData,
  useLocation,
  useNavigation,
} from "react-router";
import { claimApplicantVideoUploadOperation } from "~/components/applicant-video-upload";
import { PublicApplicationLanding } from "~/components/application-public-landing";
import { BrandMark } from "~/components/brand-mark";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import type { Route } from "./+types/application-form";
import type { ActionResult, action } from "./application-form.server";
import {
  AccessPanel,
  AuthenticatedApplicationWorkspace,
  ClaimPanel,
  EvaluationApplicantContextNotice,
} from "./application-form-panels";

export { action, loader } from "./application-form.server";
export {
  acceptedParticipantManagementHref,
  applicationAccessReturnTo,
  applicationDraftHref,
  evaluationApplicantContextMessage,
} from "./application-form-links";
export { claimApplicantVideoUploadOperation };

export const meta: Route.MetaFunction = ({ loaderData }) => {
  if (loaderData && "form" in loaderData) {
    return [
      { title: `${loaderData.form.name} · ${loaderData.form.eventName}` },
      ...(loaderData.form.participantLogoUrl
        ? [
            {
              tagName: "link",
              rel: "icon",
              href: loaderData.form.participantLogoUrl,
            },
          ]
        : []),
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
      { name: "theme-color", content: loaderData.form.brandAccent },
    ];
  }
  return [{ title: "Call for Speakers · Program Cue" }];
};

export default function ApplicationForm({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  if ("unavailable" in loaderData)
    return (
      <main id="main" className="design-board" tabIndex={-1}>
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
    availability,
    claim,
    claimRequested,
    featuredSpeakers,
    programmeUrl,
  } = loaderData;
  const claimedSpeakerId = new URLSearchParams(location.search).get(
    "claimedSpeaker",
  );
  const requestedSubmissionId = new URLSearchParams(location.search).get(
    "draft",
  );
  const claimScopedAction = claimedSpeakerId
    ? `?${new URLSearchParams({ claimedSpeaker: claimedSpeakerId })}`
    : undefined;
  const applicationPortalPath = claimedSpeakerId
    ? `/apply/${encodeURIComponent(form.publicSlug)}?${new URLSearchParams({ claimedSpeaker: claimedSpeakerId })}`
    : requestedSubmissionId
      ? `/apply/${encodeURIComponent(form.publicSlug)}?${new URLSearchParams({ draft: requestedSubmissionId })}`
      : `/apply/${encodeURIComponent(form.publicSlug)}`;
  const historicalPortal = Boolean(
    (claimedSpeakerId || requestedSubmissionId) && form.status !== "published",
  );
  const isEvaluationApplicant =
    applicant?.verified === true && applicant.evaluation === true;
  const accentPalette = programmeAccentPalette(form.brandAccent);
  const brandStyle = {
    "--event-accent": accentPalette.accent,
    "--accent-ink": accentPalette.ink,
    "--accent-on-solid": accentPalette.onAccent,
  } as CSSProperties;

  if (!claimRequested && !applicant) {
    return (
      <div className="public-shell event-branded" style={brandStyle}>
        <header className="public-top">
          <Link
            aria-label={`${form.eventName} application home`}
            className="brand"
            to={applicationPortalPath}
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
            <>
              <EvaluationApplicantContextNotice
                accessMode={form.accessMode}
                context={loaderData.evaluationApplicantContext}
              />
              <AccessPanel loaderData={loaderData} actionData={actionData} />
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="public-shell event-branded" style={brandStyle}>
      <header className="public-top application-top">
        <Link
          aria-label={`${form.eventName} application home`}
          className="brand"
          to={applicationPortalPath}
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
        {applicant && !isEvaluationApplicant ? (
          <Form
            className="application-account-actions"
            method="post"
            action={claimScopedAction}
          >
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
        className="application-main"
        tabIndex={-1}
        style={{
          maxWidth: applicant ? 1120 : 760,
          margin: "30px auto",
          padding: "0 16px",
        }}
      >
        <EvaluationApplicantContextNotice
          accessMode={form.accessMode}
          context={loaderData.evaluationApplicantContext}
        />
        {form.participantWelcomeText ? (
          <section className="card pad mb participant-welcome">
            <span className="pc-page-eyebrow">From the event team</span>
            <p>{form.participantWelcomeText}</p>
          </section>
        ) : null}
        {claimRequested ? (
          <ClaimPanel claim={claim} actionData={actionData} />
        ) : applicant ? (
          <AuthenticatedApplicationWorkspace
            loaderData={loaderData}
            actionData={actionData}
            applicant={applicant}
            claimedSpeakerId={claimedSpeakerId}
            claimScopedAction={claimScopedAction}
            applicationPortalPath={applicationPortalPath}
            historicalPortal={historicalPortal}
            navigation={navigation}
          />
        ) : null}
      </main>
    </div>
  );
}

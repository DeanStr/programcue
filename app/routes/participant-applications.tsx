import { ClipboardList, ExternalLink } from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError, z } from "zod";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { ParticipantApplicationSummaryService } from "~/modules/submissions/participant-application-summary.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import {
  MAX_SUBMISSION_SPEAKERS,
  visibleFields,
} from "~/modules/submissions/submission-schema";
import { ApiError } from "~/platform/api/api.server";
import { ApiParticipantService } from "~/platform/api/api-participant-service.server";
import { evaluatorEmailRoutingMessage } from "~/platform/evaluation/evaluator-email-alias.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import type { Route } from "./+types/participant-applications";

export const meta = () => [{ title: "Applications · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const selectedApplicationId = new URL(request.url).searchParams.get(
    "application",
  );
  return {
    ...(await new ParticipantApplicationSummaryService(env).getWorkspace(
      viewer,
      selectedApplicationId,
    )),
    coSpeakerInvitationIdempotencyKey: crypto.randomUUID(),
  };
}

type ParticipantApplicationsActionResult = {
  ok: boolean;
  partial?: boolean;
  applicationId: string;
  message: string;
};

const formIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/u);

export async function action({ request, context }: Route.ActionArgs) {
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;

  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  const applicationId = String(formData.get("applicationId") ?? "");
  if (intent !== "invite_co_speaker") {
    return data<ParticipantApplicationsActionResult>(
      {
        ok: false,
        applicationId,
        message: "Unsupported application action.",
      },
      { status: 400 },
    );
  }
  try {
    z.literal("true").parse(formData.get("confirmed"));
    const participantService = new ApiParticipantService(env);
    const result = await participantService.inviteAcceptedCoSpeaker(
      viewer,
      {
        submissionId: applicationId,
        revision: Number(formData.get("revision")),
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        roleLabel: String(formData.get("roleLabel") ?? "") as
          | "Co-author"
          | "Co-speaker"
          | "Co-presenter",
        confirmed: true,
      },
      formIdempotencyKeySchema.parse(formData.get("idempotencyKey")),
    );
    const finalization =
      await participantService.finalizeAcceptedCoSpeakerInvitation(
        viewer,
        result.response,
        "participant_ui",
      );
    const partial = finalization.warnings.length > 0;
    const relationshipMessage = `${result.response.speaker.name} was added as ${result.response.speaker.roleLabel.toLowerCase()}`;
    const routingDisclosure = evaluatorEmailRoutingMessage(
      result.response.routing ?? null,
    );
    const completedMessage = `${relationshipMessage} and the expiring claim invitation was queued.${routingDisclosure ? ` ${routingDisclosure}` : ""}`;
    return data<ParticipantApplicationsActionResult>(
      {
        ok: !partial,
        partial,
        applicationId,
        message: partial
          ? `${relationshipMessage}. ${finalization.warnings.join(" ")}${routingDisclosure ? ` ${routingDisclosure}` : ""}`
          : completedMessage,
      },
      { status: partial ? 207 : 200 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data<ParticipantApplicationsActionResult>(
        {
          ok: false,
          applicationId,
          message:
            error.issues[0]?.message ??
            "Review the co-speaker invitation details.",
        },
        { status: 422 },
      );
    }
    if (
      error instanceof SubmissionStateError ||
      error instanceof SubmissionRevisionConflictError ||
      error instanceof ApiError
    ) {
      return data<ParticipantApplicationsActionResult>(
        { ok: false, applicationId, message: error.message },
        { status: error instanceof ApiError ? error.status : 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function ApplicationDetail({
  application,
  actionResult,
  idempotencyKey,
}: {
  application: NonNullable<
    Route.ComponentProps["loaderData"]["selectedApplication"]
  >;
  actionResult?: ParticipantApplicationsActionResult;
  idempotencyKey: string;
}) {
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const snapshot = application.submittedSnapshot;
  const schema = snapshot?.schema ?? application.schema;
  const answers = snapshot?.answers ?? application.answers;
  const answerRows = visibleFields(schema, answers).flatMap((field) => {
    const value = answers[field.id];
    if (value === undefined || value === "" || value.length === 0) return [];
    return [{ id: field.id, label: field.label, value }];
  });
  const canOpenForm =
    application.primarySubmitter && application.formStatus === "published";
  const canInviteCoSpeaker =
    application.primarySubmitter &&
    application.status === "accepted" &&
    application.speakerListEditable &&
    application.speakers.length < MAX_SUBMISSION_SPEAKERS &&
    (application.maxSpeakers === null ||
      application.speakers.length < application.maxSpeakers);

  return (
    <>
      {dialog}
      <section
        className="card pad mt"
        id="participant-application-detail"
        aria-labelledby="participant-application-detail-heading"
      >
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Application detail</span>
            <h2 id="participant-application-detail-heading">
              {application.title}
            </h2>
            <p className="subtle">
              {application.formName} · {application.publicReference}
            </p>
          </div>
          <DomainStatusBadge domain="submission" status={application.status} />
        </div>
        {actionResult?.applicationId === application.id ? (
          <div
            className={`validation-item ${actionResult.ok ? "ok" : actionResult.partial ? "warn" : "error"} card pad mt`}
            role={actionResult.ok || actionResult.partial ? "status" : "alert"}
          >
            {actionResult.message}
          </div>
        ) : null}
        {answerRows.length ? (
          <dl className="stack mt">
            {answerRows.map((answer) => (
              <div className="card inset pad" key={answer.id}>
                <dt className="tiny subtle">{answer.label}</dt>
                <dd style={{ margin: "4px 0 0" }}>
                  {Array.isArray(answer.value)
                    ? answer.value.join(", ")
                    : answer.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="subtle mt">
            No application answers have been saved yet.
          </p>
        )}
        {application.speakers.length ? (
          <div className="mt">
            <h3>Participants</h3>
            <ul>
              {application.speakers.map((speaker) => (
                <li key={speaker.id}>
                  <strong>{speaker.name}</strong> ·{" "}
                  {speaker.roleLabel ?? "Role not recorded"}
                  <br />
                  <span className="subtle">
                    {speaker.email} ·{" "}
                    {speaker.invitationStatus === "sent"
                      ? "Claim invitation prepared"
                      : `Relationship status: ${speaker.invitationStatus}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {canInviteCoSpeaker ? (
          <Form method="post" className="card inset pad stack mt">
            <div>
              <span className="pc-section-kicker">Accepted proposal</span>
              <h3>Add a co-speaker</h3>
              <p className="subtle">
                This adds the relationship without changing the submitted
                answers. The named person must claim the expiring email
                invitation before Program Cue links their identity.
              </p>
            </div>
            <input type="hidden" name="_intent" value="invite_co_speaker" />
            <input type="hidden" name="applicationId" value={application.id} />
            <input type="hidden" name="revision" value={application.revision} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <input type="hidden" name="confirmed" value="true" />
            <div className="grid grid-3">
              <label className="label">
                Name
                <input className="field" name="name" required maxLength={120} />
              </label>
              <label className="label">
                Email
                <input
                  className="field"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                />
              </label>
              <label className="label">
                Role
                <select
                  className="select"
                  name="roleLabel"
                  defaultValue="Co-author"
                >
                  <option>Co-author</option>
                  <option>Co-speaker</option>
                  <option>Co-presenter</option>
                </select>
              </label>
            </div>
            <div className="page-actions">
              <button
                className="btn primary"
                type="button"
                disabled={navigation.state !== "idle"}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  if (!form?.reportValidity()) return;
                  const formData = new FormData(form);
                  const name = String(formData.get("name"));
                  const email = String(formData.get("email"));
                  const role = String(formData.get("roleLabel"));
                  confirm(
                    {
                      title: "Send this co-speaker invitation?",
                      description:
                        "Program Cue will add this person to the accepted proposal and queue an expiring identity-claim email.",
                      records: [`${name} · ${email} · ${role}`],
                      confirmLabel: "Send invitation",
                      tone: "primary",
                    },
                    () => form.requestSubmit(),
                  );
                }}
              >
                Send co-speaker invitation
              </button>
            </div>
          </Form>
        ) : null}
        {application.primarySubmitter &&
        application.status === "accepted" &&
        !application.speakerListEditable ? (
          <p className="help mt">
            This participant list can change only while the accepted application
            has exactly one editable derived session. Contact an organiser if a
            speaker needs to change.
          </p>
        ) : null}
        <div className="page-actions mt">
          {canOpenForm ? (
            <Link
              className="btn primary"
              to={`/apply/${encodeURIComponent(application.formSlug)}?${new URLSearchParams({ draft: application.id })}`}
            >
              {application.status === "draft"
                ? "Continue application"
                : "Open application workflow"}{" "}
              <ExternalLink aria-hidden size={14} />
            </Link>
          ) : null}
          <Link className="btn" to="/participant/applications">
            Close detail
          </Link>
        </div>
        {!canOpenForm && application.primarySubmitter ? (
          <p className="help mt">
            This form is no longer published. The saved application remains
            available here as a read-only record.
          </p>
        ) : null}
      </section>
    </>
  );
}

export default function ParticipantApplications({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | ParticipantApplicationsActionResult
    | undefined;
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Participant workspace</span>
          <h1>Applications</h1>
          <p>
            Track proposals you submitted and applications that include you as a
            co-speaker.
          </p>
        </div>
      </div>
      {loaderData.availableForms.length ? (
        <section
          className="card pad mt"
          aria-labelledby="available-forms-heading"
        >
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Start something new</span>
              <h2 id="available-forms-heading">Open forms</h2>
            </div>
          </div>
          <div className="page-actions">
            {loaderData.availableForms.map((form) => (
              <Link
                className="btn"
                to={`/apply/${encodeURIComponent(form.publicSlug)}`}
                key={form.id}
              >
                {form.name} <ExternalLink aria-hidden size={14} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {loaderData.selectedApplication ? (
        <ApplicationDetail
          application={loaderData.selectedApplication}
          actionResult={actionData}
          idempotencyKey={loaderData.coSpeakerInvitationIdempotencyKey}
        />
      ) : null}
      <section
        className="mt"
        aria-labelledby="participant-applications-heading"
      >
        <div className="card-title">
          <h2 id="participant-applications-heading">Your applications</h2>
          <span className="pill right">{loaderData.applications.length}</span>
        </div>
        {loaderData.applications.length ? (
          <div className="speaker-task-list">
            {loaderData.applications.map((application) => (
              <article className="card pad" key={application.id}>
                <div className="card-title">
                  <DomainStatusBadge
                    domain="submission"
                    status={application.status}
                  />
                  <span className="subtle tiny right">
                    {application.publicReference}
                  </span>
                </div>
                <h3>{application.title}</h3>
                <p className="subtle">
                  {application.formName} ·{" "}
                  {application.primarySubmitter
                    ? application.status === "draft"
                      ? "Started by you"
                      : "Submitted by you"
                    : "You are a co-speaker"}
                </p>
                <p className="tiny subtle">
                  Updated{" "}
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                  }).format(new Date(application.updatedAt))}
                </p>
                <Link
                  className="btn small"
                  to={`?${new URLSearchParams({ application: application.id })}#participant-application-detail`}
                >
                  View application
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="pc-empty-state card pad">
            <ClipboardList aria-hidden className="pc-state-icon" />
            <h2>No applications yet</h2>
            <p className="subtle">
              You have not started or joined an application for this event.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

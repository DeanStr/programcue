import type { Ref } from "react";
import { ButtonLink } from "~/components/ui/button";
import type { SpeakerWorkflowStatus } from "~/modules/speakers/speaker-roster-import.server";

export function AdminSpeakerNextSteps({
  speaker,
  headingRef,
}: {
  speaker: {
    id: string;
    name: string;
    needsPortalAccessForSession: boolean;
    workflowStatus: SpeakerWorkflowStatus;
  };
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const personId = encodeURIComponent(speaker.id);
  const inactive =
    speaker.workflowStatus === "declined" ||
    speaker.workflowStatus === "withdrawn";
  return (
    <section className="card pad mb" aria-labelledby="speaker-next-steps">
      <h2 id="speaker-next-steps" ref={headingRef} tabIndex={-1}>
        Next steps for {speaker.name}
      </h2>
      <ol className="stack">
        <li>
          <ButtonLink
            size="small"
            to={`/admin/speakers?person=${personId}#admin-speaker-${personId}`}
          >
            {inactive ? "Review roster status" : "Invite to speaker portal"}
          </ButtonLink>
          <p className="help">
            {inactive
              ? `Restore an active roster status before sending a portal invitation. This speaker is ${speaker.workflowStatus}.`
              : "Review and confirm the invitation email on their roster record."}
          </p>
        </li>
        <li>
          <ButtonLink
            size="small"
            to={`/admin/sessions/new?person=${personId}`}
          >
            Add a session for this speaker
          </ButtonLink>
          <p className="help">
            {inactive && speaker.needsPortalAccessForSession
              ? "Restore an active roster status, then check session access again. "
              : speaker.needsPortalAccessForSession
                ? "Invite this speaker to the portal and wait for them to accept portal access before you can create their session. "
                : "You can prepare their session before they accept portal access. "}
            They must confirm participation before the session can be published.
          </p>
        </li>
        <li>
          {inactive ? (
            <p className="help">
              Onboarding tasks are unavailable while this speaker is{" "}
              {speaker.workflowStatus}. Restore an active workflow status on
              their roster record before assigning tasks.
            </p>
          ) : (
            <ButtonLink
              size="small"
              to={`/admin/tasks?view=plans&person=${personId}`}
            >
              Assign onboarding tasks
            </ButtonLink>
          )}
        </li>
      </ol>
    </section>
  );
}

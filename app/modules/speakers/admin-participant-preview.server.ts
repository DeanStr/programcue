import { ResourceService } from "~/modules/resources/resource-service.server";
import { ParticipantApplicationSummaryService } from "~/modules/submissions/participant-application-summary.server";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { SpeakerService } from "./speaker-service.server";

export async function getAdminParticipantPreview(
  env: CloudflareEnvironment,
  administrator: Viewer,
  personId: string,
) {
  if (
    administrator.role !== "owner" &&
    administrator.role !== "administrator"
  ) {
    throw new Response("Administrator access is required.", { status: 403 });
  }
  const speakers = new SpeakerService(env);
  const membership = await env.DB.prepare(
    `SELECT membership.role,
            person.id, person.display_name AS name, person.email,
            event.name AS eventName
       FROM memberships membership
       JOIN events event
         ON event.id = membership.event_id
        AND event.organisation_id = membership.organisation_id
       JOIN people person ON person.id = membership.person_id
      WHERE membership.event_id = ? AND membership.organisation_id = ?
        AND membership.person_id = ?
        AND membership.role IN ('speaker','submitter')
        AND membership.accepted_at IS NOT NULL
        AND membership.revoked_at IS NULL
      ORDER BY CASE membership.role WHEN 'speaker' THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(administrator.eventId, administrator.organisationId, personId)
    .first<{
      role: "speaker" | "submitter";
      id: string;
      name: string;
      email: string;
      eventName: string;
    }>();
  if (!membership) {
    const detail = await speakers.getAdminSpeakerDetail(
      administrator,
      personId,
    );
    return {
      available: false as const,
      person: {
        id: detail.profile.id,
        name: detail.profile.name,
        email: detail.profile.email,
      },
      event: { name: detail.event.name },
    };
  }
  const participant: Viewer = {
    personId: membership.id,
    name: membership.name,
    email: membership.email,
    role: membership.role,
    organisationId: administrator.organisationId,
    eventId: administrator.eventId,
    demo: administrator.demo,
    evaluation: administrator.evaluation,
  };
  const canManageAvailability =
    await speakers.canManageAvailability(participant);
  const [portal, applications, tasks, resources, availability] =
    await Promise.all([
      speakers.getPortal(participant),
      new ParticipantApplicationSummaryService(env).list(participant),
      new TaskService(env).listParticipantTaskSnapshot(participant),
      new ResourceService(env).getParticipantWorkspace(participant),
      canManageAvailability
        ? speakers.listAdminAvailability(administrator, participant.personId)
        : Promise.resolve(null),
    ]);
  return {
    available: true as const,
    participantRole: membership.role,
    portal,
    applications: applications.map((application) => ({
      id: application.id,
      title: application.title,
      formName: application.formName,
      status: application.status,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
      targetType: task.targetType,
      targetLabel: task.targetLabel,
    })),
    resources: resources.pages.map((resource) => ({
      id: resource.id,
      title: resource.title,
      category: resource.category,
      acknowledgementRequired: resource.acknowledgementRequired,
      acknowledged: resource.acknowledged,
    })),
    availabilityCount: availability?.windows.length ?? null,
    canManageAvailability,
  };
}

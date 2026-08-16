import { ResourceAuthoringService } from "./resource-authoring-service.server";
import { ResourceParticipantService } from "./resource-participant-service.server";

export {
  materializePublishedResourceAcknowledgementsForClaimedSpeaker,
  materializePublishedResourceAcknowledgementsForSession,
  ResourceAudienceError,
  ResourceInvariantError,
  ResourceRevisionConflictError,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
} from "./resource-service-shared";

/** Stable facade over resource authoring/publication and participant reading. */
export class ResourceService {
  private readonly authoring: ResourceAuthoringService;
  private readonly participants: ResourceParticipantService;

  constructor(env: CloudflareEnvironment) {
    this.authoring = new ResourceAuthoringService(env);
    this.participants = new ResourceParticipantService(env);
  }

  getAdminWorkspace(
    ...args: Parameters<ResourceAuthoringService["getAdminWorkspace"]>
  ) {
    return this.authoring.getAdminWorkspace(...args);
  }

  save(...args: Parameters<ResourceAuthoringService["save"]>) {
    return this.authoring.save(...args);
  }

  publish(...args: Parameters<ResourceAuthoringService["publish"]>) {
    return this.authoring.publish(...args);
  }

  attachToDraft(
    ...args: Parameters<ResourceAuthoringService["attachToDraft"]>
  ) {
    return this.authoring.attachToDraft(...args);
  }

  getParticipantWorkspace(
    ...args: Parameters<ResourceParticipantService["getParticipantWorkspace"]>
  ) {
    return this.participants.getParticipantWorkspace(...args);
  }

  acknowledge(...args: Parameters<ResourceParticipantService["acknowledge"]>) {
    return this.participants.acknowledge(...args);
  }
}

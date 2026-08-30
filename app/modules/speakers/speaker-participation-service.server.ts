import {
  type AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { EventFieldService } from "~/modules/fields/event-field-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ParticipantProfileService,
  participantProfilePatchSchema,
} from "./participant-profile-service.server";
import { SpeakerPortalService } from "./speaker-portal-service.server";

export class SpeakerParticipationService {
  private readonly portal: SpeakerPortalService;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary,
  ) {
    this.portal = new SpeakerPortalService(env, airtable);
  }

  getPortal(viewer: Viewer) {
    return this.portal.getPortal(viewer);
  }

  async updateProfile(viewer: Viewer, rawInput: unknown) {
    const input = participantProfilePatchSchema.parse(
      await new EventFieldService(this.env).protectParticipantProfilePatch(
        viewer,
        viewer.personId,
        rawInput as object,
      ),
    );
    const idempotencyKey = await airtableCommandKey(
      "participant.profile.update",
      viewer,
      input,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "participant.profile.update" },
      () => new ParticipantProfileService(this.env).update(viewer, input),
    );
  }
}

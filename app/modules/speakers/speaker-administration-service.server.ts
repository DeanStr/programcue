import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { SpeakerInvitationCommands } from "./speaker-invitation-commands.server";
import { SpeakerProfileAdministration } from "./speaker-profile-administration.server";
import { SpeakerRosterRecordCommands } from "./speaker-roster-record-commands.server";

export type {
  AdminSpeakerFileVersion,
  AdminSpeakerFilters,
  AdminSpeakerListItem,
} from "./speaker-administration-contracts.server";

/** Stable administrator façade over roster, invitation, and profile use cases. */
export class SpeakerAdministrationService {
  private readonly records: SpeakerRosterRecordCommands;
  private readonly invitations: SpeakerInvitationCommands;
  private readonly profiles: SpeakerProfileAdministration;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.records = new SpeakerRosterRecordCommands(env, collaborators);
    this.invitations = new SpeakerInvitationCommands(env, collaborators);
    this.profiles = new SpeakerProfileAdministration(env, collaborators);
  }

  addManualSpeakerRecord(
    ...args: Parameters<SpeakerRosterRecordCommands["addManualSpeakerRecord"]>
  ) {
    return this.records.addManualSpeakerRecord(...args);
  }
  addExistingSpeakerProspect(
    ...args: Parameters<
      SpeakerRosterRecordCommands["addExistingSpeakerProspect"]
    >
  ) {
    return this.records.addExistingSpeakerProspect(...args);
  }
  inviteSpeakerRecord(
    ...args: Parameters<SpeakerInvitationCommands["inviteSpeakerRecord"]>
  ) {
    return this.invitations.inviteSpeakerRecord(...args);
  }
  updateAdminSpeakerProfile(
    ...args: Parameters<
      SpeakerProfileAdministration["updateAdminSpeakerProfile"]
    >
  ) {
    return this.profiles.updateAdminSpeakerProfile(...args);
  }
  updateAdminScopedSpeakerProfile(
    ...args: Parameters<
      SpeakerProfileAdministration["updateAdminScopedSpeakerProfile"]
    >
  ) {
    return this.profiles.updateAdminScopedSpeakerProfile(...args);
  }
  updateSpeakerWorkflowStatus(
    ...args: Parameters<
      SpeakerProfileAdministration["updateSpeakerWorkflowStatus"]
    >
  ) {
    return this.profiles.updateSpeakerWorkflowStatus(...args);
  }
  getAdminSpeakerDetail(
    ...args: Parameters<SpeakerProfileAdministration["getAdminSpeakerDetail"]>
  ) {
    return this.profiles.getAdminSpeakerDetail(...args);
  }
  listAdminSpeakerPage(
    ...args: Parameters<SpeakerProfileAdministration["listAdminSpeakerPage"]>
  ) {
    return this.profiles.listAdminSpeakerPage(...args);
  }
}

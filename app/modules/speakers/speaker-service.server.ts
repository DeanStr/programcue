import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type AdminSpeakerFilters,
  SpeakerAdministrationService,
} from "./speaker-administration-service.server";
import { SpeakerAvailabilityService } from "./speaker-availability-service.server";
import { SpeakerParticipationService } from "./speaker-participation-service.server";

export { ParticipantProfileConflictError as SpeakerProfileConflictError } from "./participant-profile-service.server";
export type {
  AdminSpeakerFileVersion,
  AdminSpeakerFilters,
  AdminSpeakerListItem,
} from "./speaker-administration-service.server";
export {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";

/**
 * Stable speaker-domain façade. Participant-owned profile and participation
 * commands stay separate from administrator roster commands and queries so
 * neither boundary has to reconstruct the other's authority.
 */
export class SpeakerService {
  private readonly participation: SpeakerParticipationService;
  private readonly administration: SpeakerAdministrationService;
  private readonly availability: SpeakerAvailabilityService;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    this.participation = new SpeakerParticipationService(env, airtable);
    this.administration = new SpeakerAdministrationService(env, { airtable });
    this.availability = new SpeakerAvailabilityService(env, airtable);
  }

  getPortal(viewer: Viewer) {
    return this.participation.getPortal(viewer);
  }

  updateProfile(viewer: Viewer, rawInput: unknown) {
    return this.participation.updateProfile(viewer, rawInput);
  }

  confirmOwnParticipation(viewer: Viewer, rawInput: unknown) {
    return this.participation.confirmOwnParticipation(viewer, rawInput);
  }

  declineOwnParticipation(viewer: Viewer, rawInput: unknown) {
    return this.participation.declineOwnParticipation(viewer, rawInput);
  }

  confirmExternalParticipation(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    return this.participation.confirmExternalParticipation(
      viewer,
      rawPersonId,
      rawInput,
    );
  }

  resetDeclinedParticipation(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    return this.participation.resetDeclinedParticipation(
      viewer,
      rawPersonId,
      rawInput,
    );
  }

  canManageAvailability(viewer: Viewer) {
    return this.availability.canManage(viewer);
  }

  listOwnAvailability(viewer: Viewer) {
    return this.availability.listOwnWindows(viewer);
  }

  createOwnAvailability(viewer: Viewer, rawInput: unknown) {
    return this.availability.createOwnWindow(viewer, rawInput);
  }

  deleteOwnAvailability(viewer: Viewer, rawInput: unknown) {
    return this.availability.deleteOwnWindow(viewer, rawInput);
  }

  listAdminAvailability(viewer: Viewer, personId: string) {
    return this.availability.listAdminWindows(viewer, personId);
  }

  deleteAdminAvailability(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    return this.availability.deleteAdminWindow(viewer, rawPersonId, rawInput);
  }

  addManualSpeakerRecord(viewer: Viewer, rawInput: unknown) {
    return this.administration.addManualSpeakerRecord(viewer, rawInput);
  }

  addExistingSpeakerProspect(viewer: Viewer, rawInput: unknown) {
    return this.administration.addExistingSpeakerProspect(viewer, rawInput);
  }

  inviteSpeakerRecord(viewer: Viewer, rawInput: unknown) {
    return this.administration.inviteSpeakerRecord(viewer, rawInput);
  }

  updateAdminSpeakerProfile(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    return this.administration.updateAdminSpeakerProfile(
      viewer,
      personId,
      rawInput,
    );
  }

  updateAdminScopedSpeakerProfile(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    return this.administration.updateAdminScopedSpeakerProfile(
      viewer,
      personId,
      rawInput,
    );
  }

  updateSpeakerWorkflowStatus(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    return this.administration.updateSpeakerWorkflowStatus(
      viewer,
      personId,
      rawInput,
    );
  }

  getAdminSpeakerDetail(viewer: Viewer, personId: string) {
    return this.administration.getAdminSpeakerDetail(viewer, personId);
  }

  listAdminSpeakerPage(
    viewer: Viewer,
    filters: AdminSpeakerFilters,
    page: number,
  ) {
    return this.administration.listAdminSpeakerPage(viewer, filters, page);
  }
}

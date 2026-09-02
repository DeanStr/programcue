import type { SpeakerRosterProfileAction } from "~/modules/speakers/speaker-roster-import.server";

export function speakerWorkflowLabel(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function rosterProfileActionLabel(action: SpeakerRosterProfileAction) {
  switch (action) {
    case "create_identity_and_profile":
      return "New neutral identity and organisation profile";
    case "create_organisation_profile":
      return "Canonical profile retained; organisation profile created";
    case "update_organisation_profile":
      return "Canonical profile retained; organisation profile updated";
    case "retain_organisation_profile":
      return "Canonical retained; imported details already match";
  }
}

export function omittedRosterProfileLabel(action: SpeakerRosterProfileAction) {
  return action === "update_organisation_profile" ||
    action === "retain_organisation_profile"
    ? "Not supplied (retained)"
    : "Not supplied (left empty)";
}

export function speakerInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export function buildSpeakerRosterPulse(
  summary: {
    knownSpeakers: number;
    readySpeakers: number;
    outstandingTasks: number;
    pendingRoles: number;
    missingRequiredFields: number;
    quarantinedFiles: number;
  },
  activePendingInvitationCount: number,
) {
  return [
    `${summary.knownSpeakers} ${summary.knownSpeakers === 1 ? "speaker" : "speakers"}`,
    `${summary.readySpeakers} ready`,
    summary.outstandingTasks ? `${summary.outstandingTasks} outstanding` : null,
    summary.pendingRoles ? `${summary.pendingRoles} responses pending` : null,
    summary.missingRequiredFields
      ? `${summary.missingRequiredFields} required fields missing`
      : null,
    summary.quarantinedFiles ? `${summary.quarantinedFiles} quarantined` : null,
    activePendingInvitationCount
      ? `${activePendingInvitationCount} invitations pending`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

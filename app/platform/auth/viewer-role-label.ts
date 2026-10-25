import type { ViewerRole } from "./authorize.server";

/** How a signed-in role is named on screen; matches the access-invitation copy. */
export const VIEWER_ROLE_LABELS = {
  owner: "Owner",
  administrator: "Administrator",
  committee_chair: "Committee chair",
  evaluator: "Evaluator",
  submitter: "Applicant",
  speaker: "Speaker",
} as const satisfies Record<ViewerRole, string>;

export function viewerRoleLabel(role: ViewerRole) {
  return VIEWER_ROLE_LABELS[role];
}

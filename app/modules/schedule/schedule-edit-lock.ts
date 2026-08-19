/* The planner freezes in four separate places — the board, the session source,
   the schedule notes and the session editor — and each used to decide on its
   own what "not a draft" meant. One derivation keeps the wording, the reason
   and the remedy identical wherever a control goes inert.

   Only null, `draft` and `published` reach the planner today: the workspace
   query selects `status IN ('draft','published')`. The other three statuses
   the CHECK constraint permits are mapped because the rows exist and the
   `default:` branch throws, so an unmapped status would take the page down
   rather than degrade to "locked" — but they are unreachable, not merely
   untested. `publishing` lives and dies inside the atomic publication batch,
   `archived` only lands on a superseded version the query skips, and nothing
   writes `failed`. */

export type ScheduleEditLockVersion = {
  versionNumber: number;
  status: string;
};

export type ScheduleEditLockReason = {
  /** Names the state, for example "Version 3 is published". */
  title: string;
  /** Why editing is frozen, in one sentence. */
  detail: string;
  /** Short enough for a disabled control's accessible name. */
  remedy: string;
  tone: "info" | "warning";
};

export type ScheduleEditLock = {
  editable: boolean;
  reason: ScheduleEditLockReason | null;
};

const NEXT_DRAFT_REMEDY = "Create the next draft to edit";

const FROZEN_SURFACES =
  "The board, schedule notes and session content are frozen";

export function scheduleEditLock(
  version: ScheduleEditLockVersion | null,
): ScheduleEditLock {
  if (!version) {
    return {
      editable: false,
      reason: {
        title: "No schedule version yet",
        detail:
          "Sessions cannot be placed and notes and session content cannot be edited yet.",
        remedy: "Create a schedule to edit",
        tone: "info",
      },
    };
  }
  const label = `Version ${version.versionNumber}`;
  switch (version.status) {
    case "draft":
      return { editable: true, reason: null };
    case "publishing":
      return {
        editable: false,
        reason: {
          title: `${label} is publishing`,
          detail: `${FROZEN_SURFACES} while publication runs.`,
          remedy: "Wait for publication to finish",
          tone: "info",
        },
      };
    case "published":
      return {
        editable: false,
        reason: {
          title: `${label} is published`,
          detail: `${FROZEN_SURFACES}.`,
          remedy: NEXT_DRAFT_REMEDY,
          tone: "info",
        },
      };
    case "archived":
      return {
        editable: false,
        reason: {
          title: `${label} is archived`,
          detail: `${FROZEN_SURFACES} on an archived version.`,
          remedy: NEXT_DRAFT_REMEDY,
          tone: "info",
        },
      };
    case "failed":
      return {
        editable: false,
        reason: {
          title: `${label} failed to publish`,
          detail: `${FROZEN_SURFACES} after a failed publication.`,
          remedy: NEXT_DRAFT_REMEDY,
          tone: "warning",
        },
      };
    default:
      throw new Error(
        `Unsupported schedule version status: ${version.status}.`,
      );
  }
}

import type { ScheduleConflict } from "./schedule-rules";

export function scheduleConflictFingerprint(
  entryId: string,
  conflict: Pick<
    ScheduleConflict,
    | "type"
    | "conflictingEntryId"
    | "speakerId"
    | "blackoutWindowId"
    | "resource"
  >,
) {
  if (conflict.type === "speaker_unavailable") {
    const speakerId = conflict.speakerId?.trim();
    const blackoutWindowId = conflict.blackoutWindowId?.trim();
    if (!speakerId || !blackoutWindowId) {
      throw new Error(
        "A speaker unavailability conflict requires speaker and window identifiers.",
      );
    }
    return `speaker_unavailable:${entryId}:${speakerId}:${blackoutWindowId}`;
  }
  if (
    conflict.type === "resource_configuration" ||
    conflict.type === "room_resource"
  ) {
    const resource = conflict.resource?.trim();
    if (!resource) {
      throw new Error(
        `A ${conflict.type.replaceAll("_", " ")} conflict requires a resource identifier.`,
      );
    }
    return `${conflict.type}:${entryId}:${resource}`;
  }
  if (conflict.conflictingEntryId) {
    return `${conflict.type}:${[entryId, conflict.conflictingEntryId].sort().join(":")}`;
  }
  return `${conflict.type}:${entryId}`;
}

export function scheduleConflictDetailsJson(conflict: ScheduleConflict) {
  return JSON.stringify({
    message: conflict.message,
    ...(conflict.speakerId ? { speakerId: conflict.speakerId } : {}),
    ...(conflict.blackoutWindowId
      ? { blackoutWindowId: conflict.blackoutWindowId }
      : {}),
    ...(conflict.resource ? { resource: conflict.resource } : {}),
  });
}

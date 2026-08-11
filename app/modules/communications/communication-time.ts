import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";

const LOCAL_DATE_TIME =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/;

export function communicationScheduledEpoch(
  localDateTime: string,
  eventTimezone: string,
) {
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (!match?.groups) {
    throw new Error(
      "Scheduled delivery time must be a complete local date and time.",
    );
  }
  const boundaryEpoch = Date.parse(`${match.groups.date}T00:00:00Z`) / 1_000;
  if (
    !Number.isInteger(boundaryEpoch) ||
    new Date(boundaryEpoch * 1_000).toISOString().slice(0, 10) !==
      match.groups.date
  ) {
    throw new Error("Scheduled delivery date is invalid.");
  }
  return eventLocalTimeEpoch(
    boundaryEpoch,
    eventTimezone,
    Number(match.groups.hour),
    Number(match.groups.minute),
  );
}

export function assertCommunicationScheduleStillMatchesPreview(
  previewedEpoch: unknown,
  authoritativeEpoch: number,
) {
  const parsed =
    typeof previewedEpoch === "string" && /^\d+$/.test(previewedEpoch)
      ? Number(previewedEpoch)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "The scheduled delivery preview is missing. Preview the recipients again.",
    );
  }
  if (parsed !== authoritativeEpoch) {
    throw new Error(
      "The event timezone or scheduled delivery time changed after preview. Preview the recipients again.",
    );
  }
}

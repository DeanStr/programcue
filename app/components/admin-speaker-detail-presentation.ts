import type { EventFieldDefinitionValue } from "~/modules/fields/event-field-types";
import type { SpeakerService } from "~/modules/speakers/speaker-service.server";

export type AdminSpeakerDetailLoaderData = {
  detail: Awaited<ReturnType<SpeakerService["getAdminSpeakerDetail"]>>;
  availability: Awaited<ReturnType<SpeakerService["listAdminAvailability"]>>;
  customFields: EventFieldDefinitionValue[];
};

export function formatTimestamp(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function formatBytes(sizeBytes: number | null) {
  if (sizeBytes === null) return "Size unknown";
  return `${(sizeBytes / 1_048_576).toFixed(sizeBytes < 1_048_576 ? 2 : 1)} MB`;
}

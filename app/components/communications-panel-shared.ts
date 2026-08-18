import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";

export type PendingIntent = FormDataEntryValue | null | undefined;
export type SelectedTemplate = CommunicationsCentreLoaderData["selected"];

export function formatCommunicationDate(
  epoch: number | null,
  timezone: string,
) {
  return epoch
    ? `${new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "long",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))} (${timezone})`
    : "—";
}

export function formatCommunicationListDate(
  epoch: number | null,
  timezone: string,
) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))
    : "—";
}

export function communicationCategoryLabel(category: string) {
  return category
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

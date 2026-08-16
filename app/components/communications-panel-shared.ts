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

export function communicationCategoryLabel(category: string) {
  return category
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

import type { SpeakerDashboardData } from "~/routes/speaker-dashboard";

export type SpeakerPortal = SpeakerDashboardData["portal"];
export type SpeakerTask = SpeakerDashboardData["tasks"][number];

export function speakerStatusClass(status: string) {
  if (["completed", "waived", "active", "published"].includes(status))
    return "success";
  if (["overdue", "rejected", "infected", "failed"].includes(status))
    return "danger";
  if (["blocked", "pending", "submitted"].includes(status)) return "warning";
  return "info";
}

export function speakerDueLabel(epoch: number | null, timezone: string) {
  return epoch
    ? `${new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))} (${timezone})`
    : "No due date";
}

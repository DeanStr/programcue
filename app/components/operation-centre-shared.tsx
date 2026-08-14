import {
  EventDateTime,
  formatEventDateTime,
} from "~/components/ui/event-date-time";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { fieldLabel, fieldValue } from "~/lib/record-labels";
import type { loader } from "~/routes/operation-centre.server";

export type OperationCentreData = Awaited<ReturnType<typeof loader>>;

export function OperationDateTime({
  epoch,
  timeZone,
}: {
  epoch: number;
  timeZone: string;
}) {
  return (
    <EventDateTime epochSeconds={epoch} timeZone={timeZone}>
      {formatEventDateTime(epoch, timeZone, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </EventDateTime>
  );
}

export function operationItemLink(
  entityType: string | null,
  entityId: string | null,
) {
  if (!entityType || !entityId) return null;
  if (["submission", "review", "decision"].includes(entityType))
    return `/admin/submissions/${encodeURIComponent(entityId)}`;
  if (["session", "schedule_entry"].includes(entityType))
    return `/admin/schedule?session=${encodeURIComponent(entityId)}`;
  if (["task", "task_instance"].includes(entityType))
    return `/admin/tasks?task=${encodeURIComponent(entityId)}`;
  if (["speaker", "person"].includes(entityType))
    return `/admin/speakers?person=${encodeURIComponent(entityId)}`;
  if (["communication", "communication_delivery"].includes(entityType))
    return "/admin/communications";
  if (
    ["integration", "integration_run", "integration_run_item"].includes(
      entityType,
    )
  )
    return "/admin/integrations";
  return null;
}

export function operationMetadataSummary(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 4);
  return entries.length
    ? entries
        .map(([key, item]) => `${fieldLabel(key)}: ${fieldValue(item)}`)
        .join(" · ")
    : null;
}

const taskImportTransitions = new Set([
  "progress",
  "complete",
  "approve",
  "waive",
  "reopen",
]);

export function taskImportTransitionSummary(value: unknown) {
  if (!value || typeof value !== "object" || !("values" in value)) return null;
  const values = value.values;
  if (!values || typeof values !== "object" || !("statusTransition" in values))
    return null;
  const fields = values as Record<string, unknown>;
  if (fields.statusTransition === "none") return null;
  if (
    typeof fields.statusTransition !== "string" ||
    !taskImportTransitions.has(fields.statusTransition) ||
    typeof fields.expectedStatus !== "string" ||
    typeof fields.status !== "string" ||
    typeof fields.id !== "string" ||
    typeof fields.title !== "string"
  ) {
    throw new Error(
      "A task import preview contains an invalid lifecycle transition.",
    );
  }
  return {
    taskId: fields.id,
    title: fields.title,
    beforeStatus: fields.expectedStatus,
    afterStatus: fields.status,
    transition: fields.statusTransition,
  };
}

/** A task status as it is worded everywhere else in the product. */
export function operationTaskStatusLabel(value: string) {
  return statusPresentation("task", value).label;
}

export function metadataOperationId(value: unknown) {
  if (!value || typeof value !== "object" || !("operationId" in value))
    return null;
  return typeof value.operationId === "string" ? value.operationId : null;
}

import { z } from "zod";

export const deliverablesFilterSchema = z.object({
  q: z.string().trim().max(200).default(""),
  template: z.string().max(200).default(""),
  state: z
    .enum([
      "all",
      "outstanding",
      "overdue",
      "submitted",
      "complete",
      "unassigned",
    ])
    .default("all"),
  page: z.coerce.number().int().min(1).default(1),
  columns: z.coerce.number().int().min(1).default(1),
});

export type DeliverablesFilters = z.infer<typeof deliverablesFilterSchema>;
export type DeliverableTask = {
  id: string;
  templateId: string | null;
  targetType: string;
  targetId: string;
  title: string;
  status: string;
  taskType: string;
  dueAt: number | null;
  participantActionable: boolean;
};

export function deliverableComplete(task: Pick<DeliverableTask, "status">) {
  return task.status === "completed" || task.status === "waived";
}

export function deliverableOverdue(task: DeliverableTask, now: number) {
  return (
    !deliverableComplete(task) &&
    task.status !== "submitted" &&
    (task.status === "overdue" || (task.dueAt !== null && task.dueAt < now))
  );
}

export function buildDeliverables<T extends DeliverableTask>(
  workspace: {
    speakers: Array<{ id: string; name: string; email: string }>;
    templates: Array<{
      id: string;
      name: string;
      targetType: string;
      status: string;
    }>;
    tasks: T[];
  },
  filters: DeliverablesFilters,
  now: number,
) {
  const tasks = workspace.tasks.filter((task) => task.targetType === "speaker");
  const key = (task: T) => task.templateId ?? `task:${task.id}`;
  const columns = new Map(
    workspace.templates
      .filter(
        (template) =>
          template.targetType === "speaker" &&
          (template.status === "active" ||
            tasks.some((task) => task.templateId === template.id)),
      )
      .map((template) => [
        template.id,
        { id: template.id, name: template.name },
      ]),
  );
  for (const task of tasks) {
    if (!columns.has(key(task)))
      columns.set(key(task), { id: key(task), name: task.title });
  }
  const selectedColumns = [...columns.values()].filter(
    (column) => !filters.template || column.id === filters.template,
  );
  const matches = (task: T) => {
    switch (filters.state) {
      case "all":
        return true;
      case "outstanding":
        return !deliverableComplete(task);
      case "overdue":
        return deliverableOverdue(task, now);
      case "submitted":
        return task.status === "submitted";
      case "complete":
        return deliverableComplete(task);
      case "unassigned":
        return false;
    }
  };
  const rows = workspace.speakers
    .filter((speaker) =>
      `${speaker.name} ${speaker.email}`
        .toLowerCase()
        .includes(filters.q.toLowerCase()),
    )
    .map((speaker) => {
      const cells = selectedColumns.map((column) => ({
        columnId: column.id,
        // Retain every assignment: a template can have multiple historical instances.
        tasks: tasks.filter(
          (task) => task.targetId === speaker.id && key(task) === column.id,
        ),
      }));
      const matchingTasks = cells.flatMap((cell) => cell.tasks.filter(matches));
      return { ...speaker, cells, matchingTasks };
    })
    .filter(
      (row) =>
        filters.state === "all" ||
        (filters.state === "unassigned"
          ? row.cells.some((cell) => !cell.tasks.length)
          : row.matchingTasks.length > 0),
    );
  const recipients = rows.filter((row) =>
    row.matchingTasks.some(
      (task) =>
        !deliverableComplete(task) &&
        task.status !== "submitted" &&
        task.taskType !== "administrator_only" &&
        task.participantActionable,
    ),
  );
  return {
    columns: selectedColumns,
    allColumns: [...columns.values()],
    rows,
    recipients,
  };
}

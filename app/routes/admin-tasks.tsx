import { data, useActionData, useNavigation } from "react-router";
import { ZodError, z } from "zod";
import { AdminTasksWorkspace } from "~/components/admin-tasks-workspace";
import { calculateReadiness } from "~/modules/readiness/readiness-rules";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  normalizeTaskTemplateDraft,
  type TaskTemplateDraftValues,
  taskFormFieldsJsonSchema,
} from "~/modules/tasks/task-schema";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-tasks";

export const meta = () => [{ title: "Tasks & Readiness · Program Cue" }];

const taskFiltersSchema = z
  .object({
    task: z.string().max(200),
    state: z.enum([
      "",
      "open",
      "not_started",
      "in_progress",
      "blocked",
      "submitted",
      "completed",
      "waived",
      "overdue",
    ]),
    impact: z.enum(["", "critical", "high", "medium", "low"]),
    target: z.enum(["", "speaker", "session", "event"]),
    type: z.enum([
      "",
      "checklist",
      "acknowledgement",
      "short_form",
      "file_upload",
      "link_visit",
      "administrator_only",
    ]),
  })
  .strict();

function exactSearchValue(search: URLSearchParams, key: string) {
  const values = search.getAll(key);
  if (values.length > 1) {
    throw new Response("Invalid task filters", { status: 400 });
  }
  return values[0] ?? "";
}

export function parseTaskFilters(search: URLSearchParams) {
  const parsed = taskFiltersSchema.safeParse({
    task: exactSearchValue(search, "task"),
    state: exactSearchValue(search, "state"),
    impact: exactSearchValue(search, "impact"),
    target: exactSearchValue(search, "target"),
    type: exactSearchValue(search, "type"),
  });
  if (!parsed.success) {
    throw new Response("Invalid task filters", { status: 400 });
  }
  return parsed.data;
}

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const filters = parseTaskFilters(new URL(request.url).searchParams);
  const workspace = await new TaskService(env).getAdminWorkspace(viewer);
  const requestedTaskId = filters.task;
  if (
    requestedTaskId &&
    !workspace.tasks.some((task) => task.id === requestedTaskId)
  )
    throw new Response("Task not found in this event", { status: 404 });
  const open = new Set([
    "not_started",
    "in_progress",
    "blocked",
    "submitted",
    "overdue",
  ]);
  const now = Math.floor(Date.now() / 1_000);
  const isOverdue = (task: (typeof workspace.tasks)[number]) =>
    open.has(task.status) &&
    (task.status === "overdue" ||
      task.readinessState === "overdue" ||
      (task.dueAt !== null && task.dueAt < now));
  const readinessTasks = workspace.tasks.filter(
    (task) => task.readinessRelevant,
  );
  const tasks = workspace.tasks
    .filter((task) => {
      const stateMatches =
        !filters.state ||
        (filters.state === "open"
          ? open.has(task.status)
          : filters.state === "overdue"
            ? isOverdue(task)
            : task.status === filters.state);
      return (
        (!filters.task || task.id === filters.task) &&
        stateMatches &&
        (!filters.impact || task.impact === filters.impact) &&
        (!filters.target || task.targetType === filters.target) &&
        (!filters.type || task.taskType === filters.type)
      );
    })
    .map((task) => ({ ...task, isOverdue: isOverdue(task) }));
  /* Summary tiles describe the event, not whichever rows happen to match the
     current table filter. In particular, an empty filter result must not turn
     a partially ready event into a 100% one. */
  const taskSummary = {
    readiness: calculateReadiness(
      readinessTasks.map((task) => ({
        id: task.id,
        impact: task.impact,
        readinessPercent: ["completed", "waived"].includes(task.status)
          ? 100
          : task.readinessPercent,
      })),
    ).percentage,
    outstanding: readinessTasks.filter(
      (task) => !["completed", "waived"].includes(task.status),
    ).length,
    evidenceReview: readinessTasks.filter((task) => task.status === "submitted")
      .length,
    blocked: readinessTasks.filter((task) => task.status === "blocked").length,
    overdue: readinessTasks.filter(isOverdue).length,
  };
  const filterSignature = JSON.stringify(filters);
  return {
    ...workspace,
    tasks,
    filters,
    filterSignature,
    focusedTaskId: requestedTaskId || null,
    totalTaskCount: workspace.tasks.length,
    taskSummary,
    /* Due distances are rendered from the server clock so the first paint and
       the hydrated tree agree. */
    now,
    intentId: crypto.randomUUID(),
    assignIntentId: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new TaskService(env);
  const formFieldsJson = String(form.get("formFieldsJson") ?? "[]");
  const structuredFormRequired =
    intent === "create-template" && form.get("taskType") === "short_form";
  const formFieldsDraft = structuredFormRequired
    ? taskFormFieldsJsonSchema.safeParse(formFieldsJson)
    : { success: true as const, data: [] };
  const taskTemplateInput =
    intent === "create-template"
      ? {
          name: form.get("name"),
          description: form.get("description"),
          targetType: form.get("targetType"),
          taskType: form.get("taskType"),
          impact: form.get("impact"),
          evidenceMode: form.get("evidenceMode"),
          dueAnchor: form.get("dueAnchor"),
          dueOffsetDays: form.get("dueOffsetDays"),
          fixedDueDate: form.get("fixedDueDate"),
          destinationUrl: form.get("destinationUrl"),
          fileScope: form.get("fileScope"),
          fileKind: form.get("fileKind"),
          formFields: formFieldsDraft.success ? formFieldsDraft.data : [],
          autoAssignOnAcceptance: form.get("autoAssignOnAcceptance") === "true",
          dependencyIds: form.getAll("dependencyIds").map(String),
        }
      : undefined;
  const taskTemplateDraft: TaskTemplateDraftValues | undefined =
    taskTemplateInput
      ? normalizeTaskTemplateDraft(taskTemplateInput)
      : undefined;
  const retainedTaskTemplateDraft = formFieldsDraft.success
    ? taskTemplateDraft
    : undefined;
  try {
    if (intent === "create-travel-onboarding") {
      const templates = await service.createTravelOnboardingTemplates(
        viewer,
        form.get("confirmed") === "create-travel-onboarding",
      );
      const realtimeFailures = await Promise.all(
        templates.createdTemplateIds.map((templateId) =>
          recordRouteChange(env, viewer, {
            entityType: "task_template",
            entityId: templateId,
            changeType: "created",
          }),
        ),
      );
      const warning = realtimeFailures
        .map((failure) => failure?.message)
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({
        ok: true,
        message:
          templates.createdTemplateIds.length === 0
            ? "Hotel stay and flight reimbursement forms were already ready. No duplicates were created."
            : "Hotel stay and flight reimbursement forms are ready and will be assigned automatically on acceptance.",
      });
    }
    if (intent === "create-session-details-review") {
      const result = await service.createSessionDetailsReviewTemplate(
        viewer,
        form.get("confirmed") === "create-session-details-review",
      );
      const realtimeFailure = result.created
        ? await recordRouteChange(env, viewer, {
            entityType: "task_template",
            entityId: result.templateId,
            changeType: "created",
          })
        : null;
      if (realtimeFailure)
        return data({ ...realtimeFailure, committed: true }, { status: 207 });
      return data({
        ok: true,
        message: result.created
          ? "The optional session-details review task is ready and will be assigned automatically on future acceptances."
          : "The session-details review task was already ready. No duplicate was created.",
      });
    }
    if (intent === "create-template") {
      const draft = taskTemplateDraft;
      if (!draft || !taskTemplateInput) {
        throw new Error("The task template draft is unavailable.");
      }
      const structuredFields =
        taskTemplateInput.taskType === "short_form"
          ? taskFormFieldsJsonSchema.parse(formFieldsJson)
          : null;
      const templateInput = {
        name: taskTemplateInput.name,
        description: taskTemplateInput.description,
        targetType: taskTemplateInput.targetType,
        taskType: taskTemplateInput.taskType,
        impact: taskTemplateInput.impact,
        evidenceMode: taskTemplateInput.evidenceMode,
        dueAnchor: taskTemplateInput.dueAnchor,
        dueOffsetDays:
          taskTemplateInput.dueOffsetDays === "" ||
          taskTemplateInput.dueOffsetDays === null
            ? null
            : taskTemplateInput.dueOffsetDays,
        fixedDueDate:
          taskTemplateInput.fixedDueDate === "" ||
          taskTemplateInput.fixedDueDate === null
            ? null
            : taskTemplateInput.fixedDueDate,
        autoAssignOnAcceptance: taskTemplateInput.autoAssignOnAcceptance,
        dependencyIds: taskTemplateInput.dependencyIds,
      };
      const templateId = await service.createTemplate(
        viewer,
        {
          ...templateInput,
          configuration:
            taskTemplateInput.taskType === "short_form"
              ? { form: { fields: structuredFields ?? [] } }
              : taskTemplateInput.taskType === "link_visit"
                ? {
                    destinationUrl: String(
                      taskTemplateInput.destinationUrl ?? "",
                    ),
                  }
                : taskTemplateInput.taskType === "file_upload"
                  ? {
                      fileScope: taskTemplateInput.fileScope,
                      ...(taskTemplateInput.fileKind
                        ? { fileKind: taskTemplateInput.fileKind }
                        : {}),
                    }
                  : {},
        },
        String(form.get("intentId") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_template",
        entityId: templateId,
        changeType: "created",
      });
      if (realtimeFailure)
        return data(
          {
            ...realtimeFailure,
            committed: true,
            intent: "create-template" as const,
          },
          { status: 207 },
        );
      return data({
        ok: true,
        intent: "create-template" as const,
        message: "Task template created.",
      });
    }
    if (intent === "assign") {
      const result = await service.assignTemplate(
        viewer,
        String(form.get("templateId") ?? ""),
        String(form.get("targetId") ?? ""),
        z.uuid().parse(form.get("assignIntentId")),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: result.taskId,
        changeType: "updated",
      });
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({
        ok: true,
        message: "Task plan assigned, including any missing prerequisites.",
      });
    }
    if (intent === "extend-deadline") {
      const taskId = String(form.get("taskId") ?? "");
      const result = await service.extendSpeakerDeadline(viewer, {
        taskId,
        revision: form.get("revision"),
        dueDate: form.get("dueDate"),
        reason: form.get("reason"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning) {
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      }
      return data({
        ok: true,
        message: "Speaker deadline extended for this task only.",
      });
    }
    if (["approve", "complete", "waive", "reopen"].includes(intent)) {
      const taskId = String(form.get("taskId") ?? "");
      const reason = form.get("reason") ?? undefined;
      const result = await service.administerTask(viewer, {
        taskId,
        revision: form.get("revision"),
        intent,
        reason,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      const undo = result.undoToken
        ? {
            undoToken: result.undoToken,
            undoTaskId: taskId,
            undoExpiresAt: result.undoExpiresAt,
          }
        : {};
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning, ...undo },
          { status: 207 },
        );
      return data({
        ok: true,
        message:
          intent === "complete" && result.undoToken
            ? "Task completed. You can undo this for five minutes."
            : `Task ${intent === "approve" ? "approved" : intent === "waive" ? "waived" : intent === "reopen" ? "reopened" : "completed"}.`,
        ...undo,
      });
    }
    if (intent === "undo-task-completion") {
      const result = await service.undoCompletion(
        viewer,
        form.get("undoToken"),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: result.taskId,
        changeType: "progress",
      });
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({ ok: true, message: "Task completion undone." });
    }
    if (intent === "comment") {
      const taskId = String(form.get("taskId") ?? "");
      const result = await service.addComment(
        viewer,
        taskId,
        String(form.get("body") ?? ""),
        form.get("administratorOnly") ? "administrator" : "participant",
        String(form.get("intentId") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "updated",
      });
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({ ok: true, message: "Comment added." });
    }
    return data(
      { ok: false, message: "Unsupported task action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the task details.",
          draft: retainedTaskTemplateDraft,
          errors: Object.entries(error.flatten().fieldErrors).reduce(
            (fieldErrors, [key, value]) => {
              if (Array.isArray(value)) fieldErrors[key] = value.map(String);
              return fieldErrors;
            },
            {} as Record<string, string[]>,
          ),
        },
        { status: 422 },
      );
    }
    if (error instanceof TaskStateError) {
      return data(
        { ok: false, message: error.message, draft: retainedTaskTemplateDraft },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export type AdminTasksData = Route.ComponentProps["loaderData"];

export default function AdminTasks({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <AdminTasksWorkspace
      data={loaderData}
      actionNotice={actionData}
      busy={navigation.state !== "idle"}
    />
  );
}

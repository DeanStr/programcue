import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-tasks";
import { AdminTasksWorkspace } from "~/components/admin-tasks-workspace";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Tasks & Readiness · Program Cue" }];

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
  const workspace = await new TaskService(env).getAdminWorkspace(viewer);
  const search = new URL(request.url).searchParams;
  const requestedTaskId = search.get("task")?.trim() ?? "";
  if (requestedTaskId.length > 200)
    throw new Response("Invalid task focus", { status: 400 });
  if (
    requestedTaskId &&
    !workspace.tasks.some((task) => task.id === requestedTaskId)
  )
    throw new Response("Task not found in this event", { status: 404 });
  const filters = {
    task: requestedTaskId,
    state: search.get("state") ?? "",
    impact: search.get("impact") ?? "",
    target: search.get("target") ?? "",
    type: search.get("type") ?? "",
  };
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
  return {
    ...workspace,
    tasks,
    filters,
    focusedTaskId: requestedTaskId || null,
    totalTaskCount: workspace.tasks.length,
    intentId: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new TaskService(env);
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
    if (intent === "create-template") {
      const templateId = await service.createTemplate(
        viewer,
        {
          name: form.get("name"),
          description: form.get("description"),
          targetType: form.get("targetType"),
          taskType: form.get("taskType"),
          impact: form.get("impact"),
          evidenceMode: form.get("evidenceMode"),
          dueAnchor: form.get("dueAnchor"),
          dueOffsetDays:
            form.get("dueOffsetDays") === "" ? null : form.get("dueOffsetDays"),
          fixedDueDate:
            form.get("fixedDueDate") === "" ? null : form.get("fixedDueDate"),
          autoAssignOnAcceptance: form.get("autoAssignOnAcceptance") === "true",
          dependencyIds: form.getAll("dependencyIds").map(String),
          configuration: {},
        },
        String(form.get("intentId") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_template",
        entityId: templateId,
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Task template created." });
    }
    if (intent === "assign") {
      const result = await service.assignTemplate(
        viewer,
        String(form.get("templateId") ?? ""),
        String(form.get("targetId") ?? ""),
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
    if (["approve", "complete", "waive", "reopen"].includes(intent)) {
      const taskId = String(form.get("taskId") ?? "");
      const result = await service.administerTask(viewer, {
        taskId,
        revision: form.get("revision"),
        intent,
        reason: form.get("reason"),
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
        },
        { status: 422 },
      );
    }
    if (error instanceof TaskStateError) {
      return data({ ok: false, message: error.message }, { status: 409 });
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

import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerTasksPanel } from "~/components/speaker-tasks-panel";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import { FileService } from "~/modules/files/file-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/speaker-tasks";

export const meta = () => [{ title: "Participant Tasks · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const tasks = await new TaskService(env).listParticipantTasks(viewer);
  const versions = await new FileService(
    env,
  ).listParticipantTaskEvidenceVersions(
    viewer,
    tasks.map((task) => task.id),
  );
  const search = new URL(request.url).searchParams;
  const requestedTaskId = search.get("task");
  const composeTaskId =
    search.get("compose") === "comment" &&
    requestedTaskId &&
    tasks.some((task) => task.id === requestedTaskId)
      ? requestedTaskId
      : null;
  return {
    tasks: tasks.map((task) => ({
      ...task,
      fileVersions: versions.filter((version) => version.taskId === task.id),
    })),
    intentId: crypto.randomUUID(),
    composeTaskId,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "complete-task") {
      const taskId = String(form.get("taskId") ?? "");
      const responses = Object.fromEntries(
        [...form.entries()]
          .filter(([name]) => name.startsWith("response."))
          .map(([name, value]) => [
            name.slice("response.".length),
            String(value),
          ]),
      );
      const result = await new TaskService(env).completeParticipant(viewer, {
        taskId,
        revision: form.get("revision"),
        confirmed: form.get("confirmed") ?? "false",
        text: form.get("text") || undefined,
        responses,
        sessionDetailsFingerprint:
          form.get("sessionDetailsFingerprint") || undefined,
        sessionDetailsRevision: form.get("sessionDetailsRevision") || undefined,
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
      if (warning) {
        return data(
          { ok: false, committed: true, message: warning, ...undo },
          { status: 207 },
        );
      }
      return data({
        ok: true,
        message: result.undoToken
          ? "Task completed. You can undo this for five minutes."
          : "Task updated.",
        ...undo,
      });
    }
    if (intent === "undo-task-completion") {
      const result = await new TaskService(env).undoCompletion(
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
      if (warning) {
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      }
      return data({ ok: true, message: "Task completion undone." });
    }
    if (intent === "comment") {
      const taskId = String(form.get("taskId") ?? "");
      const result = await new TaskService(env).addComment(
        viewer,
        taskId,
        String(form.get("body") ?? ""),
        "participant",
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
      if (warning) {
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      }
      return data({ ok: true, message: "Comment added." });
    }
    return data(
      { ok: false, message: "Unsupported participant task action." },
      { status: 400 },
    );
  } catch (error) {
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Review the highlighted information.")
        : error instanceof TaskStateError
          ? error.message
          : null;
    if (message) {
      return data(
        { ok: false, message },
        { status: error instanceof TaskStateError ? 409 : 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SpeakerTasks({ loaderData }: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const finished = loaderData.tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>Complete event requirements and keep the team informed.</p>
        </div>
        <p className="speaker-work-count">
          <b className="pc-num">{finished}</b>
          <span>of {loaderData.tasks.length} complete</span>
        </p>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <SpeakerTasksPanel
        portal={portal}
        tasks={loaderData.tasks}
        finished={finished}
        busy={navigation.state !== "idle"}
        intentId={loaderData.intentId}
        composeTaskId={loaderData.composeTaskId}
      />
    </>
  );
}

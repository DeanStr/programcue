import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/speaker-dashboard";
import {
  SpeakerDashboardOverview,
  SpeakerFilesAndProfilePanels,
  SpeakerSessionsPanel,
  SpeakerTasksPanel,
} from "~/components/speaker-dashboard-panels";
import { SpeakerShell } from "~/components/speaker-shell";
import { FilePolicyError } from "~/modules/files/file-policy";
import { FileService } from "~/modules/files/file-service.server";
import {
  ensureDemoSpeakerData,
  requireSpeakerViewer,
} from "~/modules/speakers/demo.server";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Speaker Dashboard · Program Cue" }];

function formatEvent(event: {
  timezone: string;
  startsAt: number;
  endsAt: number;
  venue: string | null;
  city: string | null;
}) {
  // Event setup persists whole-day boundaries at UTC midnight; format those as calendar dates.
  const format = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    dateLabel: `${format.format(new Date(event.startsAt * 1_000))}–${format.format(new Date(event.endsAt * 1_000))}`,
    locationLabel: [event.venue, event.city].filter(Boolean).join(", "),
  };
}

async function participant(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireSpeakerViewer(request, env, env.DEFAULT_EVENT_ID);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await participant(request, context);
  const [portal, tasks] = await Promise.all([
    new SpeakerService(env).getPortal(viewer),
    new TaskService(env).listParticipantTasks(viewer),
  ]);
  return { portal, tasks, viewer };
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the highlighted information.";
  if (
    error instanceof FilePolicyError ||
    error instanceof TaskStateError ||
    error instanceof SpeakerProfileConflictError
  )
    return error.message;
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await participant(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "save-profile") {
      await new SpeakerService(env).updateProfile(viewer, {
        revision: form.get("revision"),
        name: form.get("name"),
        biography: form.get("biography"),
        pronunciation: form.get("pronunciation"),
        organisationName: form.get("organisationName"),
        jobTitle: form.get("jobTitle"),
        publish: form.get("publish") ? "true" : "false",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "person",
        entityId: viewer.personId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Profile saved to D1." });
    }
    if (intent === "complete-task") {
      const taskId = String(form.get("taskId") ?? "");
      await new TaskService(env).completeParticipant(viewer, {
        taskId,
        revision: form.get("revision"),
        confirmed: form.get("confirmed") ?? "false",
        text: form.get("text") || undefined,
        url: form.get("url") || undefined,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Task updated." });
    }
    if (intent === "comment") {
      const taskId = String(form.get("taskId") ?? "");
      await new TaskService(env).addComment(
        viewer,
        taskId,
        String(form.get("body") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Comment added." });
    }
    if (intent === "upload-task") {
      const taskId = String(form.get("taskId") ?? "");
      const file = form.get("file");
      if (!(file instanceof File))
        throw new FilePolicyError("Choose a file to upload.");
      const taskService = new TaskService(env);
      await taskService.assertFileEvidenceUploadAllowed(viewer, taskId);
      const fileService = new FileService(env);
      const upload = await fileService.uploadParticipantFile(
        viewer,
        { targetType: "task", targetId: taskId, assetKind: "task_evidence" },
        file,
      );
      try {
        await taskService.submitFileEvidence(viewer, taskId, upload.assetId);
      } catch (submissionError) {
        try {
          await fileService.discardUnattachedTaskUpload(viewer, upload);
        } catch (cleanupError) {
          throw new AggregateError(
            [submissionError, cleanupError],
            "Task evidence submission failed and the uploaded file could not be discarded.",
          );
        }
        throw submissionError;
      }
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "File stored privately in R2 and submitted for scanning. It remains quarantined until a scanner reports it clean.",
      });
    }
    if (intent === "upload-file") {
      const file = form.get("file");
      if (!(file instanceof File))
        throw new FilePolicyError("Choose a file to upload.");
      const kind = String(form.get("assetKind") ?? "");
      const upload = await new FileService(env).uploadParticipantFile(
        viewer,
        { targetType: "person", targetId: viewer.personId, assetKind: kind },
        file,
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "file_asset",
        entityId: upload.assetId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "File stored privately in R2. Signature validation passed; malware scanning is still pending, so the file remains quarantined.",
      });
    }
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  } catch (error) {
    const message = errorMessage(error);
    if (message) {
      return data(
        { ok: false, message },
        {
          status:
            error instanceof SpeakerProfileConflictError ||
            error instanceof TaskStateError
              ? 409
              : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export type SpeakerDashboardData = Route.ComponentProps["loaderData"];

export default function SpeakerDashboard({ loaderData }: Route.ComponentProps) {
  const { portal, tasks, viewer } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const finished = tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const progress = tasks.length
    ? Math.round((finished / tasks.length) * 100)
    : 100;
  const next = tasks.find(
    (task) => !["completed", "waived"].includes(task.status),
  );
  const eventLabel = formatEvent(portal.event);
  const busy = navigation.state !== "idle";
  return (
    <SpeakerShell
      event={{ name: portal.event.name, ...eventLabel }}
      viewer={viewer}
    >
      <SpeakerDashboardOverview
        portal={portal}
        next={next}
        progress={progress}
        actionNotice={actionData}
      />
      <SpeakerSessionsPanel portal={portal} />
      <SpeakerTasksPanel
        portal={portal}
        tasks={tasks}
        finished={finished}
        busy={busy}
      />
      <SpeakerFilesAndProfilePanels portal={portal} busy={busy} />
    </SpeakerShell>
  );
}

import { data, Link, useActionData, useNavigation } from "react-router";
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
import {
  FileAccessError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileService,
} from "~/modules/files/file-service.server";
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
import { resolveCurrentEventId } from "~/platform/auth/current-event.server";
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
  await ensureDemoSpeakerData(env);
  const eventId = await resolveCurrentEventId(request, env, ["speaker"]);
  const viewer = await requireSpeakerViewer(request, env, eventId);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await participant(request, context);
  const [portal, tasks] = await Promise.all([
    new SpeakerService(env).getPortal(viewer),
    new TaskService(env).listParticipantTasks(viewer),
  ]);
  return { portal, tasks, viewer, intentId: crypto.randomUUID() };
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the highlighted information.";
  if (
    error instanceof FilePolicyError ||
    error instanceof FileAccessError ||
    error instanceof FileErasureConfirmationError ||
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
      const result = await new SpeakerService(env).updateProfile(viewer, {
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
      const warning = [result.webhookWarning, realtimeFailure?.message]
        .filter(Boolean)
        .join(" ");
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({ ok: true, message: "Profile saved to D1." });
    }
    if (intent === "complete-task") {
      const taskId = String(form.get("taskId") ?? "");
      const result = await new TaskService(env).completeParticipant(viewer, {
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
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
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
      if (warning)
        return data(
          { ok: false, committed: true, message: warning },
          { status: 207 },
        );
      return data({ ok: true, message: "Comment added." });
    }
    if (intent === "delete-file") {
      const result = await new FileService(env).eraseAsset(viewer, {
        assetId: String(form.get("assetId") ?? ""),
        confirmed: form.get("confirm") === "erase-all-versions",
        reason: "speaker_requested_file_deletion",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "file_asset",
        entityId: result.affected.id,
        changeType: "deleted",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message: result.duplicate
          ? "This file was already erased."
          : `${result.erasedVersions} stored file version${result.erasedVersions === 1 ? " was" : "s were"} permanently erased.`,
      });
    }
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof FileErasureIncompleteError) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "speaker-file-erasure",
          event: "erasure-incomplete",
          errorName: error.name,
          message: "The private file erasure did not complete.",
        }),
      );
      return data(
        { ok: false, committed: true, message: error.message },
        { status: 503 },
      );
    }
    const message = errorMessage(error);
    if (message) {
      return data(
        { ok: false, message },
        {
          status:
            error instanceof FileAccessError
              ? 403
              : error instanceof SpeakerProfileConflictError ||
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
      event={{
        name: portal.event.name,
        brandAccent: portal.event.brandAccent,
        ...eventLabel,
      }}
      viewer={viewer}
    >
      <SpeakerDashboardOverview
        portal={portal}
        next={next}
        progress={progress}
        actionNotice={actionData}
      />
      <section
        className="card pad mb"
        aria-labelledby="speaker-calendar-heading"
      >
        <div className="card-title">
          <div>
            <h2 id="speaker-calendar-heading">Calendar connection</h2>
            <p className="subtle">
              Connect your own calendar account for direct session updates. ICS
              invitations remain available without a connection.
            </p>
          </div>
        </div>
        <div className="page-actions">
          <Link className="btn small" to="/oauth/calendar/google">
            Connect Google Calendar
          </Link>
          <Link className="btn small" to="/oauth/calendar/microsoft">
            Connect Microsoft 365
          </Link>
        </div>
      </section>
      <SpeakerSessionsPanel portal={portal} />
      <SpeakerTasksPanel
        portal={portal}
        tasks={tasks}
        finished={finished}
        busy={busy}
        intentId={loaderData.intentId}
      />
      <SpeakerFilesAndProfilePanels portal={portal} busy={busy} />
    </SpeakerShell>
  );
}

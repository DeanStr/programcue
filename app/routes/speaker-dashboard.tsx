import {
  CalendarDays,
  CheckSquare,
  FileStack,
  Mic2,
  UserRound,
} from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/speaker-dashboard";
import { SpeakerDashboardOverview } from "~/components/speaker-dashboard-overview";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { TaskService } from "~/modules/tasks/task-service.server";

export const meta = () => [{ title: "Speaker Dashboard · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const tasks = await new TaskService(env).listParticipantTasks(viewer);
  return { tasks };
}

export default function SpeakerDashboard({ loaderData }: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const { tasks } = loaderData;
  const finished = tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const progress = tasks.length
    ? Math.round((finished / tasks.length) * 100)
    : 100;
  const next = tasks.find(
    (task) => !["completed", "waived"].includes(task.status),
  );
  const publishedProfile = portal.profile.profileStatus === "published";

  return (
    <>
      <SpeakerDashboardOverview
        portal={portal}
        next={next}
        progress={progress}
      />

      <section className="mt" aria-labelledby="speaker-workspaces-heading">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Your workspaces</span>
            <h2 id="speaker-workspaces-heading">
              Event preparation at a glance
            </h2>
          </div>
        </div>
        <div className="grid grid-2">
          <Link
            className="card pad speaker-session-card"
            to="/speaker/sessions"
          >
            <Mic2 aria-hidden className="subtle" />
            <h3>My sessions</h3>
            <p className="subtle">
              {portal.sessions.length} linked session
              {portal.sessions.length === 1 ? "" : "s"}
            </p>
          </Link>
          <Link className="card pad speaker-session-card" to="/speaker/tasks">
            <CheckSquare aria-hidden className="subtle" />
            <h3>Tasks</h3>
            <p className="subtle">
              {tasks.length - finished} outstanding · {finished} complete
            </p>
          </Link>
          <Link className="card pad speaker-session-card" to="/speaker/files">
            <FileStack aria-hidden className="subtle" />
            <h3>Files</h3>
            <p className="subtle">
              {portal.files.length} private file
              {portal.files.length === 1 ? "" : "s"}
            </p>
          </Link>
          <Link className="card pad speaker-session-card" to="/speaker/profile">
            <UserRound aria-hidden className="subtle" />
            <h3>Profile</h3>
            <p className="subtle">
              {publishedProfile
                ? "Published"
                : "Draft — review before publishing"}
            </p>
          </Link>
        </div>
      </section>

      <section
        className="card pad mt"
        aria-labelledby="speaker-calendar-heading"
      >
        <div className="card-title">
          <div>
            <CalendarDays aria-hidden className="subtle" />
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
    </>
  );
}

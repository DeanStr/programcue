import {
  CalendarDays,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  FileStack,
  Mic2,
  UserRound,
} from "lucide-react";
import { Link } from "react-router";
import {
  SpeakerDashboardOverview,
  SpeakerUpdatesRail,
} from "~/components/speaker-dashboard-overview";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { ParticipantApplicationSummaryService } from "~/modules/submissions/participant-application-summary.server";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { Route } from "./+types/speaker-dashboard";

export const meta = () => [{ title: "Participant Overview · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const [tasks, applications] = await Promise.all([
    new TaskService(env).listParticipantTasks(viewer),
    new ParticipantApplicationSummaryService(env).list(viewer),
  ]);
  return { tasks, applications };
}

export default function SpeakerDashboard({ loaderData }: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const { tasks } = loaderData;
  const finished = tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const next = tasks.find(
    (task) => !["completed", "waived"].includes(task.status),
  );
  const publishedProfile = portal.profile.profileStatus === "published";

  return (
    <>
      {portal.event.participantWelcomeText ? (
        <section className="card pad participant-welcome" aria-label="Welcome">
          <span className="pc-page-eyebrow">From the event team</span>
          <p>{portal.event.participantWelcomeText}</p>
        </section>
      ) : null}
      <div className="speaker-dashboard-layout">
        <div className="speaker-dashboard-main">
          <SpeakerDashboardOverview
            portal={portal}
            next={next}
            completedCount={finished}
            requirementCount={tasks.length}
          />

          <section className="mt" aria-labelledby="speaker-workspaces-heading">
            <div className="card-title">
              <h2 id="speaker-workspaces-heading">Event preparation</h2>
            </div>
            <nav
              className="pc-index-list"
              aria-labelledby="speaker-workspaces-heading"
            >
              {[
                {
                  to: "/participant/applications",
                  icon: ClipboardList,
                  label: "Applications",
                  detail: "",
                  value: `${loaderData.applications.length}`,
                  unit:
                    loaderData.applications.length === 1
                      ? "application"
                      : "applications",
                },
                {
                  to: "/participant/sessions",
                  icon: Mic2,
                  label: "My sessions",
                  detail: "",
                  value: `${portal.sessions.length}`,
                  unit: portal.sessions.length === 1 ? "session" : "sessions",
                },
                {
                  to: "/participant/tasks",
                  icon: CheckSquare,
                  label: "Tasks",
                  detail: finished ? `${finished} complete` : "",
                  value: `${tasks.length - finished}`,
                  unit: "outstanding",
                },
                {
                  to: "/participant/files",
                  icon: FileStack,
                  label: "Files",
                  detail: "",
                  value: `${portal.files.length}`,
                  unit:
                    portal.files.length === 1
                      ? "private file"
                      : "private files",
                },
                {
                  to: "/participant/profile",
                  icon: UserRound,
                  label: "Profile",
                  detail: publishedProfile
                    ? "visible on the programme"
                    : "review before publishing",
                  value: "",
                  unit: publishedProfile ? "Published" : "Draft",
                },
              ].map((entry) => (
                <Link className="pc-index-row" key={entry.to} to={entry.to}>
                  <entry.icon aria-hidden className="pc-index-icon" />
                  <span className="pc-index-label">{entry.label}</span>
                  <span className="pc-index-detail">{entry.detail}</span>
                  <span className="pc-index-measure">
                    {entry.value ? (
                      <b className="pc-index-value pc-num">{entry.value}</b>
                    ) : null}
                    <span className="pc-index-unit">{entry.unit}</span>
                  </span>
                  <ChevronRight aria-hidden className="pc-index-chevron" />
                </Link>
              ))}
            </nav>
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
                  Connect your own calendar account for direct session updates.
                  ICS invitations remain available without a connection.
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
        </div>
        <SpeakerUpdatesRail tasks={tasks} timezone={portal.event.timezone} />
      </div>
    </>
  );
}

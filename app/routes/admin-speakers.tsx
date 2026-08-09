import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileWarning,
  ListChecks,
  UserRound,
} from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/admin-speakers";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Speakers · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  return { speakers: await new SpeakerService(env).listAdminSpeakers(viewer) };
}

export default function AdminSpeakers({ loaderData }: Route.ComponentProps) {
  const ready = loaderData.speakers.filter(
    (speaker) => speaker.outstandingTasks === 0,
  ).length;
  const outstanding = loaderData.speakers.reduce(
    (count, speaker) => count + speaker.outstandingTasks,
    0,
  );
  const quarantine = loaderData.speakers.reduce(
    (count, speaker) => count + speaker.quarantinedFiles,
    0,
  );
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Participant operations</span>
          <h1>Speakers</h1>
          <p>
            Profiles, linked sessions, onboarding requirements and private-file
            review states.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/resources">
            <BookOpen aria-hidden size={15} /> Resources
          </Link>
          <Link className="btn primary" to="/admin/tasks">
            <ListChecks aria-hidden size={15} /> Manage tasks
          </Link>
        </div>
      </div>
      <div className="grid grid-4 mb">
        <section className="card metric">
          <div className="label">Known speakers</div>
          <div className="value">{loaderData.speakers.length}</div>
        </section>
        <section className="card metric">
          <div className="label">Ready</div>
          <div className="value">{ready}</div>
        </section>
        <section className="card metric">
          <div className="label">Outstanding tasks</div>
          <div className="value">{outstanding}</div>
        </section>
        <section className="card metric">
          <div className="label">Files quarantined</div>
          <div className="value">{quarantine}</div>
        </section>
      </div>
      {quarantine ? (
        <div className="pc-status-notice is-warning mb">
          <FileWarning aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>Malware scanning is pending</strong>
            <div>
              Quarantined files are private and unavailable for approval or
              download until a configured scanner reports them clean.
            </div>
          </div>
        </div>
      ) : null}
      <section className="card pad">
        <div className="card-title">
          <h2>Speaker readiness</h2>
          <span className="help right">
            D1 · event scoped · distinct identities
          </span>
        </div>
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Speaker</th>
                <th scope="col">Profile</th>
                <th scope="col">Sessions</th>
                <th scope="col">Tasks</th>
                <th scope="col">File security</th>
                <th scope="col">Readiness</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.speakers.length ? (
                loaderData.speakers.map((speaker) => (
                  <tr key={speaker.id}>
                    <td className="pc-record-primary-cell" data-label="Speaker">
                      <div className="row-main">
                        <span className="avatar sm">
                          {speaker.name
                            .split(/\s+/)
                            .map((part) => part[0])
                            .slice(0, 2)
                            .join("")}
                        </span>
                        <span className="pc-record-identity">
                          <strong>{speaker.name}</strong>
                          <small className="pc-record-email">{speaker.email}</small>
                          <small>{speaker.jobTitle ?? "Title not provided"}</small>
                          <small>{speaker.organisationName ?? "Organisation not provided"}</small>
                        </span>
                      </div>
                    </td>
                    <td data-label="Profile">
                      <span
                        className={`status ${speaker.profileStatus === "published" ? "success" : "warning"}`}
                      >
                        <UserRound aria-hidden size={13} />{" "}
                        {speaker.profileStatus}
                      </span>
                    </td>
                    <td data-label="Sessions">{speaker.sessionCount}</td>
                    <td data-label="Tasks">
                      <div className="pc-record-stack">
                      <span><strong>{speaker.completedTasks}</strong> complete</span>
                      <span
                        className={
                          speaker.outstandingTasks ? "impact high" : "subtle"
                        }
                      >
                        {speaker.outstandingTasks} outstanding
                      </span>
                      </div>
                    </td>
                    <td data-label="File security">
                      {speaker.quarantinedFiles ? (
                        <span className="status warning">
                          <AlertTriangle aria-hidden size={13} />{" "}
                          {speaker.quarantinedFiles} quarantined
                        </span>
                      ) : (
                        <span className="subtle">No pending files</span>
                      )}
                    </td>
                    <td data-label="Readiness">
                      {speaker.outstandingTasks === 0 ? (
                        <span className="status success">
                          <CheckCircle2 aria-hidden size={13} /> Ready
                        </span>
                      ) : (
                        <span className="status warning">Needs attention</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="pc-table-empty-row">
                  <td className="pc-table-empty-cell" colSpan={6}>
                    <div className="pc-empty-state">
                      <UserRound aria-hidden className="pc-state-icon" />
                      <h2>No speaker identities</h2>
                      <p className="subtle">
                        Accept a submission or link a speaker to a direct
                        session.
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

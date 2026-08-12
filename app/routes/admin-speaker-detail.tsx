import {
  ArrowLeft,
  CalendarClock,
  Download,
  FileCheck2,
  ListChecks,
  LockKeyhole,
  UserRound,
} from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-speaker-detail";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  SpeakerAdminStateError,
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  {
    title: loaderData
      ? `${loaderData.detail.profile.name} · Speakers · Program Cue`
      : "Speaker · Program Cue",
  },
];

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return {
    detail: await new SpeakerService(env).getAdminSpeakerDetail(
      viewer,
      params.personId,
    ),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  const intent = form.get("_intent");
  if (
    intent !== "save_speaker_profile" &&
    intent !== "confirm_external_participation"
  ) {
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "confirm_external_participation") {
      const result = await new SpeakerService(
        env,
      ).confirmExternalParticipation(viewer, params.personId, {
        sessionId: form.get("sessionId"),
        confirmation: form.get("confirmation"),
        externalConfirmation: form.get("externalConfirmation"),
      });
      const realtimeFailure = result.changed
        ? await recordRouteChange(env, viewer, {
            entityType: "session",
            entityId: result.sessionId,
            changeType: "updated",
          })
        : null;
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message: result.changed
          ? `Recorded external participation confirmation for “${result.title}”. Portal invitation acceptance remains separate.`
          : `Participation for “${result.title}” was already confirmed.`,
      });
    }
    const result = await new SpeakerService(env).updateAdminSpeakerProfile(
      viewer,
      params.personId,
      {
        revision: form.get("revision"),
        name: form.get("name"),
        biography: form.get("biography"),
        pronunciation: form.get("pronunciation"),
        organisationName: form.get("organisationName"),
        jobTitle: form.get("jobTitle"),
        profileStatus: form.get("profileStatus"),
      },
    );
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "person",
      entityId: params.personId,
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
    return data({
      ok: true,
      message: `Saved to D1 as revision ${result.revision}. The profile is ${result.profileStatus}.`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the speaker details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SpeakerProfileConflictError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof SpeakerAdminStateError) {
      return data(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function formatTimestamp(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function formatBytes(sizeBytes: number | null) {
  if (sizeBytes === null) return "Size unknown";
  return `${(sizeBytes / 1_048_576).toFixed(sizeBytes < 1_048_576 ? 2 : 1)} MB`;
}

export default function AdminSpeakerDetail({
  loaderData,
}: Route.ComponentProps) {
  const { detail } = loaderData;
  const { profile, profileShared, event, sessions, files, tasks } = detail;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Participant operations</span>
          <h1>{profile.name}</h1>
          <p>
            {[profile.jobTitle, profile.organisationName]
              .filter(Boolean)
              .join(" · ") || "No title or organisation recorded yet"}
            {" · "}
            {profile.email}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/speakers">
            <ArrowLeft aria-hidden size={15} /> Back to roster
          </Link>
          <Link className="btn" to="/admin/tasks">
            <ListChecks aria-hidden size={15} /> Manage tasks
          </Link>
        </div>
      </div>
      <div className="grid grid-4 mb admin-speaker-summary">
        <section className="card metric">
          <div className="label">Profile</div>
          <div className="value">
            <DomainStatusBadge
              domain="content"
              status={profile.profileStatus}
            />
          </div>
        </section>
        <section className="card metric">
          <div className="label">Linked sessions</div>
          <div className="value">{sessions.length}</div>
        </section>
        <section className="card metric">
          <div className="label">Outstanding tasks</div>
          <div className="value">{tasks.outstanding}</div>
        </section>
        <section className="card metric">
          <div className="label">Uploaded files</div>
          <div className="value">{files.length}</div>
        </section>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <section className="card pad mt" id="profile">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Public identity</span>
            <h2>Speaker profile</h2>
          </div>
          <UserRound aria-hidden className="subtle" />
        </div>
        <p className="help">
          Last saved {formatTimestamp(profile.updatedAt, event.timezone)} ·
          revision {profile.revision} · {event.timezone}
        </p>
        {profileShared ? (
          <div className="validation-item warn mb" role="status">
            <strong>Shared identity</strong>
            <span>
              This person is linked to another event or an organisation-wide
              role. They must update their shared profile from their own speaker
              workspace so one organiser cannot change another event's records.
            </span>
          </div>
        ) : null}
        <Form method="post" className="stack">
          <input type="hidden" name="_intent" value="save_speaker_profile" />
          <input type="hidden" name="revision" value={profile.revision} />
          <fieldset
            className="stack pc-plain-fieldset"
            disabled={profileShared}
          >
            <label className="label">
              Display name
              <input
                className="field"
                name="name"
                defaultValue={profile.name}
                required
                minLength={2}
                maxLength={120}
              />
            </label>
            <div className="form-row">
              <label className="label">
                Job title
                <input
                  className="field"
                  name="jobTitle"
                  defaultValue={profile.jobTitle ?? ""}
                  maxLength={160}
                />
              </label>
              <label className="label">
                Organisation
                <input
                  className="field"
                  name="organisationName"
                  defaultValue={profile.organisationName ?? ""}
                  maxLength={160}
                />
              </label>
            </div>
            <div className="form-row">
              <label className="label">
                Name pronunciation
                <input
                  className="field"
                  name="pronunciation"
                  defaultValue={profile.pronunciation ?? ""}
                  maxLength={160}
                />
              </label>
              <label className="label">
                Profile status
                <select
                  className="select"
                  name="profileStatus"
                  defaultValue={profile.profileStatus}
                >
                  <option value="draft">
                    Draft — hidden from the programme
                  </option>
                  <option value="published">
                    Published — visible in the public programme
                  </option>
                  <option value="archived">
                    Archived — retained but not published
                  </option>
                </select>
              </label>
            </div>
            <label className="label">
              Biography
              <textarea
                className="textarea"
                name="biography"
                defaultValue={profile.biography ?? ""}
                maxLength={5_000}
                rows={7}
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </button>
          </fieldset>
        </Form>
      </section>
      <section className="card pad mt" id="sessions">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Programme</span>
            <h2>Linked sessions</h2>
          </div>
          <CalendarClock aria-hidden className="subtle" />
        </div>
        {sessions.length ? (
          <div className="table-wrap pc-responsive-table-wrap">
            <table className="data-table pc-responsive-table">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Role</th>
                  <th scope="col">Participation</th>
                  <th scope="col">Status</th>
                  <th scope="col">Placement</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="pc-record-primary-cell" data-label="Session">
                      <span className="pc-record-identity">
                        <strong>{session.title}</strong>
                        <small>
                          {session.format} · {session.durationMinutes} minutes
                        </small>
                      </span>
                    </td>
                    <td data-label="Role">{session.roleLabel ?? "Speaker"}</td>
                    <td data-label="Participation">
                      <span
                        className={`status ${session.participationStatus === "confirmed" ? "success" : session.status === "cancelled" ? "" : "warning"}`}
                      >
                        {session.participationStatus === "confirmed"
                          ? "Confirmed"
                          : session.status === "cancelled"
                            ? "Not required"
                            : "Pending"}
                      </span>
                      {session.participationConfirmedAt !== null ? (
                        <small className="subtle">
                          {formatTimestamp(
                            session.participationConfirmedAt,
                            event.timezone,
                          )}
                        </small>
                      ) : null}
                    </td>
                    <td data-label="Status">
                      <DomainStatusBadge
                        domain="session"
                        status={session.status}
                      />
                    </td>
                    <td data-label="Placement">
                      {session.startsAt ? (
                        <div className="pc-record-stack">
                          <span>
                            {formatTimestamp(session.startsAt, event.timezone)}
                          </span>
                          <span className="subtle">
                            {session.roomName ?? "Room to be assigned"}
                          </span>
                        </div>
                      ) : (
                        <span className="subtle">
                          Not placed in the published schedule
                        </span>
                      )}
                    </td>
                    <td data-label="Action">
                      {session.participationStatus === "pending" &&
                      session.status !== "cancelled" ? (
                        <Form method="post" className="stack">
                          <input
                            type="hidden"
                            name="_intent"
                            value="confirm_external_participation"
                          />
                          <input
                            type="hidden"
                            name="sessionId"
                            value={session.id}
                          />
                          <input
                            type="hidden"
                            name="confirmation"
                            value="confirmed"
                          />
                          <label className="check-row">
                            <input
                              type="checkbox"
                              name="externalConfirmation"
                              value="confirmed"
                              required
                            />
                            <span>
                              I confirm {profile.name} agreed outside Program
                              Cue to participate in “{session.title}” and be
                              listed according to its visibility.
                            </span>
                          </label>
                          <button
                            className="btn small"
                            type="submit"
                            disabled={busy}
                            aria-label={`Record external confirmation for ${session.title}`}
                          >
                            Record external confirmation
                          </button>
                        </Form>
                      ) : session.status === "cancelled" ? (
                        <span className="subtle">Session cancelled</span>
                      ) : (
                        <span className="subtle">No action required</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pc-empty-state">
            <CalendarClock aria-hidden className="pc-state-icon" />
            <h3>No linked sessions</h3>
            <p className="subtle">
              Link this speaker from a session in the schedule planner.
            </p>
          </div>
        )}
      </section>
      <section className="card pad mt" id="files">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Private R2 files</span>
            <h2>Uploaded files and versions</h2>
          </div>
          <FileCheck2 aria-hidden className="subtle" />
        </div>
        <p className="subtle">
          Speaker uploads stay private to the speaker workspace. Organisers see
          the scan and release state of every stored version here and can
          download only the current released version.
        </p>
        {files.length ? (
          <div className="stack mt">
            {files.map((file) => (
              <div className="file-version-row" key={file.id}>
                <span className="file-kind-icon">
                  <FileCheck2 aria-hidden size={17} />
                </span>
                <span>
                  <strong>{file.kind.replaceAll("_", " ")}</strong>
                  <small>
                    {file.filename ?? "No stored version"} · version{" "}
                    {file.versionNumber ?? "—"} · {formatBytes(file.sizeBytes)}
                  </small>
                </span>
                {file.scanStatus ? (
                  <DomainStatusBadge domain="file" status={file.scanStatus} />
                ) : (
                  <span className="status warning">No scan result</span>
                )}
                {file.currentVersionId && file.downloadReleasedAt ? (
                  <a
                    className="btn small"
                    href={`/admin/speakers/${profile.id}/files/${file.id}`}
                    aria-label={`Download released ${file.downloadFilename}`}
                  >
                    <Download aria-hidden size={14} /> Download
                  </a>
                ) : (
                  <span className="status warning">
                    <LockKeyhole aria-hidden size={13} /> Not released
                  </span>
                )}
                {file.versions.length ? (
                  <details className="file-history">
                    <summary>
                      {file.versions.length} version
                      {file.versions.length === 1 ? "" : "s"}
                    </summary>
                    {file.versions.map((version) => (
                      <small key={version.id}>
                        v{version.versionNumber} · {version.filename} ·{" "}
                        {formatBytes(version.sizeBytes)} · scan{" "}
                        {version.scanStatus} ·{" "}
                        {version.releasedAt
                          ? `released ${formatTimestamp(version.releasedAt, event.timezone)}`
                          : "not released"}
                      </small>
                    ))}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="pc-empty-state">
            <FileCheck2 aria-hidden className="pc-state-icon" />
            <h3>No uploaded files</h3>
            <p className="subtle">
              Assign an upload task so this speaker can share headshots or
              slides.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

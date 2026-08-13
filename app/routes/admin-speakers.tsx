import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileWarning,
  ListChecks,
  UserRound,
} from "lucide-react";
import { useEffect } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-speakers";
import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  SpeakerAdminStateError,
  SpeakerService,
  type AdminSpeakerFilters,
} from "~/modules/speakers/speaker-service.server";
import { SpeakerInvitationDeliveryError } from "~/modules/speakers/speaker-invitation.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Speakers · Program Cue" }];

type ActionResult = {
  ok: boolean;
  message: string;
  duplicateCheck?: {
    matches: Awaited<
      ReturnType<PersonDuplicateService["findLikelyDuplicates"]>
    >["matches"];
    truncated: boolean;
  };
};

function profileFilter(value: string): AdminSpeakerFilters["profileStatus"] {
  if (
    value === "" ||
    value === "draft" ||
    value === "published" ||
    value === "archived"
  ) {
    return value;
  }
  throw new Response("Invalid speaker profile filter", { status: 400 });
}

function readinessFilter(value: string): AdminSpeakerFilters["readiness"] {
  if (value === "" || value === "ready" || value === "needs_attention") {
    return value;
  }
  throw new Response("Invalid speaker readiness filter", { status: 400 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const url = new URL(request.url);
  const filters = {
    personId: url.searchParams.get("person")?.trim() ?? "",
    query: url.searchParams.get("query") ?? "",
    profileStatus: profileFilter(url.searchParams.get("profileStatus") ?? ""),
    readiness: readinessFilter(url.searchParams.get("readiness") ?? ""),
  };
  const requestedPage = filters.personId
    ? 1
    : Number(url.searchParams.get("page") ?? "1");
  const workspace = await new SpeakerService(env).listAdminSpeakerPage(
    viewer,
    filters,
    requestedPage,
  );
  if (filters.personId && !workspace.speakers.length)
    throw new Response("Speaker not found in this event", { status: 404 });
  return {
    ...workspace,
    filters,
    focusedPersonId: filters.personId || null,
    manualSpeakerIdempotencyKey: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  if (String(form.get("_intent") ?? "") !== "create_manual_speaker") {
    return data<ActionResult>(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  }
  const input = {
    idempotencyKey: form.get("idempotencyKey"),
    name: form.get("name"),
    email: form.get("email"),
  };
  try {
    const duplicateCheck = await new PersonDuplicateService(
      env,
    ).findLikelyDuplicates(viewer, [{ name: input.name, email: input.email }]);
    if (
      duplicateCheck.matches.length &&
      form.get("confirmDuplicatePeople") !== "yes"
    ) {
      return data<ActionResult>(
        {
          ok: false,
          message:
            "Review the likely existing person before adding this speaker.",
          duplicateCheck: {
            matches: duplicateCheck.matches,
            truncated: duplicateCheck.truncated,
          },
        },
        { status: 409 },
      );
    }
    const result = await new SpeakerService(env).createManualSpeaker(
      viewer,
      input,
    );
    return data<ActionResult>({
      ok: true,
      message: result.accepted
        ? "This speaker already has accepted access to the event."
        : result.delivery === "demo_not_sent"
          ? "The pending speaker invitation was saved. Demonstration mode does not send its sign-in email."
          : result.createdIdentity
            ? "The pending speaker invitation and its durable email operation were saved. The participant can complete their profile after accepting."
            : "The pending speaker invitation and its durable email operation were saved. The existing participant-owned profile was left unchanged.",
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data<ActionResult>(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the speaker details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SpeakerAdminStateError) {
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof SpeakerInvitationDeliveryError) {
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: 207 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function AdminSpeakers({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  useEffect(() => {
    if (!loaderData.focusedPersonId) return;
    const target = document.getElementById(
      `admin-speaker-${loaderData.focusedPersonId}`,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [loaderData.focusedPersonId]);
  const {
    speakers,
    summary,
    filters,
    page,
    hasNext,
    pendingInvitations,
    eventTimezone,
  } = loaderData;
  const activePendingInvitationCount = pendingInvitations.filter(
    (invitation) => !invitation.expired,
  ).length;
  const expiredInvitationCount =
    pendingInvitations.length - activePendingInvitationCount;
  const queryParams = (targetPage: number) =>
    new URLSearchParams({
      query: filters.query,
      profileStatus: filters.profileStatus ?? "",
      readiness: filters.readiness ?? "",
      page: String(targetPage),
    }).toString();
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
          <Link className="btn" to="/admin/crm">
            Speaker Network
          </Link>
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
          <div className="value">{summary.knownSpeakers}</div>
        </section>
        <section className="card metric">
          <div className="label">Ready</div>
          <div className="value">{summary.readySpeakers}</div>
        </section>
        <section className="card metric">
          <div className="label">Outstanding tasks</div>
          <div className="value">{summary.outstandingTasks}</div>
        </section>
        <section className="card metric">
          <div className="label">Files quarantined</div>
          <div className="value">{summary.quarantinedFiles}</div>
        </section>
      </div>
      {summary.quarantinedFiles ? (
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
      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : actionData.duplicateCheck ? "warn" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      <details className="card pad mb pc-disclosure">
        <summary>
          <strong>Invite a speaker</strong>{" "}
          <span className="subtle">
            access stays pending until the person explicitly accepts
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="_intent" value="create_manual_speaker" />
          <input
            type="hidden"
            name="idempotencyKey"
            value={loaderData.manualSpeakerIdempotencyKey}
          />
          <div className="form-row">
            <div className="label">
              <label htmlFor="manual-speaker-name">Name</label>
              <input
                aria-describedby="manual-speaker-name-help"
                className="field"
                id="manual-speaker-name"
                name="name"
                required
                maxLength={120}
              />
              <small className="subtle" id="manual-speaker-name-help">
                Existing participant-owned profiles are never overwritten.
              </small>
            </div>
            <label className="label">
              Email
              <input
                className="field"
                name="email"
                type="email"
                required
                maxLength={254}
              />
            </label>
          </div>
          {actionData?.duplicateCheck ? (
            <PersonDuplicateWarning
              id="manual-speaker-duplicate"
              matches={actionData.duplicateCheck.matches}
              truncated={actionData.duplicateCheck.truncated}
            />
          ) : null}
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.formData?.get("_intent") === "create_manual_speaker"
              ? "Inviting…"
              : "Send invitation"}
          </button>
        </Form>
      </details>
      {pendingInvitations.length ? (
        <section
          className="card pad mb"
          aria-labelledby="pending-speakers-title"
        >
          <div className="card-title">
            <div>
              <h2 id="pending-speakers-title">
                Speaker invitations awaiting acceptance
              </h2>
              <p className="subtle">
                Access remains unavailable until each person signs in and
                explicitly accepts an unexpired event invitation.
              </p>
            </div>
            <span className="pill">
              {activePendingInvitationCount} pending
              {expiredInvitationCount
                ? ` · ${expiredInvitationCount} expired`
                : ""}
            </span>
          </div>
          <div className="stack">
            {pendingInvitations.map((invitation) => (
              <div className="list-row" key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <small className="subtle">
                    {invitation.expired ? "Expired " : "Expires "}
                    <EventDateTime
                      epochSeconds={invitation.expiresAt}
                      timeZone={eventTimezone}
                    />
                  </small>
                </div>
                <span
                  className={`status ${invitation.expired ? "danger" : "warning"}`}
                >
                  {invitation.expired ? "Expired" : "Pending acceptance"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="card pad mb">
        <form method="get" className="form-row" role="search">
          <label className="label">
            Search
            <input
              className="field"
              name="query"
              defaultValue={filters.query}
              placeholder="Name or email"
            />
          </label>
          <label className="label">
            Profile
            <select
              className="select"
              name="profileStatus"
              defaultValue={filters.profileStatus}
            >
              <option value="">All profiles</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="label">
            Readiness
            <select
              className="select"
              name="readiness"
              defaultValue={filters.readiness}
            >
              <option value="">All readiness</option>
              <option value="ready">Ready</option>
              <option value="needs_attention">Needs attention</option>
            </select>
          </label>
          <div className="page-actions" style={{ alignSelf: "end" }}>
            <button className="btn primary" type="submit">
              Apply filters
            </button>
            <Link className="btn" to="/admin/speakers">
              Clear
            </Link>
          </div>
        </form>
      </section>
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
              {speakers.length ? (
                speakers.map((speaker) => (
                  <tr
                    id={`admin-speaker-${speaker.id}`}
                    key={speaker.id}
                    tabIndex={
                      speaker.id === loaderData.focusedPersonId ? -1 : undefined
                    }
                  >
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
                          <strong>
                            <Link
                              className="pc-record-link"
                              to={`/admin/speakers/${encodeURIComponent(speaker.id)}`}
                            >
                              {speaker.name}
                            </Link>
                          </strong>
                          <small className="pc-record-email">
                            {speaker.email}
                          </small>
                          <small>
                            {speaker.jobTitle ?? "Title not provided"}
                          </small>
                          <small>
                            {speaker.organisationName ??
                              "Organisation not provided"}
                          </small>
                        </span>
                      </div>
                    </td>
                    <td data-label="Profile">
                      <DomainStatusBadge
                        domain="content"
                        status={speaker.profileStatus}
                      />
                    </td>
                    <td data-label="Sessions">{speaker.sessionCount}</td>
                    <td data-label="Tasks">
                      <div className="pc-record-stack">
                        <span>
                          <strong>{speaker.completedTasks}</strong> complete
                        </span>
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
        {page > 1 || hasNext ? (
          <nav className="page-actions mt" aria-label="Speaker pages">
            {page > 1 ? (
              <Link className="btn" to={`?${queryParams(page - 1)}`}>
                ← Previous
              </Link>
            ) : null}
            <span className="pill">Page {page}</span>
            {hasNext ? (
              <Link className="btn" to={`?${queryParams(page + 1)}`}>
                Next →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </>
  );
}

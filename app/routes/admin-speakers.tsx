import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileWarning,
  ListChecks,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import { PersonLookup } from "~/components/person-lookup";
import { CharacterCount } from "~/components/ui/character-count";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { SpeakerRosterProfileAction } from "~/modules/speakers/speaker-roster-import.server";
import type { Route } from "./+types/admin-speakers";
import type { ActionResult } from "./admin-speakers.server";

export const meta = () => [{ title: "Speakers · Program Cue" }];

function workflowLabel(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function rosterProfileActionLabel(action: SpeakerRosterProfileAction) {
  switch (action) {
    case "create_identity_and_profile":
      return "New neutral identity and organisation profile";
    case "create_organisation_profile":
      return "Canonical profile retained; organisation profile created";
    case "update_organisation_profile":
      return "Canonical profile retained; organisation profile updated";
    case "retain_organisation_profile":
      return "Canonical retained; imported details already match";
  }
}

function omittedRosterProfileLabel(action: SpeakerRosterProfileAction) {
  return action === "update_organisation_profile" ||
    action === "retain_organisation_profile"
    ? "Not supplied (retained)"
    : "Not supplied (left empty)";
}

export { action, loader } from "./admin-speakers.server";

export default function AdminSpeakers({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const [manualName, setManualName] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualBiography, setManualBiography] = useState("");
  const [manualLookupQuery, setManualLookupQuery] = useState("");
  useEffect(() => {
    if (!actionData?.ok || actionData.intent !== "add_manual_speaker") return;
    setManualName("");
    setManualEmail("");
    setManualBiography("");
    setManualLookupQuery("");
  }, [actionData]);
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
      workflowStatus: filters.workflowStatus ?? "",
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
      <div className="pc-status-notice is-info mb">
        <UserRound aria-hidden size={18} />
        <div className="pc-status-notice-copy">
          <strong>Speaker records and portal access are separate</strong>
          <div>
            Add or import roster records without sending email. When a speaker
            is ready, use the portal-invitation action in their roster row.
          </div>
        </div>
      </div>
      <details className="card pad mb pc-disclosure">
        <summary>
          <strong>Import event speakers from CSV</strong>{" "}
          <span className="subtle">preview required; no email is sent</span>
        </summary>
        <Form method="post" encType="multipart/form-data" className="stack mt">
          <input type="hidden" name="_intent" value="preview_roster_import" />
          <label className="label">
            Event speaker CSV
            <input
              className="field"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
            />
          </label>
          <p className="help">
            Required: name, email. Optional: title, company, bio and status.
            Imported speakers start as prospects unless status is supplied.
          </p>
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            Preview speaker import
          </button>
        </Form>
        {actionData?.importPreview ? (
          <div className="stack mt">
            <h3>Import preview</h3>
            <div
              className="table-wrap"
              role="region"
              aria-label="Speaker import preview"
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Title</th>
                    <th>Company</th>
                    <th>Biography</th>
                    <th>Profile result</th>
                    <th>Workflow</th>
                    <th>Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.importPreview.valid.map((row) => (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td>{row.name}</td>
                      <td>
                        {row.evaluatorEmailRouting ? (
                          <span className="pc-record-stack">
                            <span>{row.enteredEmail}</span>
                            <small className="subtle">
                              Routed to {row.email}
                            </small>
                          </span>
                        ) : (
                          row.email
                        )}
                      </td>
                      <td>
                        {row.jobTitleSupplied
                          ? row.jobTitle || "Clear"
                          : omittedRosterProfileLabel(row.profileAction)}
                      </td>
                      <td>
                        {row.organisationNameSupplied
                          ? row.organisationName || "Clear"
                          : omittedRosterProfileLabel(row.profileAction)}
                      </td>
                      <td>
                        {row.biographySupplied ? (
                          row.biography ? (
                            <details>
                              <summary>Review biography</summary>
                              <p>{row.biography}</p>
                            </details>
                          ) : (
                            "Clear"
                          )
                        ) : (
                          omittedRosterProfileLabel(row.profileAction)
                        )}
                      </td>
                      <td>{rosterProfileActionLabel(row.profileAction)}</td>
                      <td>
                        {workflowLabel(row.workflowStatus)} (
                        {row.workflowAction === "retain"
                          ? "retained"
                          : "will be set"}
                        )
                      </td>
                      <td>
                        <span className="status success">Valid</span>
                      </td>
                    </tr>
                  ))}
                  {actionData.importPreview.invalid.map((row) => (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td colSpan={7}>Invalid row</td>
                      <td>
                        <span className="status danger">
                          {row.errors.join("; ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {actionData.importPreview.valid.length &&
            !actionData.importPreview.invalid.length ? (
              <Form method="post">
                <input
                  type="hidden"
                  name="_intent"
                  value="confirm_roster_import"
                />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={actionData.importPreview.idempotencyKey}
                />
                <input
                  type="hidden"
                  name="previewFingerprint"
                  value={actionData.importPreview.previewFingerprint}
                />
                <input
                  type="hidden"
                  name="csv"
                  value={actionData.importPreview.csv}
                />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={navigation.state !== "idle"}
                >
                  Confirm event roster import
                </button>
              </Form>
            ) : null}
          </div>
        ) : null}
      </details>
      <details className="card pad mb pc-disclosure">
        <summary>
          <strong>Add speaker record</strong>{" "}
          <span className="subtle">
            roster only; no invitation email is sent
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="_intent" value="add_manual_speaker" />
          <input
            type="hidden"
            name="idempotencyKey"
            value={loaderData.manualSpeakerIdempotencyKey}
          />
          <PersonLookup
            purpose="event-roster"
            suggestedQuery={manualLookupQuery}
            onSelect={(person) => {
              setManualName(person.name);
              setManualEmail(person.email);
            }}
          />
          <div className="form-row">
            <div className="label">
              <label htmlFor="manual-speaker-name">
                <span className="pc-field-label">
                  <span>Name</span>
                  <span className="pc-required" aria-hidden="true">
                    Required
                  </span>
                </span>
              </label>
              <input
                aria-describedby="manual-speaker-name-help"
                className="field"
                id="manual-speaker-name"
                name="name"
                value={manualName}
                onChange={(event) => setManualName(event.currentTarget.value)}
                required
                minLength={2}
                maxLength={120}
              />
              <small className="subtle" id="manual-speaker-name-help">
                New records start as prospects. Existing participant-owned
                profiles are never overwritten.
              </small>
            </div>
            <label className="label">
              <span className="pc-field-label">
                <span>Email</span>
                <span className="pc-required" aria-hidden="true">
                  Required
                </span>
              </span>
              <input
                className="field"
                name="email"
                type="email"
                value={manualEmail}
                onChange={(event) => setManualEmail(event.currentTarget.value)}
                onBlur={(event) =>
                  setManualLookupQuery(event.currentTarget.value)
                }
                autoComplete="off"
                required
                maxLength={254}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="label">
              Job title <span className="subtle">Optional</span>
              <input className="field" name="jobTitle" maxLength={160} />
            </label>
            <label className="label">
              Company <span className="subtle">Optional</span>
              <input
                className="field"
                name="organisationName"
                maxLength={160}
              />
            </label>
          </div>
          <label className="label">
            Biography <span className="subtle">Optional</span>
            <textarea
              className="field"
              name="biography"
              maxLength={5000}
              value={manualBiography}
              onChange={(event) =>
                setManualBiography(event.currentTarget.value)
              }
            />
            <CharacterCount value={manualBiography} maximum={5_000} />
          </label>
          <p className="help">
            This creates an event roster record only. Send portal access later
            from the speaker row when you are ready to email them.
          </p>
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
            {navigation.formData?.get("_intent") === "add_manual_speaker"
              ? "Adding…"
              : "Add speaker record"}
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
            Workflow
            <select
              className="select"
              name="workflowStatus"
              defaultValue={filters.workflowStatus}
            >
              <option value="">All workflow states</option>
              <option value="prospect">Prospect</option>
              <option value="invited">Invited</option>
              <option value="confirmed">Confirmed</option>
              <option value="declined">Declined</option>
              <option value="withdrawn">Withdrawn</option>
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
      <section className="card pad" id="speaker-readiness">
        <div className="card-title">
          <h2>Speaker readiness</h2>
          <span className="help right">
            This event only · one row per person
          </span>
        </div>
        <div
          className="table-wrap pc-responsive-table-wrap admin-speaker-roster-table"
          role="region"
          aria-label="Speaker readiness"
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th scope="col">Speaker</th>
                <th scope="col">Profile</th>
                <th scope="col">Workflow</th>
                <th scope="col">Sessions</th>
                <th scope="col">Tasks</th>
                <th scope="col">File security</th>
                <th scope="col">Readiness</th>
                <th scope="col">Portal access</th>
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
                        <div className="pc-record-identity">
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
                        </div>
                      </div>
                    </td>
                    <td data-label="Profile">
                      <DomainStatusBadge
                        domain="content"
                        status={speaker.profileStatus}
                      />
                    </td>
                    <td data-label="Workflow">
                      <Form method="post" className="form-row">
                        <input
                          type="hidden"
                          name="_intent"
                          value="update_workflow_status"
                        />
                        <input
                          type="hidden"
                          name="personId"
                          value={speaker.id}
                        />
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={loaderData.workflowIdempotencyKeys[speaker.id]}
                        />
                        <select
                          className="select"
                          name="status"
                          defaultValue={speaker.workflowStatus}
                          aria-label={`Workflow status for ${speaker.name}`}
                        >
                          <option value="prospect">Prospect</option>
                          <option value="invited">Invited</option>
                          <option value="confirmed">Confirmed</option>
                          <option value="declined">Declined</option>
                          <option value="withdrawn">Withdrawn</option>
                        </select>
                        <button
                          className="btn small"
                          type="submit"
                          disabled={navigation.state !== "idle"}
                        >
                          Save
                        </button>
                      </Form>
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
                    <td
                      data-label="Portal access"
                      className="pc-record-action-cell"
                    >
                      {speaker.portalAccessAccepted ? (
                        <span className="status success">Access accepted</span>
                      ) : speaker.workflowStatus === "declined" ||
                        speaker.workflowStatus === "withdrawn" ? (
                        <span className="help">
                          Unavailable while {speaker.workflowStatus}
                        </span>
                      ) : (
                        <Form method="post" className="stack">
                          <input
                            type="hidden"
                            name="_intent"
                            value="send_speaker_invitation"
                          />
                          <input
                            type="hidden"
                            name="personId"
                            value={speaker.id}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={
                              loaderData.invitationIdempotencyKeys[speaker.id]
                            }
                          />
                          <label className="help">
                            <input
                              type="checkbox"
                              name="confirmation"
                              value="send"
                              required
                            />{" "}
                            Confirm email to {speaker.email}
                          </label>
                          <button
                            className="btn small primary"
                            type="submit"
                            disabled={navigation.state !== "idle"}
                          >
                            {speaker.portalInvitationPending
                              ? "Resend portal invitation"
                              : "Send portal invitation"}
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="pc-table-empty-row">
                  <td className="pc-table-empty-cell" colSpan={8}>
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

import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";

import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import { PersonLookup } from "~/components/person-lookup";
import { CharacterCount } from "~/components/ui/character-count";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
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

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export { action, loader } from "./admin-speakers.server";

function openAddSpeakerRecord() {
  const panel = document.getElementById("add-speaker-record");
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = true;
  document.getElementById("manual-speaker-name")?.focus();
  panel.scrollIntoView({ block: "nearest" });
}

export default function AdminSpeakers({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const searchTimer = useRef<number | null>(null);
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
  const [searchQuery, setSearchQuery] = useState(filters.query);
  useEffect(() => {
    setSearchQuery(filters.query);
  }, [filters.query]);
  useEffect(
    () => () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    },
    [],
  );
  const filtersActive = Boolean(
    filters.query ||
      filters.profileStatus ||
      filters.readiness ||
      filters.workflowStatus,
  );
  function submitRosterFilters(form: HTMLFormElement | null) {
    if (!form) return;
    submit(form, { method: "get", replace: true });
  }
  function scheduleRosterSearch(form: HTMLFormElement | null) {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(
      () => submitRosterFilters(form),
      250,
    );
  }
  const queryParams = (targetPage: number) =>
    new URLSearchParams({
      query: filters.query,
      profileStatus: filters.profileStatus ?? "",
      readiness: filters.readiness ?? "",
      workflowStatus: filters.workflowStatus ?? "",
      page: String(targetPage),
    }).toString();
  const pulse = [
    `${summary.knownSpeakers} ${summary.knownSpeakers === 1 ? "speaker" : "speakers"}`,
    `${summary.readySpeakers} ready`,
    summary.outstandingTasks ? `${summary.outstandingTasks} outstanding` : null,
    summary.quarantinedFiles ? `${summary.quarantinedFiles} quarantined` : null,
    activePendingInvitationCount
      ? `${activePendingInvitationCount} invitations pending`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="crm-workspace">
      <div className="page-head pc-page-header">
        <div>
          <h1>Speakers</h1>
        </div>
        <div className="page-actions">
          <button
            className="btn primary"
            type="button"
            onClick={openAddSpeakerRecord}
          >
            Add speaker
          </button>
          <Link className="btn" to="/admin/crm">
            Speaker Network
          </Link>
          <Link className="btn" to="/admin/resources">
            Resources
          </Link>
          <Link className="btn" to="/admin/tasks">
            Manage tasks
          </Link>
        </div>
      </div>
      <div className="crm-pulse">{pulse}</div>
      {summary.quarantinedFiles ? (
        <div className="pc-status-notice is-warning crm-notice">
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
          className={`validation-item ${actionData.ok ? "ok" : actionData.duplicateCheck ? "warn" : "error"} crm-notice`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      <section className="crm-board" id="speaker-readiness">
        <div className="crm-board-head">
          <h2>Speaker readiness</h2>
          <span className="crm-board-meta">
            This event · one row per person
          </span>
        </div>
        <search>
          <Form
            method="get"
            className="crm-toolbar"
            key={`${filters.profileStatus ?? ""}:${filters.workflowStatus ?? ""}:${filters.readiness ?? ""}`}
          >
            <label className="crm-filter crm-filter-search">
              <span className="sr-only">Search</span>
              <input
                className="field"
                name="query"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.currentTarget.value);
                  scheduleRosterSearch(event.currentTarget.form);
                }}
                placeholder="Name or email"
              />
            </label>
            <label className="crm-filter">
              <span className="sr-only">Profile</span>
              <select
                className="select"
                name="profileStatus"
                defaultValue={filters.profileStatus ?? ""}
                onChange={(event) =>
                  submitRosterFilters(event.currentTarget.form)
                }
              >
                <option value="">All profiles</option>
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label className="crm-filter">
              <span className="sr-only">Workflow</span>
              <select
                className="select"
                name="workflowStatus"
                defaultValue={filters.workflowStatus ?? ""}
                onChange={(event) =>
                  submitRosterFilters(event.currentTarget.form)
                }
              >
                <option value="">All workflow states</option>
                <option value="prospect">Prospect</option>
                <option value="invited">Invited</option>
                <option value="confirmed">Confirmed</option>
                <option value="declined">Declined</option>
                <option value="withdrawn">Withdrawn</option>
              </select>
            </label>
            <label className="crm-filter">
              <span className="sr-only">Readiness</span>
              <select
                className="select"
                name="readiness"
                defaultValue={filters.readiness ?? ""}
                onChange={(event) =>
                  submitRosterFilters(event.currentTarget.form)
                }
              >
                <option value="">All readiness</option>
                <option value="ready">Ready</option>
                <option value="needs_attention">Needs attention</option>
              </select>
            </label>
            <div className="crm-filter-actions">
              <button className="crm-text-action" type="submit">
                Apply filters
              </button>
              {filtersActive ? (
                <Link className="crm-text-action" to="/admin/speakers">
                  Clear
                </Link>
              ) : null}
            </div>
          </Form>
        </search>
        <div className="crm-aux">
          <details
            className="crm-disclosure"
            open={Boolean(actionData?.importPreview)}
          >
            <summary>
              <span>Import event speakers from CSV</span>
            </summary>
            <div className="crm-disclosure-body">
              <Form
                method="post"
                encType="multipart/form-data"
                className="stack"
              >
                <input
                  type="hidden"
                  name="_intent"
                  value="preview_roster_import"
                />
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
                  Required: name, email. Optional: title, company, bio and
                  status. Imported speakers start as prospects unless status is
                  supplied. Preview required; no email is sent.
                </p>
                <button
                  className="btn"
                  type="submit"
                  disabled={navigation.state !== "idle"}
                >
                  Preview speaker import
                </button>
              </Form>
              {actionData?.importPreview ? (
                <div className="stack mt">
                  <h3>Import preview</h3>
                  <section
                    className="table-wrap"
                    aria-label="Speaker import preview"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
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
                            <td>
                              {rosterProfileActionLabel(row.profileAction)}
                            </td>
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
                  </section>
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
            </div>
          </details>
          <details
            id="add-speaker-record"
            className="crm-disclosure"
            open={
              actionData?.intent === "add_manual_speaker" ||
              Boolean(actionData?.duplicateCheck)
            }
          >
            <summary>
              <span>Add speaker record</span>
            </summary>
            <div className="crm-disclosure-body">
              <Form method="post" className="stack">
                <input
                  type="hidden"
                  name="_intent"
                  value="add_manual_speaker"
                />
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
                      onChange={(event) =>
                        setManualName(event.currentTarget.value)
                      }
                      required
                      minLength={2}
                      maxLength={120}
                    />
                    <small className="subtle" id="manual-speaker-name-help">
                      New records start as prospects. Existing participant-owned
                      profiles are never overwritten. Roster only; no invitation
                      email is sent.
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
                      onChange={(event) =>
                        setManualEmail(event.currentTarget.value)
                      }
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
            </div>
          </details>
        </div>
        {pendingInvitations.length ? (
          <section
            className="crm-pending"
            aria-labelledby="pending-speakers-title"
          >
            <h2 id="pending-speakers-title">
              Speaker invitations awaiting acceptance
            </h2>
            <p className="subtle">
              Access remains unavailable until each person signs in and
              explicitly accepts an unexpired event invitation.
              {activePendingInvitationCount
                ? ` ${activePendingInvitationCount} pending`
                : ""}
              {expiredInvitationCount
                ? ` · ${expiredInvitationCount} expired`
                : ""}
            </p>
            <div className="crm-pending-list">
              {pendingInvitations.map((invitation) => (
                <div className="crm-pending-row" key={invitation.id}>
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
        <section
          className="crm-table-scroll"
          aria-label="Speaker readiness"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="crm-directory">
            <thead>
              <tr>
                <th scope="col">Speaker</th>
                <th scope="col">Workflow</th>
                <th scope="col" className="crm-col-optional">
                  Sessions
                </th>
                <th scope="col">Readiness</th>
                <th scope="col">Portal</th>
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
                    <td data-label="Speaker">
                      <div className="crm-person">
                        <span className="avatar sm">
                          {initials(speaker.name)}
                        </span>
                        <div className="crm-person-copy">
                          <Link
                            to={`/admin/speakers/${encodeURIComponent(speaker.id)}`}
                          >
                            {speaker.name}
                          </Link>
                          <small>{speaker.email}</small>
                          <small>
                            {[speaker.jobTitle, speaker.organisationName]
                              .filter(Boolean)
                              .join(" · ") || "Title not provided"}
                          </small>
                          <small>
                            {speaker.sessionCount}{" "}
                            {speaker.sessionCount === 1
                              ? "session"
                              : "sessions"}
                            {" · "}
                            {speaker.outstandingTasks
                              ? `${speaker.outstandingTasks} outstanding`
                              : `${speaker.completedTasks} complete`}
                            {speaker.quarantinedFiles
                              ? ` · ${speaker.quarantinedFiles} quarantined`
                              : ""}
                          </small>
                          <div className="crm-mobile-chips">
                            <span className="status">
                              {
                                statusPresentation(
                                  "content",
                                  speaker.profileStatus,
                                ).label
                              }
                            </span>
                            <span
                              className={`status ${speaker.outstandingTasks === 0 ? "success" : "warning"}`}
                            >
                              {speaker.outstandingTasks === 0
                                ? "Ready"
                                : "Attention"}
                            </span>
                            {speaker.portalAccessAccepted ? (
                              <span className="status">Access</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Workflow">
                      <Form method="post" className="crm-inline-form">
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
                          className="select crm-quiet-select"
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
                          className="crm-text-action"
                          type="submit"
                          disabled={navigation.state !== "idle"}
                        >
                          Save
                        </button>
                      </Form>
                      <div className="crm-state crm-desktop-only">
                        <DomainStatusBadge
                          domain="content"
                          status={speaker.profileStatus}
                        />
                      </div>
                    </td>
                    <td className="crm-col-optional" data-label="Sessions">
                      {speaker.sessionCount}
                    </td>
                    <td
                      className="crm-col-mobile-status"
                      data-label="Readiness"
                    >
                      {speaker.outstandingTasks === 0 ? (
                        <span className="status success">
                          <CheckCircle2 aria-hidden size={13} /> Ready
                        </span>
                      ) : (
                        <span className="status warning">Needs attention</span>
                      )}
                      {speaker.quarantinedFiles ? (
                        <div className="status warning">
                          <AlertTriangle aria-hidden size={13} />{" "}
                          {speaker.quarantinedFiles} quarantined
                        </div>
                      ) : null}
                    </td>
                    <td
                      className={
                        speaker.portalAccessAccepted
                          ? "crm-col-mobile-status"
                          : undefined
                      }
                      data-label="Portal"
                    >
                      {speaker.portalAccessAccepted ? (
                        <span className="subtle">Access accepted</span>
                      ) : speaker.workflowStatus === "declined" ||
                        speaker.workflowStatus === "withdrawn" ? (
                        <span className="help">
                          Unavailable while {speaker.workflowStatus}
                        </span>
                      ) : (
                        <Form method="post" className="crm-invite">
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
                          <label>
                            <input
                              type="checkbox"
                              name="confirmation"
                              value="send"
                              required
                            />
                            <span>Confirm email to {speaker.email}</span>
                          </label>
                          <button
                            className="crm-text-action"
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
                <tr>
                  <td className="crm-empty" colSpan={5}>
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
        </section>
        {page > 1 || hasNext ? (
          <nav className="crm-pager" aria-label="Speaker pages">
            {page > 1 ? (
              <Link className="btn" to={`?${queryParams(page - 1)}`}>
                Previous
              </Link>
            ) : null}
            <span className="subtle">Page {page}</span>
            {hasNext ? (
              <Link className="btn" to={`?${queryParams(page + 1)}`}>
                Next
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}

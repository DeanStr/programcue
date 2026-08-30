import {
  ArrowLeft,
  CalendarClock,
  Download,
  Eye,
  FileCheck2,
  ListChecks,
  LockKeyhole,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import { EventFieldInputs } from "~/components/event-field-inputs";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerProfileHistory } from "~/components/speaker-profile-history";
import { Button, ButtonAnchor, ButtonLink } from "~/components/ui/button";
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { useUnsavedChanges } from "~/components/ui/use-unsaved-changes";
import { requireValue } from "~/lib/required-value";
import type { EventFieldDefinitionValue } from "~/modules/fields/event-field-types";
import { maximumMegabytes } from "~/modules/files/file-policy";
import { formatEventLocalAvailabilityWindow } from "~/modules/schedule/schedule-time";
import {
  formatSpeakerXHandleInput,
  normalizeSpeakerLinkedinUrl,
} from "~/modules/speakers/speaker-schema";
import type { SpeakerService } from "~/modules/speakers/speaker-service.server";
import type { action } from "~/routes/admin-speaker-detail";

type AdminSpeakerDetailLoaderData = {
  detail: Awaited<ReturnType<SpeakerService["getAdminSpeakerDetail"]>>;
  availability: Awaited<ReturnType<SpeakerService["listAdminAvailability"]>>;
  customFields: EventFieldDefinitionValue[];
};

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

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export function AdminSpeakerDetailPage({
  loaderData,
}: {
  loaderData: AdminSpeakerDetailLoaderData;
}) {
  const { detail, availability, customFields } = loaderData;
  const {
    profile,
    profileShared,
    profileScoped,
    event,
    sessions,
    files,
    tasks,
  } = detail;
  const headshot = files.find(
    (file) =>
      file.kind === "headshot" &&
      file.targetType === "person" &&
      file.targetId === profile.id &&
      file.currentVersionId &&
      file.downloadReleasedAt &&
      file.downloadUploadedAt &&
      file.downloadFilename &&
      file.downloadUploaderName,
  );
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [profileDirty, setProfileDirty] = useState(false);
  const blocker = useUnsavedChanges(profileDirty);
  const { confirm: confirmAction, dialog: actionDialog } = useConfirm();
  // biome-ignore lint/correctness/useExhaustiveDependencies: These persisted version tokens deliberately clear dirty state after either profile scope is saved, including when normalized values remain unchanged.
  useEffect(
    () => setProfileDirty(false),
    [
      profile.organisationProfileOperationId,
      profile.revision,
      profile.travelProfileOperationId,
    ],
  );
  return (
    <>
      {blocker.state === "blocked" ? (
        <ConfirmDialog
          title="Leave without saving this speaker profile?"
          description="The profile changes on this page have not been saved."
          confirmLabel="Leave and discard"
          cancelLabel="Keep editing"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
      {actionDialog}
      <div className="crm-workspace crm-record">
        <div className="page-head pc-page-header">
          <div className="crm-record-hero">
            {headshot ? (
              <img
                className="crm-record-avatar"
                src={`/admin/speakers/${profile.id}/files/${headshot.id}?view=headshot`}
                alt=""
              />
            ) : (
              <span className="crm-record-avatar is-fallback">
                {initials(profile.name)}
              </span>
            )}
            <div>
              <h1>{profile.name}</h1>
              <p className="crm-caption">
                {[profile.jobTitle, profile.organisationName]
                  .filter(Boolean)
                  .join(" · ") || "No title or organisation recorded yet"}
              </p>
              <p className="crm-caption">{profile.email}</p>
              <div className="crm-status-line">
                <DomainStatusBadge
                  domain="content"
                  status={profile.profileStatus}
                />
                <span className="status">
                  {sessions.length}{" "}
                  {sessions.length === 1 ? "session" : "sessions"}
                </span>
                <span
                  className={`status ${tasks.outstanding ? "warning" : "success"}`}
                >
                  {tasks.outstanding
                    ? `${tasks.outstanding} outstanding`
                    : "Ready"}
                </span>
                <span className="status">
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
              </div>
            </div>
          </div>
          <div className="page-actions">
            <ButtonLink to="/admin/speakers">
              <ArrowLeft aria-hidden size={15} /> Back to roster
            </ButtonLink>
            <ButtonLink to="/admin/tasks">
              <ListChecks aria-hidden size={15} /> Manage tasks
            </ButtonLink>
            <ButtonLink to={`/admin/speakers/${profile.id}/preview`}>
              <Eye aria-hidden size={15} /> Preview participant view
            </ButtonLink>
          </div>
        </div>
        <SpeakerActionNotice notice={actionData} />
        <div className="crm-record-grid">
          <section className="crm-record-section" id="profile">
            <h2>Profile</h2>
            <p className="help">
              Last saved {formatTimestamp(profile.updatedAt, event.timezone)} ·
              revision {profile.revision}
            </p>
            {profileShared ? (
              <p className="help" role="status">
                Shared identity. Public name, social links and publication stay
                participant-managed. Organisation and event fields below do not
                change other events.
              </p>
            ) : null}
            {profileScoped ? (
              <Form
                key={`${profile.revision}:${profile.organisationProfileOperationId}:${profile.travelProfileOperationId}`}
                method="post"
                className="stack"
                onChange={() => setProfileDirty(true)}
              >
                <input
                  type="hidden"
                  name="_intent"
                  value="save_speaker_scoped_profile"
                />
                <input
                  type="hidden"
                  name="profileRevision"
                  value={profile.revision}
                />
                <input
                  type="hidden"
                  name="organisationProfileOperationId"
                  value={profile.organisationProfileOperationId}
                />
                <input
                  type="hidden"
                  name="travelProfileOperationId"
                  value={profile.travelProfileOperationId}
                />
                <fieldset className="stack pc-plain-fieldset">
                  <p className="help">
                    These values belong to {event.name} and its organisation.
                    They do not overwrite the participant-owned public identity.
                  </p>
                  <label className="label">
                    Organisation display name
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
                  <label className="label">
                    Organisation biography
                    <textarea
                      className="textarea"
                      name="biography"
                      defaultValue={profile.biography ?? ""}
                      maxLength={5_000}
                      rows={7}
                    />
                  </label>
                  <label className="label">
                    Travel and logistics preferences
                    <textarea
                      className="textarea"
                      name="travelPreferences"
                      defaultValue={profile.travelPreferences ?? ""}
                      maxLength={2_000}
                      rows={4}
                      placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
                    />
                    <span className="help">
                      Private to the participant and authorised organisers;
                      never shown on the public programme.
                    </span>
                  </label>
                  <Button variant="primary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save organisation and event details"}
                  </Button>
                </fieldset>
              </Form>
            ) : (
              <Form
                key={profile.revision}
                method="post"
                className="stack"
                onChange={() => setProfileDirty(true)}
              >
                <input
                  type="hidden"
                  name="_intent"
                  value="save_speaker_profile"
                />
                <input type="hidden" name="revision" value={profile.revision} />
                <fieldset className="stack pc-plain-fieldset">
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
                      LinkedIn profile URL
                      <input
                        className="field"
                        name="linkedinUrl"
                        type="url"
                        inputMode="url"
                        placeholder="https://www.linkedin.com/in/your-name"
                        defaultValue={profile.linkedinUrl ?? ""}
                        onBlur={(event) => {
                          event.currentTarget.value =
                            normalizeSpeakerLinkedinUrl(
                              event.currentTarget.value,
                            );
                        }}
                        maxLength={500}
                      />
                    </label>
                    <label className="label">
                      X handle
                      <input
                        className="field"
                        name="xHandle"
                        placeholder="@your_handle"
                        defaultValue={
                          profile.xHandle ? `@${profile.xHandle}` : ""
                        }
                        onBlur={(event) => {
                          event.currentTarget.value = formatSpeakerXHandleInput(
                            event.currentTarget.value,
                          );
                        }}
                        maxLength={500}
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
                  <label className="label">
                    Travel and logistics preferences
                    <textarea
                      className="textarea"
                      name="travelPreferences"
                      defaultValue={profile.travelPreferences ?? ""}
                      maxLength={2_000}
                      rows={4}
                      placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
                    />
                    <span className="help">
                      Private to the participant and authorised organisers;
                      never shown on the public programme.
                    </span>
                  </label>
                  <Button variant="primary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save profile"}
                  </Button>
                </fieldset>
              </Form>
            )}
            {customFields.length ? (
              <Form method="post" className="stack mt">
                <input type="hidden" name="_intent" value="save_event_fields" />
                <div className="card-title">
                  <div>
                    <span className="pc-section-kicker">Event-specific</span>
                    <h3>Additional information</h3>
                  </div>
                </div>
                <EventFieldInputs fields={customFields} />
                <Button type="submit" variant="primary" disabled={busy}>
                  Save additional information
                </Button>
              </Form>
            ) : null}
            <SpeakerProfileHistory
              revisions={detail.profileHistory}
              timeZone={event.timezone}
            />
          </section>
          <section className="crm-record-section" id="headshot">
            <h2>Headshot</h2>
            <div className="speaker-headshot-card">
              {headshot ? (
                <img
                  className="speaker-headshot-image"
                  src={`/admin/speakers/${profile.id}/files/${headshot.id}?view=headshot`}
                  alt={`${profile.name} headshot`}
                />
              ) : (
                <span className="speaker-headshot-placeholder">
                  <UserRound aria-hidden size={38} />
                </span>
              )}
              <div className="stack">
                <div>
                  <strong>
                    {headshot
                      ? "Current released headshot"
                      : "No released headshot"}
                  </strong>
                  {headshot ? (
                    <p className="subtle">
                      {headshot.downloadFilename} · uploaded by{" "}
                      {headshot.downloadUploaderName} ·{" "}
                      {formatTimestamp(
                        requireValue(
                          headshot.downloadUploadedAt,
                          "Required headshot.downloadUploadedAt is unavailable.",
                        ),
                        event.timezone,
                      )}
                    </p>
                  ) : (
                    <p className="subtle">
                      Upload a JPG, PNG or WebP replacement below. It remains
                      private until signature validation and malware scanning
                      pass.
                    </p>
                  )}
                </div>
                {headshot ? (
                  <ButtonAnchor
                    href={`/admin/speakers/${profile.id}/files/${headshot.id}`}
                  >
                    <Download aria-hidden size={14} /> Download headshot
                  </ButtonAnchor>
                ) : null}
              </div>
            </div>
            <DirectMultipartUpload
              target={{ targetType: "person", targetId: profile.id }}
              kinds={[
                {
                  value: "headshot",
                  label: `Headshot (JPG, PNG, WebP · ${maximumMegabytes(event.filePolicy.headshotMaximumBytes)} MB)`,
                  accept: "image/jpeg,image/png,image/webp",
                  maximumBytes: event.filePolicy.headshotMaximumBytes,
                },
              ]}
              heading={
                headshot
                  ? "Replace speaker headshot"
                  : "Upload speaker headshot"
              }
              description="Uploads stay private until format and malware checks pass."
            />
          </section>
        </div>
        <section className="crm-record-section" id="availability">
          <h2>Speaker availability</h2>
          <p className="subtle">
            Speakers record these unavailable times in {event.timezone}. The
            private note stays with the speaker.
          </p>
          {availability.windows.length === 0 ? (
            <p className="subtle">No unavailable periods recorded.</p>
          ) : (
            <ul className="stack">
              {availability.windows.map((window) => (
                <li key={window.id} className="stack">
                  <p>
                    <strong>
                      {formatEventLocalAvailabilityWindow(
                        window.startsAt,
                        window.endsAt,
                        event.timezone,
                      )}
                    </strong>
                  </p>
                  {window.overlappingSessions.length ? (
                    <p className="subtle">
                      Overlaps draft sessions:{" "}
                      {window.overlappingSessions
                        .map((session) => session.title)
                        .join(", ")}
                    </p>
                  ) : (
                    <p className="subtle">No overlapping draft sessions.</p>
                  )}
                  <Form method="post">
                    <input
                      type="hidden"
                      name="_intent"
                      value="delete_speaker_blackout"
                    />
                    <input
                      type="hidden"
                      name="eventRevision"
                      value={availability.event.revision}
                    />
                    <input type="hidden" name="windowId" value={window.id} />
                    <input type="hidden" name="confirmation" value="delete" />
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={(clickEvent) => {
                        const form = clickEvent.currentTarget.form;
                        if (!form) return;
                        confirmAction(
                          {
                            title: "Remove this unavailable period?",
                            description:
                              "The speaker can add the same period again. This does not edit the published programme.",
                            records: [
                              formatEventLocalAvailabilityWindow(
                                window.startsAt,
                                window.endsAt,
                                event.timezone,
                              ),
                              ...window.overlappingSessions.map(
                                (session) => `Overlaps “${session.title}”`,
                              ),
                            ],
                            confirmLabel: "Remove period",
                          },
                          () => {
                            form.requestSubmit();
                          },
                        );
                      }}
                    >
                      Remove unavailable period
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="crm-record-section" id="sessions">
          <h2>Linked sessions</h2>
          {sessions.length ? (
            <section
              className="table-wrap pc-responsive-table-wrap"
              aria-label="Linked speaker sessions"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
            >
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
                      <td
                        className="pc-record-primary-cell"
                        data-label="Session"
                      >
                        <span className="pc-record-identity">
                          <strong>{session.title}</strong>
                          <small>
                            {session.format} · {session.durationMinutes} minutes
                          </small>
                        </span>
                      </td>
                      <td data-label="Role">
                        <span className="pc-record-stack">
                          {session.roles.map((role) => (
                            <span key={role.role}>{role.label}</span>
                          ))}
                        </span>
                      </td>
                      <td data-label="Participation">
                        <span className="pc-speaker-meta">
                          {session.roles.map((role) => (
                            <span className="pc-record-stack" key={role.role}>
                              <span
                                className={`status ${role.participationStatus === "confirmed" ? "success" : role.participationStatus === "declined" ? "danger" : session.status === "cancelled" ? "" : "warning"}`}
                              >
                                {role.label}:{" "}
                                {role.participationStatus === "confirmed"
                                  ? "Accepted"
                                  : role.participationStatus === "declined"
                                    ? "Declined"
                                    : session.status === "cancelled"
                                      ? "Not required"
                                      : "Awaiting response"}
                              </span>
                              {role.participationDeclineReason ? (
                                <small>
                                  Private reason:{" "}
                                  {role.participationDeclineReason}
                                </small>
                              ) : null}
                            </span>
                          ))}
                        </span>
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
                              {formatTimestamp(
                                session.startsAt,
                                event.timezone,
                              )}
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
                        {session.status === "cancelled" ? (
                          <span className="subtle">Session cancelled</span>
                        ) : (
                          <div className="stack">
                            {session.roles.map((role) =>
                              role.participationStatus === "pending" ? (
                                <Form
                                  method="post"
                                  className="stack"
                                  key={`confirm:${role.role}`}
                                >
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
                                    name="role"
                                    value={role.role}
                                  />
                                  <input
                                    type="hidden"
                                    name="roleRevision"
                                    value={role.participationRevision}
                                  />
                                  <label className="check-row">
                                    <input
                                      type="checkbox"
                                      name="externalConfirmation"
                                      value="confirmed"
                                      required
                                    />
                                    <span>
                                      I confirm {profile.name} accepted the{" "}
                                      {role.label.toLowerCase()} role outside
                                      Program Cue.
                                    </span>
                                  </label>
                                  <Button
                                    size="small"
                                    type="submit"
                                    disabled={busy}
                                  >
                                    Record {role.label.toLowerCase()} acceptance
                                  </Button>
                                </Form>
                              ) : role.participationStatus === "declined" ? (
                                <Form
                                  method="post"
                                  className="stack"
                                  key={`reset:${role.role}`}
                                >
                                  <input
                                    type="hidden"
                                    name="_intent"
                                    value="reset_declined_participation"
                                  />
                                  <input
                                    type="hidden"
                                    name="sessionId"
                                    value={session.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="role"
                                    value={role.role}
                                  />
                                  <input
                                    type="hidden"
                                    name="roleRevision"
                                    value={role.participationRevision}
                                  />
                                  <input
                                    type="hidden"
                                    name="resetConfirmation"
                                    value="pending"
                                  />
                                  <Button
                                    size="small"
                                    type="button"
                                    disabled={busy}
                                    onClick={(event) => {
                                      const form = event.currentTarget.form;
                                      if (!form) return;
                                      confirmAction(
                                        {
                                          title: `Reset the ${role.label.toLowerCase()} role?`,
                                          description:
                                            "This clears the private decline reason and lets the participant respond again. No message is sent.",
                                          records: [
                                            session.title,
                                            profile.name,
                                            role.label,
                                          ],
                                          confirmLabel: "Reset role",
                                          tone: "primary",
                                        },
                                        () => form.requestSubmit(),
                                      );
                                    }}
                                  >
                                    Reset {role.label.toLowerCase()}
                                  </Button>
                                </Form>
                              ) : null,
                            )}
                            {(["speaker", "moderator", "chair"] as const)
                              .filter(
                                (role) =>
                                  !session.roles.some(
                                    (assigned) => assigned.role === role,
                                  ),
                              )
                              .map((role) => (
                                <Form method="post" key={`add:${role}`}>
                                  <input
                                    type="hidden"
                                    name="_intent"
                                    value="add_participant_role"
                                  />
                                  <input
                                    type="hidden"
                                    name="sessionId"
                                    value={session.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="role"
                                    value={role}
                                  />
                                  <input
                                    type="hidden"
                                    name="confirmation"
                                    value="add"
                                  />
                                  <Button
                                    size="small"
                                    type="button"
                                    disabled={busy}
                                    onClick={(event) => {
                                      const form = event.currentTarget.form;
                                      if (!form) return;
                                      const label =
                                        role === "chair"
                                          ? "Chair"
                                          : role === "moderator"
                                            ? "Moderator"
                                            : "Speaker";
                                      confirmAction(
                                        {
                                          title: `Assign the ${label.toLowerCase()} role?`,
                                          description:
                                            "The participant will respond to this role independently from any other role in the session.",
                                          records: [
                                            session.title,
                                            profile.name,
                                            label,
                                          ],
                                          confirmLabel: "Assign role",
                                          tone: "primary",
                                        },
                                        () => form.requestSubmit(),
                                      );
                                    }}
                                  >
                                    Add {role}
                                  </Button>
                                </Form>
                              ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <EmptyState
              icon={CalendarClock}
              title="No linked sessions"
              description="Link this speaker from a session in the schedule planner."
            />
          )}
        </section>
        <section className="crm-record-section" id="files">
          <h2>Uploaded files and versions</h2>
          <p className="subtle">
            Speaker uploads stay private to the speaker workspace. Organisers
            see the scan and release state of every stored version here and can
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
                      {file.versionNumber ?? "—"} ·{" "}
                      {formatBytes(file.sizeBytes)}
                    </small>
                    {file.downloadFilename && file.downloadUploadedAt ? (
                      <small>
                        Current released file: {file.downloadFilename} ·
                        uploaded by {file.downloadUploaderName} ·{" "}
                        {formatTimestamp(
                          file.downloadUploadedAt,
                          event.timezone,
                        )}
                      </small>
                    ) : null}
                  </span>
                  {file.scanStatus ? (
                    <DomainStatusBadge domain="file" status={file.scanStatus} />
                  ) : (
                    <span className="status warning">No scan result</span>
                  )}
                  {file.currentVersionId && file.downloadReleasedAt ? (
                    <ButtonAnchor
                      size="small"
                      href={`/admin/speakers/${profile.id}/files/${file.id}`}
                      aria-label={`Download released ${file.downloadFilename}`}
                    >
                      <Download aria-hidden size={14} /> Download
                    </ButtonAnchor>
                  ) : (
                    <span className="status warning">
                      <LockKeyhole aria-hidden size={13} /> Not released
                    </span>
                  )}
                  {file.versions.length ? (
                    <details className="file-history pc-disclosure">
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
            <EmptyState
              icon={FileCheck2}
              title="No uploaded files"
              description="Assign an upload task so this speaker can share headshots or slides."
              action={
                <ButtonLink to="/admin/tasks">
                  <ListChecks aria-hidden size={15} /> Manage tasks
                </ButtonLink>
              }
            />
          )}
        </section>
      </div>
    </>
  );
}

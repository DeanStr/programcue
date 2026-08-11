import { useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router";

import type { ActionResponse } from "~/routes/event-setup";
import type { EventSetup } from "~/modules/events/event-repository.server";
import {
  CANONICAL_EVENT_FILE_POLICY,
  maximumMegabytes,
} from "~/modules/files/file-policy";

const timezoneNames = (() => {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  return ["UTC", ...(supportedValuesOf ? supportedValuesOf("timeZone") : [])];
})();

function FieldError({
  actionData,
  name,
}: {
  actionData?: ActionResponse;
  name: string;
}) {
  const message = actionData?.errors?.[name]?.[0];
  return message ? (
    <span className="help" style={{ color: "var(--red)" }}>
      {message}
    </span>
  ) : null;
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="avatar sm" title={name}>
      {initials}
    </span>
  );
}

export function EventIdentityPanels({
  event,
  actionData,
}: {
  event: EventSetup;
  actionData?: ActionResponse;
}) {
  return (
    <>
      <section className="card pad">
        <div className="card-title">
          <h2>Event identity</h2>
        </div>
        <div className="form-row">
          <label className="label">
            Event name
            <input
              className="field"
              name="name"
              defaultValue={event.name}
              required
              maxLength={160}
            />
            <FieldError actionData={actionData} name="name" />
          </label>
          <label className="label">
            Timezone
            <input
              className="field"
              name="timezone"
              defaultValue={event.timezone}
              list="iana-timezones"
              required
              autoComplete="off"
            />
            <datalist id="iana-timezones">
              {timezoneNames.map((timezone) => (
                <option key={timezone} value={timezone} />
              ))}
            </datalist>
            <span className="help">
              Use an IANA timezone such as America/Toronto, Australia/Melbourne
              or UTC.
            </span>
            <FieldError actionData={actionData} name="timezone" />
          </label>
          <label className="label">
            Start date
            <input
              className="field"
              name="startDate"
              type="date"
              defaultValue={event.startDate}
              required
            />
          </label>
          <label className="label">
            End date
            <input
              className="field"
              name="endDate"
              type="date"
              defaultValue={event.endDate}
              required
            />
            <FieldError actionData={actionData} name="endDate" />
          </label>
          <label className="label">
            Venue
            <input
              className="field"
              name="venue"
              defaultValue={event.venue}
              maxLength={200}
            />
          </label>
          <label className="label">
            City
            <input
              className="field"
              name="city"
              defaultValue={event.city}
              maxLength={120}
            />
          </label>
        </div>
      </section>

      <section className="card pad">
        <div className="card-title">
          <h2>Public identity</h2>
        </div>
        <label className="label">
          Public slug
          {event.programmePublished ? (
            <input type="hidden" name="publicSlug" value={event.publicSlug} />
          ) : null}
          <input
            className="field"
            name={event.programmePublished ? undefined : "publicSlug"}
            defaultValue={event.publicSlug}
            required
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            disabled={event.programmePublished}
          />
          {event.programmePublished ? (
            <span className="help">
              Locked after programme publication to preserve every public,
              embed, API and calendar URL.
            </span>
          ) : null}
          <FieldError actionData={actionData} name="publicSlug" />
        </label>
        <label className="label mt">
          Brand accent
          <input
            className="field"
            name="brandAccent"
            type="color"
            defaultValue={event.brandAccent}
            aria-label="Brand accent"
          />
        </label>
        <label className="label mt">
          Programme description
          <textarea
            className="textarea"
            name="description"
            defaultValue={event.description}
            maxLength={2000}
          />
        </label>
      </section>
    </>
  );
}

export function EventRoomsPanel({
  rooms,
  setRooms,
  actionData,
  onAdd,
  onRemove,
  focusedRoomId,
}: {
  rooms: EventSetup["rooms"];
  setRooms: Dispatch<SetStateAction<EventSetup["rooms"]>>;
  actionData?: ActionResponse;
  onAdd: () => void;
  onRemove: (roomId: string) => void;
  focusedRoomId: string | null;
}) {
  const [resourceDrafts, setResourceDrafts] = useState<
    Record<string, string>
  >({});

  function addResource(roomId: string) {
    const resource = (resourceDrafts[roomId] ?? "").trim().toLowerCase();
    if (!resource) return;
    setRooms((current) =>
      current.map((room) =>
        room.id === roomId && !room.resources.includes(resource)
          ? { ...room, resources: [...room.resources, resource] }
          : room,
      ),
    );
    setResourceDrafts((current) => ({ ...current, [roomId]: "" }));
  }

  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Rooms and capacities</h2>
        <button type="button" className="btn small right" onClick={onAdd}>
          + Add room
        </button>
      </div>
      {rooms.length ? (
        rooms.map((room) => (
          <div
            className={`card pad mb${focusedRoomId === room.id ? " selected" : ""}`}
            id={`event-room-${room.id}`}
            key={room.id}
            tabIndex={-1}
            aria-label={`${room.name} room settings`}
          >
            <div className="form-row">
              <input
                className="field"
                value={room.name}
                aria-label="Room name"
                onChange={(changeEvent) =>
                  setRooms((current) =>
                    current.map((item) =>
                      item.id === room.id
                        ? { ...item, name: changeEvent.target.value }
                        : item,
                    ),
                  )
                }
              />
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="field"
                  type="number"
                  min={1}
                  value={room.capacity}
                  aria-label="Room capacity"
                  onChange={(changeEvent) =>
                    setRooms((current) =>
                      current.map((item) =>
                        item.id === room.id
                          ? {
                              ...item,
                              capacity: Number(changeEvent.target.value),
                            }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${room.name}`}
                  onClick={() => {
                    setRooms((current) =>
                      current.filter((item) => item.id !== room.id),
                    );
                    onRemove(room.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="mt">
              <strong>Available resources</strong>
              <p className="help">
                A session can only be placed here when every required resource
                is in this inventory.
              </p>
              <div className="row-main" style={{ flexWrap: "wrap" }}>
                {room.resources.map((resource) => (
                  <button
                    key={resource}
                    type="button"
                    className="tag"
                    aria-label={`Remove ${resource} from ${room.name}`}
                    onClick={() =>
                      setRooms((current) =>
                        current.map((candidate) =>
                          candidate.id === room.id
                            ? {
                                ...candidate,
                                resources: candidate.resources.filter(
                                  (item) => item !== resource,
                                ),
                              }
                            : candidate,
                        ),
                      )
                    }
                  >
                    {resource} ×
                  </button>
                ))}
                {!room.resources.length ? (
                  <span className="subtle">No resources</span>
                ) : null}
              </div>
              <div className="row-main mt">
                <input
                  className="field"
                  value={resourceDrafts[room.id] ?? ""}
                  maxLength={80}
                  placeholder="livestream crew"
                  aria-label={`New resource for ${room.name}`}
                  onChange={(changeEvent) =>
                    setResourceDrafts((current) => ({
                      ...current,
                      [room.id]: changeEvent.target.value,
                    }))
                  }
                  onKeyDown={(keyboardEvent) => {
                    if (keyboardEvent.key !== "Enter") return;
                    keyboardEvent.preventDefault();
                    addResource(room.id);
                  }}
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={!(resourceDrafts[room.id] ?? "").trim()}
                  onClick={() => addResource(room.id)}
                >
                  Add resource
                </button>
              </div>
            </div>
          </div>
        ))
      ) : (
        <p className="subtle">No rooms configured.</p>
      )}
      <FieldError actionData={actionData} name="rooms" />
    </section>
  );
}

export function EventFilePolicyPanel({
  event,
  actionData,
}: {
  event: EventSetup;
  actionData?: ActionResponse;
}) {
  const fields = [
    {
      name: "headshotMaximumMegabytes",
      label: "Headshots",
      value: event.filePolicy.headshotMaximumBytes,
      maximum: CANONICAL_EVENT_FILE_POLICY.headshotMaximumBytes,
      types: "JPG, PNG or WebP",
    },
    {
      name: "slidesMaximumMegabytes",
      label: "Presentation slides",
      value: event.filePolicy.slidesMaximumBytes,
      maximum: CANONICAL_EVENT_FILE_POLICY.slidesMaximumBytes,
      types: "PDF, PPT or PPTX",
    },
    {
      name: "supportingDocumentMaximumMegabytes",
      label: "Supporting documents",
      value: event.filePolicy.supportingDocumentMaximumBytes,
      maximum: CANONICAL_EVENT_FILE_POLICY.supportingDocumentMaximumBytes,
      types: "PDF, DOC/DOCX, XLS/XLSX or ZIP",
    },
    {
      name: "videoMaximumMegabytes",
      label: "Application video",
      value: event.filePolicy.videoMaximumBytes,
      maximum: CANONICAL_EVENT_FILE_POLICY.videoMaximumBytes,
      types: "MP4 or WebM",
    },
  ] as const;
  return (
    <section className="card pad">
      <div className="card-title">
        <h2>Private file limits</h2>
      </div>
      <p className="help">
        Limits are event-specific and may be reduced from Program Cue's secure
        canonical maxima. Allowed file types and scan/quarantine requirements
        cannot be relaxed here.
      </p>
      <div className="form-row mt">
        {fields.map((field) => (
          <label className="label" key={field.name}>
            {field.label} (MiB)
            <input
              className="field"
              name={field.name}
              type="number"
              min={1}
              max={maximumMegabytes(field.maximum)}
              step={1}
              defaultValue={maximumMegabytes(field.value)}
              required
            />
            <span className="help">{field.types}</span>
          </label>
        ))}
      </div>
      <FieldError actionData={actionData} name="filePolicy" />
    </section>
  );
}

export function EventAccessPanels({
  event,
  onInvite,
  onRevoke,
  onConfigureAirtable,
  onMigrateRepository,
  canManageFileRetention,
  canManageAdministrators,
}: {
  event: EventSetup;
  onInvite: () => void;
  onRevoke: (
    membershipId: string,
    name: string,
    scope: "event" | "organisation",
  ) => void;
  onConfigureAirtable: () => void;
  onMigrateRepository: () => void;
  canManageFileRetention: boolean;
  canManageAdministrators: boolean;
}) {
  return (
    <>
      <section className="card pad">
        <div className="card-title">
          <h2>Roles and access</h2>
          <button type="button" className="btn small right" onClick={onInvite}>
            Invite administrator
          </button>
        </div>
        <div className="stack">
          <div className="card pad">
            <strong>Organisation owners</strong>
            <p className="subtle">
              Manage organisation settings and all events.
            </p>
          </div>
          <div className="card pad">
            <strong>Administrators</strong>
            <p className="subtle">
              Event administrators manage this event. Organisation administrators
              manage every event in this organisation.
            </p>
            {event.administrators.map((administrator) => (
              <div className="row-main mt" key={administrator.id}>
                <Avatar name={administrator.name} />
                <span>
                  <strong>{administrator.name}</strong>
                  <small>
                    {administrator.email} · {administrator.scope === "organisation" ? "Organisation" : "Event"} · {administrator.status}
                  </small>
                </span>
                {canManageAdministrators ? (
                  <button
                    type="button"
                    className="btn small danger right"
                    onClick={() =>
                      onRevoke(
                        administrator.id,
                        administrator.name,
                        administrator.scope,
                      )
                    }
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            ))}
            {!event.administrators.length ? (
              <p className="help mt">No additional administrators are assigned.</p>
            ) : null}
          </div>
          <div className="card pad">
            <strong>Evaluators</strong>
            <p className="subtle">
              Review only assigned submissions. Cannot publish decisions.
            </p>
          </div>
        </div>
      </section>

      <section className="card pad">
        <div className="card-title">
          <h2>Submission access</h2>
        </div>
        <label className="label">
          Public form access
          <select
            className="select"
            name="submissionAccessMode"
            defaultValue={event.submissionAccessMode}
          >
            <option value="email_verified">
              Email verified before final submit
            </option>
            <option value="account_required">Account required</option>
            <option value="password_protected">Password protected</option>
          </select>
        </label>
        <label className="toggle mt">
          <input
            type="checkbox"
            name="allowAnonymousDrafts"
            defaultChecked={event.allowAnonymousDrafts}
          />{" "}
          Allow anonymous start and draft recovery
        </label>
        <label className="toggle mt">
          <input
            type="checkbox"
            name="duplicatePersonWarnings"
            defaultChecked={event.duplicatePersonWarnings}
          />{" "}
          Enable duplicate-person warnings
        </label>
      </section>

      <section className="card pad">
        <div className="card-title">
          <h2>Provider and retention</h2>
          <span
            className={`status ${event.repositoryProvider === "airtable" ? "success" : "info"}`}
          >
            {event.repositoryProvider === "airtable"
              ? "Airtable event data"
              : "D1 native"}
          </span>
        </div>
        <input
          type="hidden"
          name="repositoryProvider"
          value={event.repositoryProvider}
        />
        <p className="help">
          {event.repositoryProvider === "airtable"
            ? "Airtable is authoritative for managed event configuration, rooms and resources, tracks and formats, forms and submissions, evaluation workflow, accepted/direct sessions, schedules, onboarding tasks and the versioned published programme. D1 retains tenancy, identity, secrets, audit, outbox and operation control plus an exact synchronized projection. Files, communications, calendars and resource pages remain explicitly D1-backed."
            : "D1 is authoritative. Airtable can become authoritative for the complete managed event-data scope only through a validated, confirmed migration. Files, communications, calendars and resource pages remain D1-backed."}
        </p>
        <div className="stack-list mt">
          <div className="validation-item">
            <div>
              <strong>Event-data freshness</strong>
              <div className="help">
                {event.repositoryFreshness.source === "airtable"
                  ? `${event.repositoryFreshness.cached ? "Cached" : "Fetched"} from Airtable at ${new Date(event.repositoryFreshness.fetchedAt * 1_000).toLocaleString()}`
                  : "Current D1 transaction state"}
              </div>
            </div>
          </div>
          <div className="validation-item">
            <div>
              <strong>Airtable connection</strong>
              <div className="help">
                {event.repositoryConnection
                  ? `${event.repositoryConnection.baseId} · ${event.repositoryConnection.tableName} · ${event.repositoryConnection.status.replaceAll("_", " ")}`
                  : "Not configured"}
              </div>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={onConfigureAirtable}
            >
              {event.repositoryConnection ? "Revalidate" : "Configure"}
            </button>
          </div>
        </div>
        {event.repositoryConnection?.status === "connected" ? (
          <button
            type="button"
            className="btn mt"
            onClick={onMigrateRepository}
          >
            Preview migration to{" "}
            {event.repositoryProvider === "d1" ? "Airtable" : "D1"}
          </button>
        ) : null}
        {event.repositoryLockedAt ? (
          <p className="help mt">
            Provider choice is locked. Every later change requires a fresh
            reconciliation preview and explicit confirmation.
          </p>
        ) : null}
        <label className="label mt">
          Retention after event
          <select
            className="select"
            name="retentionMonths"
            defaultValue={String(event.retentionMonths)}
          >
            <option value="12">12 months</option>
            <option value="24">24 months</option>
            <option value="36">36 months</option>
          </select>
        </label>
        {canManageFileRetention ? (
          <div className="mt">
            <Link className="btn small" to="/admin/files/retention">
              Manage legal hold, erasure and anonymisation
            </Link>
          </div>
        ) : null}
      </section>
    </>
  );
}

import { Plus, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { Link } from "react-router";

import {
  RecordChevron,
  RecordField,
  RecordHead,
} from "~/components/event-record-row";
import { CharacterCount } from "~/components/ui/character-count";
import { EventDateRangeFields } from "~/components/ui/event-date-range-fields";
import { Field } from "~/components/ui/field";
import { TimezoneField } from "~/components/ui/timezone-field";
import { AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES } from "~/modules/airtable/airtable-schema";
import type { EventSetup } from "~/modules/events/event-repository.server";
import {
  CANONICAL_EVENT_FILE_POLICY,
  maximumMegabytes,
} from "~/modules/files/file-policy";
import type { ActionResponse } from "~/routes/event-setup";

function FieldError({
  actionData,
  name,
}: {
  actionData?: ActionResponse;
  name: string;
}) {
  const message = actionData?.errors?.[name]?.[0];
  return message ? <span className="pc-field-error">{message}</span> : null;
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
  const [timezone, setTimezone] = useState(event.timezone);
  const [description, setDescription] = useState(event.description);
  useEffect(() => setTimezone(event.timezone), [event.id, event.timezone]);
  useEffect(
    () => setDescription(event.description),
    [event.description, event.id],
  );
  return (
    <>
      <section className="card pad">
        <div className="card-title">
          <h3>Event identity</h3>
        </div>
        <div className="form-row event-identity-fields">
          <Field
            label="Event name"
            required
            error={actionData?.errors?.name?.[0]}
          >
            <input
              id="event-setup-name"
              className="field"
              name="name"
              defaultValue={event.name}
              required
              maxLength={160}
            />
          </Field>
          <TimezoneField
            id="event-setup-timezone"
            value={timezone}
            onChange={setTimezone}
            error={actionData?.errors?.timezone?.[0]}
          />
          <label className="label">
            Venue
            <input
              className="field"
              name="venue"
              defaultValue={event.venue}
              maxLength={200}
            />
          </label>
          <EventDateRangeFields
            idPrefix="event-setup"
            initialStartDate={event.startDate}
            initialEndDate={event.endDate}
            error={
              actionData?.errors?.endDate?.[0] ??
              actionData?.errors?.startDate?.[0]
            }
          />
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
        <div className="form-row mt">
          <label className="label">
            Venue address
            <input
              className="field"
              name="venueAddress"
              defaultValue={event.venueAddress}
              maxLength={300}
              placeholder="255 Front St W, Toronto, ON M5V 2W6"
            />
            <span className="help">
              Shown on the published programme. Leave blank to show the city
              alone.
            </span>
            <FieldError actionData={actionData} name="venueAddress" />
          </label>
          <label className="label">
            Venue map URL
            <input
              className="field"
              name="venueMapUrl"
              type="url"
              inputMode="url"
              placeholder="https://maps.example.com/venue"
              defaultValue={event.venueMapUrl}
              maxLength={2048}
            />
            <span className="help">
              Optional HTTPS link opened from the programme&rsquo;s venue panel.
            </span>
            <FieldError actionData={actionData} name="venueMapUrl" />
          </label>
        </div>
      </section>

      <section className="card pad">
        <div className="card-title">
          <h3>Public identity</h3>
        </div>
        <div className="form-row">
          <label className="label">
            Public slug
            {event.programmePublished ? (
              <input type="hidden" name="publicSlug" value={event.publicSlug} />
            ) : null}
            <input
              id="event-setup-publicSlug"
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
          <label className="label">
            Programme description
            <textarea
              id="event-setup-description"
              className="textarea"
              name="description"
              value={description}
              onChange={(inputEvent) =>
                setDescription(inputEvent.currentTarget.value)
              }
              maxLength={2000}
              aria-describedby="event-setup-description-count"
            />
            <CharacterCount
              id="event-setup-description-count"
              value={description}
              maximum={2000}
            />
          </label>
        </div>
        <div className="validation-item mt">
          <div>
            <strong>Visual identity and participant welcome</strong>
            <p className="help">
              Logo, banner, accent, welcome message and support link use a
              separate draft and explicit publication workflow.
            </p>
          </div>
          <Link className="btn small right" to="/admin/branding">
            Manage branding
          </Link>
        </div>
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
  onDraftStateChange,
}: {
  rooms: EventSetup["rooms"];
  setRooms: Dispatch<SetStateAction<EventSetup["rooms"]>>;
  actionData?: ActionResponse;
  onAdd: () => void;
  onRemove: (roomId: string) => void;
  focusedRoomId: string | null;
  onDraftStateChange: (draftKey: string, value: string) => void;
}) {
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, string>>(
    {},
  );

  function updateResourceDraft(roomId: string, value: string) {
    const nextDrafts = { ...resourceDrafts, [roomId]: value };
    setResourceDrafts(nextDrafts);
    onDraftStateChange(`room-resource:${roomId}`, value);
  }

  function clearResourceDraft(roomId: string) {
    const nextDrafts = { ...resourceDrafts };
    delete nextDrafts[roomId];
    setResourceDrafts(nextDrafts);
    onDraftStateChange(`room-resource:${roomId}`, "");
  }

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
    clearResourceDraft(roomId);
  }

  return (
    <details
      className="card pad event-record-panel"
      // A deep link from the command palette focuses a room by id, which cannot
      // happen inside a closed panel.
      open={
        focusedRoomId !== null || Boolean(actionData?.errors?.rooms?.length)
      }
    >
      <summary>
        <RecordChevron />
        {/* Closed, this row used to spend 78px on one integer. The same row now
            names the first few records, so an operator can see whether the
            rooms they expect exist without opening and re-closing the panel. */}
        <div className="event-record-summary">
          <h3>Rooms and capacities</h3>
          {rooms.length ? (
            <div className="event-record-preview">
              {rooms.slice(0, 4).map((room) => (
                <span className="event-record-chip" key={room.id}>
                  {room.name} · <span className="pc-num">{room.capacity}</span>
                </span>
              ))}
              {rooms.length > 4 ? (
                <span className="event-record-chip">
                  +{rooms.length - 4} more
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <span className="event-record-count">
          {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
        </span>
      </summary>
      <div className="event-record-body">
        <div className="event-record-intro">
          <p className="help">
            A session can only be placed in a room when every resource it
            requires is in that room's inventory.
          </p>
          <button type="button" className="btn small" onClick={onAdd}>
            <Plus aria-hidden size={14} /> Add room
          </button>
        </div>
        {rooms.length ? (
          <div>
            <RecordHead
              columns="event-room-columns"
              captions={["Room", "Capacity", "Available resources", ""]}
            />
            <div className="event-record-list">
              {rooms.map((room) => (
                <fieldset
                  className={`event-record-row event-room-columns pc-plain-fieldset${focusedRoomId === room.id ? " selected" : ""}`}
                  id={`event-room-${room.id}`}
                  key={room.id}
                  tabIndex={-1}
                  aria-label={`${room.name} room settings`}
                >
                  <RecordField
                    caption="Room"
                    accessibleCaption={`${room.name} room name`}
                  >
                    <input
                      className="field"
                      value={room.name}
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
                  </RecordField>
                  <RecordField
                    caption="Capacity"
                    accessibleCaption={`${room.name} capacity`}
                  >
                    <input
                      className="field"
                      type="number"
                      min={1}
                      value={room.capacity}
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
                  </RecordField>
                  <div className="event-record-resources">
                    {room.resources.map((resource) => (
                      <button
                        key={resource}
                        type="button"
                        className="event-record-resource"
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
                        {resource}
                        <X aria-hidden size={13} />
                      </button>
                    ))}
                    <input
                      className="field"
                      value={resourceDrafts[room.id] ?? ""}
                      data-event-record-draft={`room-resource:${room.id}`}
                      maxLength={80}
                      placeholder="Add a resource"
                      aria-label={`New resource for ${room.name}`}
                      onChange={(changeEvent) =>
                        updateResourceDraft(room.id, changeEvent.target.value)
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
                  <div className="event-record-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${room.name}`}
                      onClick={() => {
                        setRooms((current) =>
                          current.filter((item) => item.id !== room.id),
                        );
                        clearResourceDraft(room.id);
                        onRemove(room.id);
                      }}
                    >
                      <X aria-hidden size={15} />
                    </button>
                  </div>
                </fieldset>
              ))}
            </div>
          </div>
        ) : (
          <p className="subtle">No rooms configured.</p>
        )}
        <FieldError actionData={actionData} name="rooms" />
      </div>
    </details>
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
        <h3>Private file limits</h3>
      </div>
      <p className="help">
        Limits are event-specific and may be reduced from Program Cue's secure
        canonical maxima. Allowed file types and scan/quarantine requirements
        cannot be relaxed here.
      </p>
      {/* Four numbers that are only meaningful against each other and against
          their ceiling. Left-aligned in half-width boxes they lined up on no
          digit at all, the unit was printed four times, and the canonical
          maximum the help text promises exists was never shown. */}
      <div className="event-file-limits mt">
        {fields.map((field) => (
          <div className="event-file-limit" key={field.name}>
            <label htmlFor={`event-file-limit-${field.name}`}>
              {field.label}
              <small>{field.types}</small>
            </label>
            <span className="event-file-limit-value">
              <input
                id={`event-file-limit-${field.name}`}
                className="field"
                name={field.name}
                type="number"
                min={1}
                max={maximumMegabytes(field.maximum)}
                step={1}
                defaultValue={maximumMegabytes(field.value)}
                required
                aria-describedby={`event-file-limit-${field.name}-ceiling`}
              />
              <span
                className="subtle"
                id={`event-file-limit-${field.name}-ceiling`}
              >
                MiB, up to{" "}
                <span className="pc-num">
                  {maximumMegabytes(field.maximum)}
                </span>
              </span>
            </span>
          </div>
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
  canManageAdministrators,
}: {
  event: EventSetup;
  onInvite: () => void;
  onRevoke: (
    membershipId: string,
    name: string,
    scope: "event" | "organisation",
  ) => void;
  canManageAdministrators: boolean;
}) {
  return (
    <>
      <section className="card pad">
        <div className="card-title">
          <h3>Roles and access</h3>
          <button type="button" className="btn small right" onClick={onInvite}>
            Invite administrator
          </button>
        </div>
        {/* Organisation owners and evaluators had a titled band each, with a
            rule above and below and nothing in either to change. Two thirds of
            this card was a permissions model restated as prose in a place the
            operator opened to edit something. They are one sentence now, under
            the list they qualify. */}
        <div className="event-role-group">
          <strong>Administrators</strong>
          <p className="subtle">
            Event administrators manage this event. Organisation administrators
            manage every event in this organisation.
          </p>
          {event.administrators.map((administrator) => (
            <div className="row-main mt event-admin-row" key={administrator.id}>
              <Avatar name={administrator.name} />
              <span className="event-admin-identity">
                <strong>{administrator.name}</strong>
                <small>{administrator.email}</small>
              </span>
              <span
                className={`status ${administrator.status === "Active" ? "success" : "warning"}`}
              >
                {administrator.scope === "organisation"
                  ? "Organisation"
                  : "Event"}{" "}
                · {administrator.status}
              </span>
              {canManageAdministrators ? (
                <button
                  type="button"
                  className="btn small danger"
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
            <p className="help mt">
              No additional administrators are assigned.
            </p>
          ) : null}
        </div>
        <p className="help mt">
          Organisation owners manage organisation settings and every event.
          Evaluators review only assigned submissions and cannot publish
          decisions.
        </p>
      </section>

      <section className="card pad">
        <div className="card-title">
          <h3>Submission access</h3>
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
    </>
  );
}

export function EventRepositoryPanel({
  event,
  onConfigureAirtable,
  onMigrateRepository,
  canManageFileRetention,
  hasUnsavedChanges,
}: {
  event: EventSetup;
  onConfigureAirtable: () => void;
  onMigrateRepository: () => void;
  canManageFileRetention: boolean;
  hasUnsavedChanges: boolean;
}) {
  const unsavedHelpId = "event-repository-unsaved-help";
  return (
    <section className="card pad">
      <div className="card-title">
        <h3>Provider and retention</h3>
        <span
          className={`status ${event.repositoryProvider === "airtable" ? "success" : "info"}`}
        >
          {event.repositoryProvider === "airtable"
            ? "Airtable holds event data"
            : "Program Cue holds event data"}
        </span>
      </div>
      <input
        type="hidden"
        name="repositoryProvider"
        value={event.repositoryProvider}
      />
      <p className="help">
        {event.repositoryProvider === "airtable"
          ? "Airtable is the source of truth for event settings, rooms and resources, tracks and formats, forms and submissions, evaluation workflow, accepted and direct sessions, schedules, onboarding tasks and the published programme. Program Cue keeps accounts, permissions, credentials, history and a matching copy of everything above. Files, communications, calendars and resource pages always stay in Program Cue."
          : "Program Cue is the source of truth for this event. Airtable can take over event data only through a preview you review and confirm. Files, communications, calendars and resource pages always stay in Program Cue."}
      </p>
      <div className="stack-list mt">
        <div className="validation-item">
          <div>
            <strong>Event-data freshness</strong>
            <div className="help">
              {event.repositoryFreshness.source === "airtable"
                ? `${event.repositoryFreshness.cached ? "Cached" : "Fetched"} from Airtable at ${new Date(event.repositoryFreshness.fetchedAt * 1_000).toLocaleString()}`
                : "Live from Program Cue"}
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
            disabled={hasUnsavedChanges}
            aria-describedby={hasUnsavedChanges ? unsavedHelpId : undefined}
          >
            {event.repositoryConnection ? "Revalidate" : "Configure"}
          </button>
        </div>
      </div>
      {event.repositoryConnection?.status === "connected" ? (
        <div className="mt">
          <button
            type="button"
            className="btn"
            onClick={onMigrateRepository}
            disabled={hasUnsavedChanges}
            aria-describedby={hasUnsavedChanges ? unsavedHelpId : undefined}
          >
            Preview handover to{" "}
            {event.repositoryProvider === "d1" ? "Airtable" : "Program Cue"}
          </button>
          <p className="help mt">
            The handover runs while you wait, and stops before changing anything
            if more than {AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES} records
            would change. Keep larger events on Program Cue, which is the
            recommended option.
          </p>
        </div>
      ) : null}
      {hasUnsavedChanges ? (
        <p className="validation-item warn mt" id={unsavedHelpId} role="status">
          Save or discard your Event Setup edits before changing where event
          data is held.
        </p>
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
  );
}

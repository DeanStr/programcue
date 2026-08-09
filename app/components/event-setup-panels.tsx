import type { Dispatch, SetStateAction } from "react";

import type { ActionResponse } from "~/routes/event-setup";
import type { EventSetup } from "~/modules/events/event-repository.server";

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
}: {
  rooms: EventSetup["rooms"];
  setRooms: Dispatch<SetStateAction<EventSetup["rooms"]>>;
  actionData?: ActionResponse;
  onAdd: () => void;
}) {
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
          <div className="form-row mb" key={room.id}>
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
                onClick={() =>
                  setRooms((current) =>
                    current.filter((item) => item.id !== room.id),
                  )
                }
              >
                ×
              </button>
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

export function EventAccessPanels({
  event,
  onInvite,
}: {
  event: EventSetup;
  onInvite: () => void;
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
            <strong>Event administrators</strong>
            <p className="subtle">
              Manage forms, submissions, decisions, schedule, communications and
              integrations.
            </p>
            {event.administrators.map((administrator) => (
              <div className="row-main mt" key={administrator.id}>
                <Avatar name={administrator.name} />
                <span>
                  <strong>{administrator.name}</strong>
                  <small>
                    {administrator.email} · {administrator.status}
                  </small>
                </span>
              </div>
            ))}
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
        </div>
        <label className="label">
          Event repository
          <select
            className="select"
            name="repositoryProvider"
            defaultValue={event.repositoryProvider}
          >
            <option value="d1">D1 native (recommended)</option>
            <option value="airtable" disabled>
              Airtable adapter (not implemented)
            </option>
          </select>
          <span className="help">
            Provider changes require a validated migration after data exists.
          </span>
        </label>
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
      </section>
    </>
  );
}

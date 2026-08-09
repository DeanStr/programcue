import { useEffect, useMemo, useState } from "react";
import {
  data,
  Form,
  useActionData,
  useFetcher,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/event-setup";
import { Dialog } from "~/components/dialog";
import {
  EventRevisionConflictError,
  EventSlugConflictError,
  EventRoomInUseError,
  EventRoomOwnershipError,
  EventPublishedScheduleConflictError,
  EventPublishedProgrammeSlugError,
  EventAdministratorAlreadyActiveError,
  type EventSetup,
} from "~/modules/events/event-repository.server";
import {
  EventInvitationDeliveryError,
  EventService,
} from "~/modules/events/event-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta: Route.MetaFunction = () => [
  { title: "Event Setup · Program Cue" },
];

const timezoneNames = (() => {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  return ["UTC", ...(supportedValuesOf ? supportedValuesOf("timeZone") : [])];
})();

type ActionResponse = {
  ok: boolean;
  intent: "save" | "invite";
  message: string;
  errors?: Record<string, string[]>;
  committed?: boolean;
};

async function getViewer(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const eventId = env.DEFAULT_EVENT_ID;
  if (!eventId)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  return requireEventRole(request, env, eventId, ["owner", "administrator"]);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const event = await new EventService(env).getSetup(viewer);
  return { event };
}

function firstZodMessage(error: ZodError) {
  const flattened = error.flatten();
  const errors: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    if (Array.isArray(messages) && messages.length)
      errors[field] = messages.map(String);
  }
  return {
    message:
      error.issues[0]?.message ?? "Review the highlighted event settings.",
    errors,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const service = new EventService(env);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  try {
    if (intent === "invite") {
      const result = await service.inviteAdministrator(viewer, {
        name: formData.get("name"),
        email: formData.get("email"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "created",
      });
      if (realtimeFailure) {
        return data<ActionResponse>(
          {
            ...realtimeFailure,
            intent: "invite",
            message: `${result.delivery === "sent" ? "The invitation was saved and its sign-in link was sent." : "The demo invitation was saved without sending email."} ${realtimeFailure.message}`,
          },
          { status: 207 },
        );
      }
      return data<ActionResponse>({
        ok: true,
        intent: "invite",
        message:
          result.delivery === "sent"
            ? "Administrator invitation created and a one-time sign-in link was sent."
            : "Demo invitation created in D1. No email was sent in explicit demo mode.",
      });
    }

    if (intent !== "save") {
      return data<ActionResponse>(
        { ok: false, intent: "save", message: "Unknown Event Setup action." },
        { status: 400 },
      );
    }

    let parsedRooms: unknown;
    try {
      parsedRooms = JSON.parse(String(formData.get("rooms") ?? "[]"));
    } catch {
      return data<ActionResponse>(
        {
          ok: false,
          intent: "save",
          message: "Room data is invalid. Refresh before trying again.",
        },
        { status: 400 },
      );
    }

    await service.saveSetup(viewer, {
      revision: formData.get("revision"),
      name: formData.get("name"),
      timezone: formData.get("timezone"),
      startDate: formData.get("startDate"),
      endDate: formData.get("endDate"),
      venue: formData.get("venue"),
      city: formData.get("city"),
      publicSlug: formData.get("publicSlug"),
      brandAccent: formData.get("brandAccent"),
      description: formData.get("description"),
      repositoryProvider: formData.get("repositoryProvider"),
      retentionMonths: formData.get("retentionMonths"),
      submissionAccessMode: formData.get("submissionAccessMode"),
      allowAnonymousDrafts: formData.has("allowAnonymousDrafts"),
      duplicatePersonWarnings: formData.has("duplicatePersonWarnings"),
      rooms: parsedRooms,
    });

    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "event",
      entityId: viewer.eventId,
      changeType: "updated",
    });
    if (realtimeFailure)
      return data<ActionResponse>(
        { ...realtimeFailure, intent: "save" },
        { status: 207 },
      );
    return data<ActionResponse>({
      ok: true,
      intent: "save",
      message: "Event settings saved to D1.",
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const result = firstZodMessage(error);
      return data<ActionResponse>(
        {
          ok: false,
          intent: intent === "invite" ? "invite" : "save",
          ...result,
        },
        { status: 422 },
      );
    }
    if (error instanceof EventInvitationDeliveryError) {
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: error.membershipId,
        changeType: "created",
      });
      return data<ActionResponse>(
        {
          ok: false,
          intent: "invite",
          message: realtimeFailure
            ? `${error.message} ${realtimeFailure.message}`
            : error.message,
          committed: true,
        },
        { status: 207 },
      );
    }
    if (error instanceof EventAdministratorAlreadyActiveError) {
      return data<ActionResponse>(
        { ok: false, intent: "invite", message: error.message },
        { status: 409 },
      );
    }
    if (
      error instanceof EventRevisionConflictError ||
      error instanceof EventSlugConflictError ||
      error instanceof EventRoomInUseError ||
      error instanceof EventRoomOwnershipError ||
      error instanceof EventPublishedScheduleConflictError ||
      error instanceof EventPublishedProgrammeSlugError
    ) {
      return data<ActionResponse>(
        { ok: false, intent: "save", message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
}

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

function EventSetupForm({ event }: { event: EventSetup }) {
  const actionData = useActionData<typeof action>() as
    ActionResponse | undefined;
  const inviteFetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const [rooms, setRooms] = useState(event.rooms);
  const [addRoomOpen, setAddRoomOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomCapacity, setNewRoomCapacity] = useState("100");
  const saving =
    navigation.state === "submitting" &&
    navigation.formData?.get("_intent") === "save";

  // Invitation fetchers revalidate this route without changing the persisted
  // event revision. Preserve local room edits across that revalidation and only
  // replace them after Event Setup itself commits a newer revision.
  useEffect(() => setRooms(event.rooms), [event.revision]);
  useEffect(() => {
    if (inviteFetcher.data && (inviteFetcher.data as ActionResponse).ok)
      setInviteOpen(false);
  }, [inviteFetcher.data]);

  const orderedRooms = useMemo(
    () => rooms.map((room, position) => ({ ...room, position })),
    [rooms],
  );
  const inviteData = inviteFetcher.data as ActionResponse | undefined;

  function addRoom() {
    const capacity = Number(newRoomCapacity);
    if (!newRoomName.trim() || !Number.isInteger(capacity) || capacity < 1)
      return;
    setRooms((current) => [
      ...current,
      {
        id: `room-${crypto.randomUUID()}`,
        name: newRoomName.trim(),
        capacity,
        position: current.length,
      },
    ]);
    setNewRoomName("");
    setNewRoomCapacity("100");
    setAddRoomOpen(false);
  }

  return (
    <>
      <Form method="post">
        <input type="hidden" name="_intent" value="save" />
        <input type="hidden" name="revision" value={event.revision} />
        <input
          type="hidden"
          name="rooms"
          value={JSON.stringify(orderedRooms)}
        />

        <div className="page-head">
          <div>
            <h1>Event Setup</h1>
            <p>
              Configure event identity, programme structure, access and delivery
              defaults.
            </p>
          </div>
          <div className="page-actions">
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Saving…" : "Save event"}
            </button>
          </div>
        </div>

        {actionData ? (
          <div
            className={`card pad mb validation-item ${actionData.ok ? "ok" : "error"}`}
            role={actionData.ok ? "status" : "alert"}
          >
            <strong>{actionData.ok ? "✓" : "△"}</strong>
            <span>{actionData.message}</span>
          </div>
        ) : null}
        {inviteData ? (
          <div
            className={`card pad mb validation-item ${inviteData.ok ? "ok" : "error"}`}
            role={inviteData.ok ? "status" : "alert"}
          >
            <strong>{inviteData.ok ? "✓" : "△"}</strong>
            <span>{inviteData.message}</span>
          </div>
        ) : null}

        <div className="grid grid-2">
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
                  Use an IANA timezone such as America/Toronto,
                  Australia/Melbourne or UTC.
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
                <input
                  type="hidden"
                  name="publicSlug"
                  value={event.publicSlug}
                />
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

          <section className="card pad">
            <div className="card-title">
              <h2>Rooms and capacities</h2>
              <button
                type="button"
                className="btn small right"
                onClick={() => setAddRoomOpen(true)}
              >
                + Add room
              </button>
            </div>
            {rooms.length ? (
              rooms.map((room, index) => (
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

          <section className="card pad">
            <div className="card-title">
              <h2>Roles and access</h2>
              <button
                type="button"
                className="btn small right"
                onClick={() => setInviteOpen(true)}
              >
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
                  Manage forms, submissions, decisions, schedule, communications
                  and integrations.
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
                Provider changes require a validated migration after data
                exists.
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
        </div>
      </Form>

      {addRoomOpen ? (
        <Dialog
          title="Add room"
          onClose={() => setAddRoomOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setAddRoomOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={addRoom}
                disabled={!newRoomName.trim() || Number(newRoomCapacity) < 1}
              >
                Add room
              </button>
            </>
          }
        >
          <label className="label">
            Room name
            <input
              className="field"
              autoFocus
              placeholder="Room 304"
              value={newRoomName}
              onChange={(inputEvent) => setNewRoomName(inputEvent.target.value)}
            />
          </label>
          <label className="label mt">
            Capacity
            <input
              className="field"
              type="number"
              min={1}
              value={newRoomCapacity}
              onChange={(inputEvent) =>
                setNewRoomCapacity(inputEvent.target.value)
              }
            />
          </label>
        </Dialog>
      ) : null}

      {inviteOpen ? (
        <Dialog
          title="Invite event administrator"
          onClose={() => setInviteOpen(false)}
        >
          <inviteFetcher.Form method="post">
            <input type="hidden" name="_intent" value="invite" />
            <label className="label">
              Name
              <input
                className="field"
                name="name"
                placeholder="Administrator name"
                required
              />
            </label>
            <label className="label mt">
              Email
              <input
                className="field"
                name="email"
                type="email"
                placeholder="admin@example.com"
                required
              />
            </label>
            {inviteData && !inviteData.ok ? (
              <p className="validation-item error">{inviteData.message}</p>
            ) : null}
            <div className="modal-foot" style={{ margin: "18px -18px -18px" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={inviteFetcher.state !== "idle"}
              >
                {inviteFetcher.state === "submitting"
                  ? "Creating…"
                  : "Create invitation"}
              </button>
            </div>
          </inviteFetcher.Form>
        </Dialog>
      ) : null}
    </>
  );
}

export default function EventSetupRoute({ loaderData }: Route.ComponentProps) {
  return (
    <EventSetupForm key={loaderData.event.revision} event={loaderData.event} />
  );
}

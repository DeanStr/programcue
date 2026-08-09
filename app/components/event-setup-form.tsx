import { useEffect, useMemo, useState } from "react";
import { Form, useActionData, useFetcher, useNavigation } from "react-router";

import { Dialog } from "~/components/dialog";
import {
  EventAccessPanels,
  EventIdentityPanels,
  EventRoomsPanel,
} from "~/components/event-setup-panels";
import type { EventSetup } from "~/modules/events/event-repository.server";
import type { action, ActionResponse } from "~/routes/event-setup";

export function EventSetupForm({ event }: { event: EventSetup }) {
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
          <EventIdentityPanels event={event} actionData={actionData} />
          <EventRoomsPanel
            rooms={rooms}
            setRooms={setRooms}
            actionData={actionData}
            onAdd={() => setAddRoomOpen(true)}
          />
          <EventAccessPanels
            event={event}
            onInvite={() => setInviteOpen(true)}
          />
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

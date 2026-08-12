import { useEffect, useMemo, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useNavigate,
  useNavigation,
} from "react-router";

import { Dialog } from "~/components/dialog";
import {
  EventAccessPanels,
  EventFilePolicyPanel,
  EventIdentityPanels,
  EventRoomsPanel,
} from "~/components/event-setup-panels";
import { EventScheduleConfigurationPanels } from "~/components/event-schedule-configuration-panel";
import { useConfirm } from "~/components/ui/confirm-dialog";
import type { EventSetup } from "~/modules/events/event-repository.server";
import type { IncompleteEventSummary } from "~/modules/events/event-repository-recovery.server";
import type { action, ActionResponse } from "~/routes/event-setup";

export function EventSetupForm({
  event,
  incompleteEvents,
  focusedRecord,
  canManageFileRetention,
  canManageOrganisationAdministrators,
}: {
  event: EventSetup;
  incompleteEvents: IncompleteEventSummary[];
  focusedRecord: { kind: "room" | "track"; id: string } | null;
  canManageFileRetention: boolean;
  canManageOrganisationAdministrators: boolean;
}) {
  const actionData = useActionData<typeof action>() as
    ActionResponse | undefined;
  const inviteFetcher = useFetcher<typeof action>();
  const repositoryFetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const [rooms, setRooms] = useState(event.rooms);
  const [tracks, setTracks] = useState(event.tracks);
  const [sessionFormats, setSessionFormats] = useState(event.sessionFormats);
  const [addRoomOpen, setAddRoomOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [airtableOpen, setAirtableOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomCapacity, setNewRoomCapacity] = useState("100");
  const focusedRecordId = focusedRecord?.id ?? null;
  const focusedRecordKind = focusedRecord?.kind ?? null;
  const saving =
    navigation.state === "submitting" &&
    navigation.formData?.get("_intent") === "save";

  // Invitation fetchers revalidate this route without changing the persisted
  // event revision. Preserve local room edits across that revalidation and only
  // replace them after Event Setup itself commits a newer revision.
  useEffect(() => {
    setRooms(event.rooms);
    setTracks(event.tracks);
    setSessionFormats(event.sessionFormats);
  }, [event.revision]);
  useEffect(() => {
    if (!focusedRecordId || !focusedRecordKind) return;
    const target = document.getElementById(
      `event-${focusedRecordKind}-${focusedRecordId}`,
    );
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [focusedRecordId, focusedRecordKind]);
  useEffect(() => {
    if (inviteFetcher.data && (inviteFetcher.data as ActionResponse).ok)
      setInviteOpen(false);
  }, [inviteFetcher.data]);
  useEffect(() => {
    const response = repositoryFetcher.data as ActionResponse | undefined;
    if (response?.ok && response.intent === "configure_airtable")
      setAirtableOpen(false);
    if (response?.ok && response.intent === "confirm_repository_migration")
      setMigrationOpen(false);
  }, [repositoryFetcher.data]);

  const orderedRooms = useMemo(
    () => rooms.map((room, position) => ({ ...room, position })),
    [rooms],
  );
  const orderedTracks = useMemo(
    () => tracks.map((track, position) => ({ ...track, position })),
    [tracks],
  );
  const orderedSessionFormats = useMemo(
    () => sessionFormats.map((format, position) => ({ ...format, position })),
    [sessionFormats],
  );
  const inviteData = inviteFetcher.data as ActionResponse | undefined;
  const repositoryData = repositoryFetcher.data as ActionResponse | undefined;

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
        resources: [],
        position: current.length,
      },
    ]);
    setNewRoomName("");
    setNewRoomCapacity("100");
    setAddRoomOpen(false);
  }

  function clearRemovedRecordFocus(kind: "room" | "track", id: string) {
    if (focusedRecordKind !== kind || focusedRecordId !== id) return;
    void navigate("/admin/event", {
      replace: true,
      preventScrollReset: true,
    });
  }

  function revokeAdministrator(
    membershipId: string,
    name: string,
    scope: "event" | "organisation",
  ) {
    const impact =
      scope === "organisation"
        ? "every event in this organisation"
        : "this event";
    confirm(
      {
        title: "Revoke administrator access?",
        description: `${name} immediately loses administrator access to ${impact}. Nothing they created is removed, and they can be invited again later.`,
        records: [name],
        confirmLabel: "Revoke access",
      },
      () => {
        void inviteFetcher.submit(
          { _intent: "revoke_administrator", membershipId },
          { method: "post" },
        );
      },
    );
  }

  return (
    <>
      {dialog}
      <Form method="post">
        <input type="hidden" name="_intent" value="save" />
        <input type="hidden" name="revision" value={event.revision} />
        <input
          type="hidden"
          name="rooms"
          value={JSON.stringify(orderedRooms)}
        />
        <input
          type="hidden"
          name="tracks"
          value={JSON.stringify(orderedTracks)}
        />
        <input
          type="hidden"
          name="sessionFormats"
          value={JSON.stringify(orderedSessionFormats)}
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

        {incompleteEvents.length ? (
          <section
            className="card pad mb"
            aria-labelledby="incomplete-events-title"
          >
            <div className="card-title">
              <h2 id="incomplete-events-title">Incomplete events</h2>
              <span className="status warning">Recovery required</span>
            </div>
            <p className="help">
              These Airtable events are isolated from ordinary event access
              until provisioning succeeds or an organisation administrator
              explicitly chooses another recovery outcome.
            </p>
            <div className="stack-list mt">
              {incompleteEvents.map((incompleteEvent) => (
                <div className="validation-item" key={incompleteEvent.id}>
                  <div>
                    <strong>{incompleteEvent.name}</strong>
                    <div className="help">
                      {incompleteEvent.activationStatus.replaceAll("_", " ")}
                      {incompleteEvent.operationStatus
                        ? ` · ${incompleteEvent.operationStatus}`
                        : ""}
                    </div>
                    {incompleteEvent.lastError ? (
                      <div className="help">{incompleteEvent.lastError}</div>
                    ) : null}
                  </div>
                  <Link
                    className="btn small right"
                    to={`/admin/events/${encodeURIComponent(incompleteEvent.id)}/repository-recovery`}
                  >
                    Recover {incompleteEvent.name}
                  </Link>
                </div>
              ))}
            </div>
          </section>
        ) : null}

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
        {repositoryData &&
        repositoryData.intent !== "preview_repository_migration" ? (
          <div
            className={`card pad mb validation-item ${repositoryData.ok ? "ok" : "error"}`}
            role={repositoryData.ok ? "status" : "alert"}
          >
            <strong>{repositoryData.ok ? "✓" : "△"}</strong>
            <span>{repositoryData.message}</span>
          </div>
        ) : null}

        <div className="grid grid-2">
          <EventIdentityPanels event={event} actionData={actionData} />
          <EventRoomsPanel
            rooms={rooms}
            setRooms={setRooms}
            actionData={actionData}
            onAdd={() => setAddRoomOpen(true)}
            onRemove={(roomId) => clearRemovedRecordFocus("room", roomId)}
            focusedRoomId={
              focusedRecordKind === "room" ? focusedRecordId : null
            }
          />
          <EventScheduleConfigurationPanels
            tracks={tracks}
            setTracks={setTracks}
            sessionFormats={sessionFormats}
            setSessionFormats={setSessionFormats}
            actionData={actionData}
            onRemove={(trackId) => clearRemovedRecordFocus("track", trackId)}
            focusedTrackId={
              focusedRecordKind === "track" ? focusedRecordId : null
            }
          />
          <EventFilePolicyPanel event={event} actionData={actionData} />
          <EventAccessPanels
            event={event}
            onInvite={() => setInviteOpen(true)}
            onRevoke={revokeAdministrator}
            onConfigureAirtable={() => setAirtableOpen(true)}
            onMigrateRepository={() => setMigrationOpen(true)}
            canManageFileRetention={canManageFileRetention}
            canManageAdministrators={canManageOrganisationAdministrators}
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
          title="Invite administrator"
          onClose={() => setInviteOpen(false)}
        >
          <inviteFetcher.Form method="post">
            <input type="hidden" name="_intent" value="invite" />
            {canManageOrganisationAdministrators ? (
              <label className="label">
                Permission scope
                <select className="select" name="scope" defaultValue="event">
                  <option value="event">Current event only</option>
                  <option value="organisation">
                    Every event in this organisation
                  </option>
                </select>
              </label>
            ) : (
              <input type="hidden" name="scope" value="event" />
            )}
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

      {airtableOpen ? (
        <Dialog
          title="Configure Airtable event repository"
          onClose={() => setAirtableOpen(false)}
        >
          <repositoryFetcher.Form method="post">
            <input type="hidden" name="_intent" value="configure_airtable" />
            <p className="help">
              The token must be able to read and write records and read and
              change base schema. Managed schema v3 validates or provisions 36
              tables covering event setup, forms, submissions, evaluations,
              sessions, schedules, tasks and the versioned published programme.
              The credential is encrypted only after every managed table passes
              validation.
            </p>
            <label className="label mt">
              Airtable base ID
              <input
                className="field"
                name="baseId"
                required
                defaultValue={event.repositoryConnection?.baseId ?? ""}
                placeholder="app…"
                autoComplete="off"
              />
            </label>
            <label className="label mt">
              Managed table name
              <input
                className="field"
                name="tableName"
                required
                defaultValue={
                  event.repositoryConnection?.tableName ?? "Program Cue Rooms"
                }
                maxLength={100}
              />
            </label>
            <label className="label mt">
              Personal access token
              <input
                className="field"
                name="personalAccessToken"
                type="password"
                required
                autoComplete="new-password"
              />
            </label>
            {repositoryData?.intent === "configure_airtable" ? (
              <p
                className={`validation-item ${repositoryData.ok ? "ok" : "error"}`}
                role={repositoryData.ok ? "status" : "alert"}
              >
                {repositoryData.message}
              </p>
            ) : null}
            <div className="modal-foot" style={{ margin: "18px -18px -18px" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setAirtableOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={repositoryFetcher.state !== "idle"}
              >
                {repositoryFetcher.state === "submitting"
                  ? "Validating…"
                  : "Validate and save"}
              </button>
            </div>
          </repositoryFetcher.Form>
        </Dialog>
      ) : null}

      {migrationOpen ? (
        <Dialog
          title={`Migrate event-data authority to ${event.repositoryProvider === "d1" ? "Airtable" : "D1"}`}
          onClose={() => setMigrationOpen(false)}
        >
          {repositoryData?.intent === "preview_repository_migration" &&
          repositoryData.preview ? (
            <>
              <p className="help">
                This preview expires at{" "}
                {new Date(
                  repositoryData.preview.expiresAt * 1_000,
                ).toLocaleTimeString()}
                . Confirmation rechecks Airtable and the D1 event revision.
                {repositoryData.preview.counts.noop > 0
                  ? ` ${repositoryData.preview.counts.noop} unchanged managed records are omitted from the table.`
                  : ""}
              </p>
              <div
                className="table-wrap mt"
                tabIndex={0}
                aria-label="Airtable repository migration changes"
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col">Record</th>
                      <th scope="col">Action</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repositoryData.preview.items.map((item) => (
                      <tr key={`${item.entityType}:${item.entityId}`}>
                        <td>{item.entityType.replaceAll("_", " ")}</td>
                        <td>{item.label}</td>
                        <td>{item.action}</td>
                        <td>{item.beforeLabel}</td>
                        <td>{item.afterLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <repositoryFetcher.Form method="post">
                <input
                  type="hidden"
                  name="_intent"
                  value="confirm_repository_migration"
                />
                <input
                  type="hidden"
                  name="previewId"
                  value={repositoryData.preview.previewId}
                />
                <div
                  className="modal-foot"
                  style={{ margin: "18px -18px -18px" }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMigrationOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={repositoryFetcher.state !== "idle"}
                  >
                    {repositoryFetcher.state === "submitting"
                      ? "Reconciling…"
                      : "Confirm authority switch"}
                  </button>
                </div>
              </repositoryFetcher.Form>
            </>
          ) : (
            <repositoryFetcher.Form method="post">
              <input
                type="hidden"
                name="_intent"
                value="preview_repository_migration"
              />
              <input
                type="hidden"
                name="targetProvider"
                value={event.repositoryProvider === "d1" ? "airtable" : "d1"}
              />
              <p>
                Program Cue will read both repositories, show the exact managed
                event-data creates, updates and retirements across the full
                authoritative scope, and make no authority change until you
                confirm that diff.
              </p>
              {event.repositoryProvider === "airtable" ? (
                <p className="help">
                  Moving back to D1 is allowed only when its synchronized
                  projection still matches Airtable. Any Airtable-only edit or
                  schema divergence blocks confirmation; it is never silently
                  discarded.
                </p>
              ) : null}
              {repositoryData?.intent === "preview_repository_migration" &&
              !repositoryData.ok ? (
                <p className="validation-item error" role="alert">
                  {repositoryData.message}
                </p>
              ) : null}
              <div
                className="modal-foot"
                style={{ margin: "18px -18px -18px" }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() => setMigrationOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={repositoryFetcher.state !== "idle"}
                >
                  {repositoryFetcher.state === "submitting"
                    ? "Comparing…"
                    : "Create migration preview"}
                </button>
              </div>
            </repositoryFetcher.Form>
          )}
          {repositoryData?.intent === "confirm_repository_migration" &&
          !repositoryData.ok ? (
            <p className="validation-item error" role="alert">
              {repositoryData.message}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}

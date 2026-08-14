import { CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useBeforeUnload,
  useBlocker,
  useFetcher,
  useNavigate,
  useNavigation,
} from "react-router";

import { Dialog } from "~/components/dialog";
import {
  EventAccessPanels,
  EventFilePolicyPanel,
  EventIdentityPanels,
  EventRepositoryPanel,
  EventRoomsPanel,
} from "~/components/event-setup-panels";
import { EventScheduleConfigurationPanels } from "~/components/event-schedule-configuration-panel";
import {
  AdminPageSection,
  AdminPageSectionNavigation,
} from "~/components/ui/admin-page-sections";
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import type { EventSetup } from "~/modules/events/event-repository.server";
import type { IncompleteEventSummary } from "~/modules/events/event-repository-recovery.server";
import type { action, ActionResponse } from "~/routes/event-setup";

const eventSetupBaselineExcludedFields = new Set([
  "_intent",
  "revision",
  "rooms",
  "tracks",
  "sessionFormats",
]);

function eventSetupFieldValues(form: HTMLFormElement) {
  const fields = new Map<string, string[]>();
  for (const [name, value] of new FormData(form)) {
    if (eventSetupBaselineExcludedFields.has(name)) continue;
    if (typeof value !== "string") {
      throw new Error(
        `Event Setup field ${name} unexpectedly contains a file. Files require an explicit dirty-state comparison.`,
      );
    }
    const values = fields.get(name);
    if (values) values.push(value);
    else fields.set(name, [value]);
  }
  return fields;
}

/* The count is what the operator is shown, so it counts fields rather than
   keystrokes. An unchecked box leaves the form data entirely, which is why a
   name present on one side only is a change and not an absence. */
function countChangedFields(
  saved: ReadonlyMap<string, string[]>,
  current: ReadonlyMap<string, string[]>,
) {
  let changed = 0;
  for (const name of new Set([...saved.keys(), ...current.keys()])) {
    const savedValues = saved.get(name);
    const currentValues = current.get(name);
    if (
      !savedValues ||
      !currentValues ||
      savedValues.length !== currentValues.length ||
      savedValues.some((value, index) => value !== currentValues[index])
    )
      changed += 1;
  }
  return changed;
}

/* Rooms, tracks and formats keep their loaded order, so an index-wise
   comparison sees an edited record as one change and an added or removed one
   as one more. */
function countChangedRecords(
  saved: readonly unknown[],
  current: readonly unknown[],
) {
  let changed = Math.abs(saved.length - current.length);
  for (let index = 0; index < Math.min(saved.length, current.length); index++) {
    if (JSON.stringify(saved[index]) !== JSON.stringify(current[index]))
      changed += 1;
  }
  return changed;
}

/* One result banner, three sources. The mark is a real icon at one optical
   size: the "△" it replaces is a hollow geometric shape, not a warning
   triangle, and it was carrying the failure state of a save. */
function ResultNotice({ response }: { response: ActionResponse }) {
  return (
    <div
      className={`card pad mb validation-item event-setup-notice ${response.ok ? "ok" : "error"}`}
      role={response.ok ? "status" : "alert"}
    >
      {response.ok ? (
        <CircleCheck aria-hidden size={18} />
      ) : (
        <CircleAlert aria-hidden size={18} />
      )}
      <span>{response.message}</span>
    </div>
  );
}

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
  const formRef = useRef<HTMLFormElement | null>(null);
  const savedFieldValuesRef = useRef<ReadonlyMap<string, string[]> | null>(
    null,
  );
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
  const [recordDraftValues, setRecordDraftValues] = useState<
    Readonly<Record<string, string>>
  >({});
  // Discarding has to reach the drafts the record panels keep in their own
  // state — a new resource, track or format that was typed but never added.
  // Remounting them is the only reset that covers those too.
  const [panelGeneration, setPanelGeneration] = useState(0);
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

  // Rooms, tracks and formats live in client state and reach the server only
  // through the serialised hidden inputs above, so leaving the page discarded
  // them silently. The named fields are uncontrolled, so each form-level input
  // event compares their current values with the exact loaded baseline.
  const [namedFieldChangeCount, setNamedFieldChangeCount] = useState(0);
  const savedRecords = useMemo(
    () => [event.rooms, event.tracks, event.sessionFormats] as const,
    [event.revision],
  );
  const recordChangeCount =
    countChangedRecords(savedRecords[0], orderedRooms) +
    countChangedRecords(savedRecords[1], orderedTracks) +
    countChangedRecords(savedRecords[2], orderedSessionFormats);
  const newRoomDraftPresent = Boolean(
    newRoomName.trim() || newRoomCapacity !== "100",
  );
  const pendingRecordDraftPresent =
    Object.values(recordDraftValues).some((value) => value.trim()) ||
    newRoomDraftPresent;
  const changeCount = namedFieldChangeCount + recordChangeCount;
  const hasUnsavedChanges = changeCount > 0 || pendingRecordDraftPresent;

  const captureEventSetupForm = useCallback((form: HTMLFormElement | null) => {
    formRef.current = form;
    if (form && savedFieldValuesRef.current === null) {
      savedFieldValuesRef.current = eventSetupFieldValues(form);
    }
  }, []);

  const updateNamedFieldDirtyState = useCallback((form: HTMLFormElement) => {
    const savedValues = savedFieldValuesRef.current;
    if (savedValues === null) {
      throw new Error(
        "The Event Setup form received input before its saved baseline was captured.",
      );
    }
    setNamedFieldChangeCount(
      countChangedFields(savedValues, eventSetupFieldValues(form)),
    );
  }, []);

  const handleRecordDraftStateChange = useCallback(
    (draftKey: string, value: string) =>
      setRecordDraftValues((current) => ({ ...current, [draftKey]: value })),
    [],
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    savedFieldValuesRef.current = eventSetupFieldValues(form);
    setNamedFieldChangeCount(0);
  }, [event.revision]);

  useBeforeUnload(
    useCallback(
      (unloadEvent: BeforeUnloadEvent) => {
        if (!hasUnsavedChanges) return;
        unloadEvent.preventDefault();
      },
      [hasUnsavedChanges],
    ),
  );

  // Saving posts to this same path, and the focus-clearing replace after a
  // record is removed stays here too, so comparing pathnames lets both through.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname,
  );

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

  function cancelAddRoom() {
    setNewRoomName("");
    setNewRoomCapacity("100");
    setAddRoomOpen(false);
  }

  // The repository panel and the leave-confirmation both tell the operator to
  // "save or discard", and until now discarding meant leaving the page.
  function discardChanges() {
    const form = formRef.current;
    if (!form) return;
    form.reset();
    setRooms(event.rooms);
    setTracks(event.tracks);
    setSessionFormats(event.sessionFormats);
    setRecordDraftValues({});
    setNewRoomName("");
    setNewRoomCapacity("100");
    setPanelGeneration((generation) => generation + 1);
    // Controlled fields such as Brand accent retain their old DOM value until
    // the remount above commits, so a synchronous form comparison sees a
    // change that has already been discarded.
    setNamedFieldChangeCount(0);
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
      {blocker.state === "blocked" ? (
        <ConfirmDialog
          title="Leave without saving?"
          description="This event has changes that have not been saved. Leaving discards them."
          confirmLabel="Leave and discard"
          cancelLabel="Stay on this page"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
      <Form
        ref={captureEventSetupForm}
        method="post"
        onInput={(inputEvent) => {
          updateNamedFieldDirtyState(inputEvent.currentTarget);
          const input = inputEvent.target as HTMLInputElement;
          const draftKey = input.dataset.eventRecordDraft;
          if (draftKey) handleRecordDraftStateChange(draftKey, input.value);
        }}
        onSubmit={(submitEvent) => {
          if (pendingRecordDraftPresent) submitEvent.preventDefault();
        }}
      >
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

        {actionData ? <ResultNotice response={actionData} /> : null}
        {inviteData ? <ResultNotice response={inviteData} /> : null}
        {repositoryData &&
        repositoryData.intent !== "preview_repository_migration" ? (
          <ResultNotice response={repositoryData} />
        ) : null}

        <AdminPageSectionNavigation
          label="Event Setup sections"
          links={[
            { id: "event-setup-identity", label: "Identity" },
            { id: "event-setup-structure", label: "Programme structure" },
            { id: "event-setup-access", label: "Access and roles" },
            { id: "event-setup-data", label: "Data and files" },
          ]}
        />

        {/* Four titled sections rather than one nine-card grid. Panels are
            paired by height as well as by subject: the three record editors are
            full width because they grow without bound, and the fixed-size
            settings cards sit two-up beside a comparable neighbour. A grid row
            is as tall as its tallest card, so mixing the two shapes in one grid
            is what left a 1,096px hole under Event identity.
            Every section stays expanded on phones: the record editors inside
            Programme structure are already disclosures, and nesting a second
            one around them puts a required field somewhere the browser cannot
            focus to report it. */}
        <div className="event-setup-page">
          <AdminPageSection
            id="event-setup-identity"
            label="Identity"
            description="How this event is named internally and how it presents itself to participants and the public."
            defaultExpandedOnMobile
          >
            {/* Full width rather than two-up. The two cards are 336px and
                644px, and a grid row is as tall as its tallest child, so
                pairing them left a ~300px hole under the shorter one. Stacked,
                each card lays its own fields out across the full measure for
                the same total height and no gap. */}
            <div className="grid">
              <EventIdentityPanels
                key={`identity-${panelGeneration}`}
                event={event}
                actionData={actionData}
              />
            </div>
          </AdminPageSection>

          <AdminPageSection
            id="event-setup-structure"
            label="Programme structure"
            description="The rooms, tracks and session formats the schedule builder can draw on."
            defaultExpandedOnMobile
          >
            <div className="grid">
              <EventRoomsPanel
                key={`rooms-${panelGeneration}`}
                rooms={rooms}
                setRooms={setRooms}
                actionData={actionData}
                onAdd={() => setAddRoomOpen(true)}
                onRemove={(roomId) => clearRemovedRecordFocus("room", roomId)}
                focusedRoomId={
                  focusedRecordKind === "room" ? focusedRecordId : null
                }
                onDraftStateChange={handleRecordDraftStateChange}
              />
              <EventScheduleConfigurationPanels
                key={`schedule-${panelGeneration}`}
                tracks={tracks}
                setTracks={setTracks}
                sessionFormats={sessionFormats}
                setSessionFormats={setSessionFormats}
                actionData={actionData}
                onRemove={(trackId) =>
                  clearRemovedRecordFocus("track", trackId)
                }
                focusedTrackId={
                  focusedRecordKind === "track" ? focusedRecordId : null
                }
                onDraftStateChange={handleRecordDraftStateChange}
              />
            </div>
          </AdminPageSection>

          <AdminPageSection
            id="event-setup-access"
            label="Access and roles"
            description="Who can administer this event, and how applicants reach the submission form."
            defaultExpandedOnMobile
          >
            <div className="grid grid-2">
              <EventAccessPanels
                event={event}
                onInvite={() => setInviteOpen(true)}
                onRevoke={revokeAdministrator}
                canManageAdministrators={canManageOrganisationAdministrators}
              />
            </div>
          </AdminPageSection>

          <AdminPageSection
            id="event-setup-data"
            label="Data and files"
            description="Upload limits, where event data is authoritative, and how long it is kept."
            defaultExpandedOnMobile
          >
            <div className="grid grid-2">
              <EventFilePolicyPanel event={event} actionData={actionData} />
              <EventRepositoryPanel
                event={event}
                onConfigureAirtable={() => {
                  if (!hasUnsavedChanges) setAirtableOpen(true);
                }}
                onMigrateRepository={() => {
                  if (!hasUnsavedChanges) setMigrationOpen(true);
                }}
                canManageFileRetention={canManageFileRetention}
                hasUnsavedChanges={hasUnsavedChanges}
              />
            </div>
          </AdminPageSection>
        </div>

        <div
          className="event-setup-actions"
          data-dirty={hasUnsavedChanges ? "true" : undefined}
        >
          {pendingRecordDraftPresent ? (
            <p
              className="event-setup-state is-blocked"
              id="event-setup-pending-record-help"
            >
              <CircleAlert aria-hidden size={16} />
              Add or clear the unfinished room, resource, track or format before
              saving.
            </p>
          ) : changeCount ? (
            <p className="event-setup-state is-dirty">
              <CircleAlert aria-hidden size={16} />
              {changeCount} unsaved {changeCount === 1 ? "change" : "changes"}
            </p>
          ) : (
            <p className="event-setup-state">
              <CircleCheck aria-hidden size={16} />
              Saved
            </p>
          )}
          <button
            type="button"
            className="btn"
            onClick={discardChanges}
            disabled={!hasUnsavedChanges || saving}
          >
            Discard changes
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={saving || pendingRecordDraftPresent}
            aria-describedby={
              pendingRecordDraftPresent
                ? "event-setup-pending-record-help"
                : undefined
            }
          >
            {saving ? "Saving…" : "Save event"}
          </button>
        </div>
      </Form>

      {addRoomOpen ? (
        <Dialog
          title="Add room"
          onClose={cancelAddRoom}
          footer={
            <>
              <button type="button" className="btn" onClick={cancelAddRoom}>
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
            <div className="modal-foot event-setup-modal-foot">
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
            <div className="modal-foot event-setup-modal-foot">
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
                disabled={
                  repositoryFetcher.state !== "idle" || hasUnsavedChanges
                }
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
          title={`Hand event data over to ${event.repositoryProvider === "d1" ? "Airtable" : "Program Cue"}`}
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
                . Confirming rechecks both Airtable and this event first.
                {repositoryData.preview.counts.noop > 0
                  ? ` ${repositoryData.preview.counts.noop} unchanged records are left out of the table below.`
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
                <div className="modal-foot event-setup-modal-foot">
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
                    disabled={
                      repositoryFetcher.state !== "idle" || hasUnsavedChanges
                    }
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
                Program Cue reads both systems, shows you every record it would
                create, update or retire, and changes nothing until you confirm
                that list.
              </p>
              {event.repositoryProvider === "airtable" ? (
                <p className="help">
                  Moving back to Program Cue is only possible while its copy
                  still matches Airtable. Any edit made only in Airtable blocks
                  the handover rather than being silently discarded.
                </p>
              ) : null}
              {repositoryData?.intent === "preview_repository_migration" &&
              !repositoryData.ok ? (
                <p className="validation-item error" role="alert">
                  {repositoryData.message}
                </p>
              ) : null}
              <div className="modal-foot event-setup-modal-foot">
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
                  disabled={
                    repositoryFetcher.state !== "idle" || hasUnsavedChanges
                  }
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

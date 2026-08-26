import type { useFetcher } from "react-router";
import { Dialog } from "~/components/dialog";
import { Button } from "~/components/ui/button";
import type { EventSetup } from "~/modules/events/event-repository.server";
import type { ActionResponse, action } from "~/routes/event-setup";

export type EventSetupFetcher = ReturnType<typeof useFetcher<typeof action>>;

export function AddRoomDialog({
  open,
  newRoomName,
  newRoomCapacity,
  setNewRoomName,
  setNewRoomCapacity,
  cancel,
  add,
  fetcher,
  actionData,
  hasUnsavedChanges,
}: {
  open: boolean;
  newRoomName: string;
  newRoomCapacity: string;
  setNewRoomName(value: string): void;
  setNewRoomCapacity(value: string): void;
  cancel(): void;
  add(): void;
  fetcher: EventSetupFetcher;
  actionData?: ActionResponse;
  hasUnsavedChanges: boolean;
}) {
  return (
    <>
      {open ? (
        <Dialog
          title="Add room"
          onClose={cancel}
          footer={
            <>
              <Button type="button" onClick={cancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="event-add-room-form"
                variant="primary"
                disabled={
                  fetcher.state !== "idle" ||
                  !newRoomName.trim() ||
                  !Number.isInteger(Number(newRoomCapacity)) ||
                  Number(newRoomCapacity) < 1
                }
              >
                {fetcher.state === "submitting" ? "Adding…" : "Add room"}
              </Button>
            </>
          }
        >
          <form
            id="event-add-room-form"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              add();
            }}
          >
            <label className="label">
              Room name
              <input
                className="field"
                autoFocus
                placeholder="Room 304"
                value={newRoomName}
                aria-invalid={Boolean(actionData?.errors?.name?.length)}
                onChange={(inputEvent) =>
                  setNewRoomName(inputEvent.target.value)
                }
              />
              {actionData?.errors?.name?.[0] ? (
                <span className="pc-field-error">
                  {actionData.errors.name[0]}
                </span>
              ) : null}
            </label>
            <label className="label mt">
              Capacity
              <input
                className="field"
                type="number"
                min={1}
                value={newRoomCapacity}
                aria-invalid={Boolean(actionData?.errors?.capacity?.length)}
                onChange={(inputEvent) =>
                  setNewRoomCapacity(inputEvent.target.value)
                }
              />
              {actionData?.errors?.capacity?.[0] ? (
                <span className="pc-field-error">
                  {actionData.errors.capacity[0]}
                </span>
              ) : null}
              {actionData && !actionData.ok && !actionData.errors ? (
                <span className="pc-field-error">{actionData.message}</span>
              ) : null}
            </label>
            {hasUnsavedChanges ? (
              <p className="help mt">
                Save or discard the current Event Setup changes before adding a
                room. The server refreshes the canonical room list after this
                command.
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function AdministratorInvitationDialog({
  open,
  setOpen,
  fetcher,
  data,
  canManageOrganisationAdministrators,
}: {
  open: boolean;
  setOpen(value: boolean): void;
  fetcher: EventSetupFetcher;
  data: ActionResponse | undefined;
  canManageOrganisationAdministrators: boolean;
}) {
  return (
    <>
      {open ? (
        <Dialog title="Invite administrator" onClose={() => setOpen(false)}>
          <fetcher.Form method="post">
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
            {data && !data.ok ? (
              <p className="validation-item error">{data.message}</p>
            ) : null}
            <div className="modal-foot event-setup-modal-foot">
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={fetcher.state !== "idle"}
              >
                {fetcher.state === "submitting"
                  ? "Creating…"
                  : "Create invitation"}
              </Button>
            </div>
          </fetcher.Form>
        </Dialog>
      ) : null}
    </>
  );
}

export function EventRepositoryDialogs({
  airtableOpen,
  setAirtableOpen,
  migrationOpen,
  setMigrationOpen,
  repositoryFetcher,
  repositoryData,
  event,
  hasUnsavedChanges,
}: {
  airtableOpen: boolean;
  setAirtableOpen(value: boolean): void;
  migrationOpen: boolean;
  setMigrationOpen(value: boolean): void;
  repositoryFetcher: EventSetupFetcher;
  repositoryData: ActionResponse | undefined;
  event: EventSetup;
  hasUnsavedChanges: boolean;
}) {
  return (
    <>
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
              <Button type="button" onClick={() => setAirtableOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  repositoryFetcher.state !== "idle" || hasUnsavedChanges
                }
              >
                {repositoryFetcher.state === "submitting"
                  ? "Validating…"
                  : "Validate and save"}
              </Button>
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
              <section
                className="table-wrap mt"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
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
              </section>
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
                  <Button type="button" onClick={() => setMigrationOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      repositoryFetcher.state !== "idle" || hasUnsavedChanges
                    }
                  >
                    {repositoryFetcher.state === "submitting"
                      ? "Reconciling…"
                      : "Confirm authority switch"}
                  </Button>
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
                <Button type="button" onClick={() => setMigrationOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    repositoryFetcher.state !== "idle" || hasUnsavedChanges
                  }
                >
                  {repositoryFetcher.state === "submitting"
                    ? "Comparing…"
                    : "Create migration preview"}
                </Button>
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

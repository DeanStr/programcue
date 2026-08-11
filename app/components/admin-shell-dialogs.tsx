import { CheckCircle2, Save, UserRound } from "lucide-react";
import { Form, Link } from "react-router";

import type { SavedViewArea } from "~/platform/operations/saved-view-service.server";
import { Dialog } from "./dialog";
import type {
  AdminShellCommandPalette,
  AdminShellDialog,
  AdminShellEvent,
  AdminShellEventOption,
  AdminShellNotification,
  AdminShellViewer,
} from "./admin-shell";

export function AdminAuxiliaryDialogs({
  dialog,
  viewArea,
  closeDialog,
  currentHref,
  commandPalette,
  selectCommand,
  eventOptions,
  event,
  viewer,
  notifications,
}: {
  dialog: AdminShellDialog;
  viewArea: SavedViewArea | null;
  closeDialog: () => void;
  currentHref: string;
  commandPalette: AdminShellCommandPalette;
  selectCommand: (href: string) => void;
  eventOptions: ReadonlyArray<AdminShellEventOption>;
  event: AdminShellEvent;
  viewer: AdminShellViewer;
  notifications: ReadonlyArray<AdminShellNotification>;
}) {
  return (
    <>
      {dialog === "views" && viewArea ? (
        <Dialog
          title="Saved views"
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          <Form method="post" action="/admin/views" className="stack">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="area" value={viewArea} />
            <input type="hidden" name="href" value={currentHref} />
            <input type="hidden" name="returnTo" value={currentHref} />
            <label className="label">
              View name
              <input
                className="field"
                name="name"
                required
                minLength={2}
                maxLength={80}
                autoFocus
              />
            </label>
            <label className="label">
              Visibility
              <select
                className="select"
                name="visibility"
                defaultValue="private"
              >
                <option value="private">Only me</option>
                <option value="event">Event administrators</option>
              </select>
            </label>
            <p className="help">
              This saves the current filters and sorting encoded in the page
              URL.
            </p>
            <button className="btn primary" type="submit">
              <Save aria-hidden size={14} /> Save view
            </button>
          </Form>
          {commandPalette.savedViews.filter((view) => view.area === viewArea)
            .length ? (
            <>
              <div className="divider" />
              <h3>{viewArea} views</h3>
              <div className="stack">
                {commandPalette.savedViews
                  .filter((view) => view.area === viewArea)
                  .map((view) => (
                    <div className="card pad" key={view.id}>
                      <strong>{view.name}</strong>
                      <p className="subtle">
                        {view.visibility === "event"
                          ? `Shared by ${view.ownerName}`
                          : "Private"}
                      </p>
                      <div className="page-actions">
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => selectCommand(view.href)}
                        >
                          Open
                        </button>
                        {view.canDelete ? (
                          <Form method="post" action="/admin/views">
                            <input type="hidden" name="intent" value="delete" />
                            <input
                              type="hidden"
                              name="viewId"
                              value={view.id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={currentHref}
                            />
                            <button className="btn small danger" type="submit">
                              Delete
                            </button>
                          </Form>
                        ) : null}
                      </div>
                    </div>
                  ))}
              </div>
            </>
          ) : null}
        </Dialog>
      ) : null}

      {dialog === "shortcuts" ? (
        <Dialog
          title="Keyboard shortcuts"
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          <dl className="shortcut-list">
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> + <kbd>K</kbd>
              </dt>
              <dd>Search records and run commands</dd>
            </div>
            <div>
              <dt>
                <kbd>?</kbd>
              </dt>
              <dd>Open this shortcut reference</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Close the active dialog or command palette</dd>
            </div>
            <div>
              <dt>
                <kbd>Tab</kbd> / <kbd>↑</kbd> / <kbd>↓</kbd>
              </dt>
              <dd>Move through available commands</dd>
            </div>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Open the highlighted command</dd>
            </div>
          </dl>
        </Dialog>
      ) : null}

      {dialog === "event" ? (
        <Dialog
          title="Current event"
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          <div className="stack">
            {eventOptions.map((option) => (
              <Form
                method="post"
                action="/events/select"
                reloadDocument
                className={`card pad event-switcher-option${
                  option.eventId === event.id ? " is-current" : ""
                }`}
                key={option.eventId}
              >
                <input type="hidden" name="eventId" value={option.eventId} />
                <input type="hidden" name="returnTo" value={currentHref} />
                <div className="card-title">
                  <div>
                    <strong>{option.eventName}</strong>
                    <p className="subtle">
                      {option.organisationName} ·{" "}
                      {option.invitationPending
                        ? `${option.role.replaceAll("_", " ")} invitation pending`
                        : option.role.replaceAll("_", " ")}
                      {!option.invitationPending && option.pendingInvitationRole
                        ? ` · ${option.pendingInvitationRole.replaceAll("_", " ")} invitation pending`
                        : ""}
                    </p>
                  </div>
                  {option.eventId === event.id ? (
                    <span className="status success">Current</span>
                  ) : null}
                </div>
                {option.eventId !== event.id || option.pendingInvitationRole ? (
                  <button className="btn small" type="submit">
                    {option.pendingInvitationRole
                      ? `Accept ${option.pendingInvitationRole.replaceAll("_", " ")} invitation${option.eventId === event.id ? "" : " and switch event"}`
                      : "Switch event"}
                  </button>
                ) : null}
              </Form>
            ))}
          </div>
          {viewer.role !== "committee_chair" ? (
            <>
              <div className="divider" />
              <div className="grid grid-2">
                <Link
                  className="card pad"
                  to="/admin/event"
                  onClick={closeDialog}
                >
                  <strong>Event Setup</strong>
                  <p className="subtle">
                    Edit the current event configuration.
                  </p>
                </Link>
                {viewer.canCreateEvents ? (
                  <Link
                    className="card pad"
                    to="/admin/events/clone"
                    onClick={closeDialog}
                  >
                    <strong>Clone event</strong>
                    <p className="subtle">
                      Create a clean event from these templates.
                    </p>
                  </Link>
                ) : null}
              </div>
            </>
          ) : null}
        </Dialog>
      ) : null}

      {dialog === "new" ? (
        <Dialog
          title="Create"
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          <div className="grid grid-2">
            <Link
              className="card pad"
              to="/admin/submissions"
              onClick={closeDialog}
            >
              <strong>Submission</strong>
              <p className="subtle">Add a direct programme proposal.</p>
            </Link>
            <Link className="card pad" to="/admin/tasks" onClick={closeDialog}>
              <strong>Task</strong>
              <p className="subtle">Create readiness work.</p>
            </Link>
          </div>
        </Dialog>
      ) : null}

      {dialog === "notifications" ? (
        <Dialog
          title="Notifications"
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          {notifications.length ? (
            <div className="stack">
              {notifications.map((notification) => (
                <Link
                  className="card pad"
                  to={notification.href}
                  onClick={closeDialog}
                  key={notification.label}
                >
                  <span className={`status ${notification.severity}`}>
                    {notification.count}
                  </span>
                  <strong className="mt">{notification.label}</strong>
                  <p className="subtle">Open the exact affected records.</p>
                </Link>
              ))}
            </div>
          ) : (
            <div className="pc-empty-state">
              <CheckCircle2 aria-hidden className="pc-state-icon" />
              <h2>No operational alerts</h2>
              <p>
                There are no overdue tasks, blocking conflicts or failed
                operations in the current event.
              </p>
            </div>
          )}
        </Dialog>
      ) : null}

      {dialog === "viewer" ? (
        <Dialog
          title={viewer.name}
          onClose={closeDialog}
          footer={
            <button type="button" className="btn" onClick={closeDialog}>
              Close
            </button>
          }
        >
          <p>{viewer.email}</p>
          <span className="status info">
            <UserRound aria-hidden size={13} /> {viewer.role}
          </span>
          {viewer.demo ? (
            <>
              <p className="help">
                Demo identities are enabled only by the demo Worker
                configuration.
              </p>
              <Link className="btn mt" to="/demo" onClick={closeDialog}>
                Evaluator guide and reset
              </Link>
              <div className="divider" />
              <h3>Switch demo surface</h3>
              <div className="grid grid-2">
                {(
                  [
                    "owner",
                    "administrator",
                    "evaluator",
                    "submitter",
                    "speaker",
                  ] as const
                ).map((role) => (
                  <form method="post" action="/demo/role" key={role}>
                    <input type="hidden" name="role" value={role} />
                    <button
                      className="btn"
                      type="submit"
                      style={{ width: "100%", textTransform: "capitalize" }}
                    >
                      {role}
                    </button>
                  </form>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="divider" />
              <Form method="post" action="/sign-out">
                <button className="btn" type="submit">
                  Sign out
                </button>
              </Form>
            </>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

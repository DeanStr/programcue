import {
  Bell,
  Building2,
  CalendarCog,
  CalendarPlus,
  CheckCircle2,
  CircleAlert,
  CopyPlus,
  Files,
  Keyboard,
  ListChecks,
  LogOut,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { Form, Link } from "react-router";

import type { SavedViewArea } from "~/platform/operations/saved-view-service.server";
import type {
  AdminShellCommandPalette,
  AdminShellDialog,
  AdminShellEvent,
  AdminShellEventOption,
  AdminShellNotification,
  AdminShellViewer,
} from "./admin-shell";
import { Dialog } from "./dialog";

/** Initials for an event or a person, from whatever the name actually is. */
function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word[0] ?? ""))
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function readableRole(role: string) {
  return role.replaceAll("_", " ");
}

const VIEW_AREA_LABELS: Record<SavedViewArea, string> = {
  submissions: "Applications",
  evaluations: "Review & selection",
  speakers: "Speakers",
  sessions: "Schedule",
  tasks: "Tasks",
  operations: "Operations",
};

export function suggestedSavedViewName(
  area: SavedViewArea,
  currentHref: string,
) {
  const url = new URL(currentHref, "https://programcue.invalid");
  const parts = [...url.searchParams.entries()]
    .filter(([key, value]) => key !== "page" && value.trim())
    .slice(0, 3)
    .map(([key, value]) => {
      const spacedKey = key.replaceAll(/([a-z])([A-Z])/gu, "$1 $2");
      const readableKey = `${spacedKey[0]?.toLocaleUpperCase() ?? ""}${spacedKey.slice(1).toLocaleLowerCase()}`;
      const readableValue = value.replaceAll(/[_-]+/gu, " ");
      return `${readableKey}: ${readableValue}`;
    });
  const suggestion = parts.length
    ? parts.join(" · ")
    : `${VIEW_AREA_LABELS[area]} view`;
  return suggestion.slice(0, 80).trim();
}

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
  const firstSwitchableEventId = eventOptions.find(
    (option) => option.eventId !== event.id || option.pendingInvitationRole,
  )?.eventId;
  /* Blocking work first. The bell reports a mixed severity list and the order
     it arrived in is not the order it has to be dealt with. */
  const rankedNotifications = [...notifications].sort((left, right) =>
    left.severity === right.severity
      ? right.count - left.count
      : left.severity === "danger"
        ? -1
        : 1,
  );
  const areaViews = viewArea
    ? commandPalette.savedViews.filter((view) => view.area === viewArea)
    : [];

  return (
    <>
      {dialog === "views" && viewArea ? (
        <Dialog
          title="Saved views"
          description={`Keep the current filters and sorting for ${VIEW_AREA_LABELS[viewArea]} as a view you can return to.`}
          icon={<Save aria-hidden size={17} />}
          onClose={closeDialog}
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
                defaultValue={suggestedSavedViewName(viewArea, currentHref)}
                placeholder="Unassigned, newest first"
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
              A view stores what the page URL encodes: the filters, the sort and
              the columns you are looking at now.
            </p>
            <div className="page-actions">
              <button className="btn primary" type="submit">
                <Save aria-hidden size={14} /> Save view
              </button>
            </div>
          </Form>
          {areaViews.length ? (
            <>
              <div className="pc-menu-divider" />
              <span className="pc-menu-label">
                {VIEW_AREA_LABELS[viewArea]} views
              </span>
              <div className="pc-menu">
                {areaViews.map((view) => (
                  <div className="pc-menu-item pc-saved-view" key={view.id}>
                    <span className="pc-menu-icon">
                      <Save aria-hidden size={16} />
                    </span>
                    <span className="pc-menu-copy">
                      <strong>{view.name}</strong>
                      <small>
                        {view.visibility === "event"
                          ? `Shared with event administrators by ${view.ownerName}`
                          : "Private to you"}
                      </small>
                    </span>
                    <span className="pc-menu-meta">
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
                          <input type="hidden" name="viewId" value={view.id} />
                          <input
                            type="hidden"
                            name="returnTo"
                            value={currentHref}
                          />
                          <button
                            className="icon-btn pc-menu-delete"
                            type="submit"
                            aria-label={`Delete the ${view.name} view`}
                          >
                            <Trash2 aria-hidden size={15} />
                          </button>
                        </Form>
                      ) : null}
                    </span>
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
          description="Everything in the administrator chrome is reachable without a pointer."
          icon={<Keyboard aria-hidden size={17} />}
          size="sm"
          onClose={closeDialog}
        >
          <dl className="shortcut-list">
            <div>
              <dt>
                <kbd>⌘</kbd>
                <span aria-hidden>/</span>
                <kbd>Ctrl</kbd>
                <kbd>K</kbd>
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
              <dd>Close the active panel or palette</dd>
            </div>
            <div>
              <dt>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
              </dt>
              <dd>Move through available commands</dd>
            </div>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Open the highlighted command</dd>
            </div>
            <div>
              <dt>
                <kbd>Tab</kbd>
              </dt>
              <dd>Move to the next control</dd>
            </div>
          </dl>
        </Dialog>
      ) : null}

      {dialog === "event" ? (
        <Dialog
          title="Current event"
          description="Every workspace is scoped to the event selected here."
          icon={<CalendarCog aria-hidden size={16} />}
          placement="top-start"
          onClose={closeDialog}
        >
          <div className="pc-menu">
            {eventOptions.map((option) => {
              const isCurrent = option.eventId === event.id;
              const switchable = !isCurrent || option.pendingInvitationRole;
              return (
                <Form
                  method="post"
                  action="/events/select"
                  reloadDocument
                  className="pc-menu-item pc-event-option"
                  aria-current={isCurrent ? "true" : undefined}
                  key={option.eventId}
                >
                  <input type="hidden" name="eventId" value={option.eventId} />
                  <input type="hidden" name="returnTo" value={currentHref} />
                  <span className="pc-event-thumb" aria-hidden>
                    {initialsOf(option.eventName)}
                  </span>
                  <span className="pc-menu-copy">
                    <strong>{option.eventName}</strong>
                    <small>
                      <Building2 aria-hidden size={12} />{" "}
                      {option.organisationName} · {readableRole(option.role)}
                      {option.invitationPending ? " invitation pending" : ""}
                      {!option.invitationPending && option.pendingInvitationRole
                        ? ` · ${readableRole(option.pendingInvitationRole)} invitation pending`
                        : ""}
                    </small>
                  </span>
                  <span className="pc-menu-meta">
                    {isCurrent ? (
                      <span className="status success">Current</span>
                    ) : null}
                    {switchable ? (
                      <button
                        className={`btn small${isCurrent ? "" : " primary"}`}
                        type="submit"
                        /* Without a stated target every shell dialog opens with
                           focus on Close — the one control that undoes opening
                           it. */
                        data-dialog-autofocus={
                          option.eventId === firstSwitchableEventId
                            ? ""
                            : undefined
                        }
                      >
                        {option.pendingInvitationRole
                          ? `Accept ${readableRole(option.pendingInvitationRole)} invitation${isCurrent ? "" : " and switch event"}`
                          : "Switch event"}
                      </button>
                    ) : null}
                  </span>
                </Form>
              );
            })}
          </div>
          {viewer.role !== "committee_chair" ? (
            <>
              <div className="pc-menu-divider" />
              <span className="pc-menu-label">Manage events</span>
              <div className="pc-menu">
                <Link
                  className="pc-menu-item"
                  to="/admin/event"
                  onClick={closeDialog}
                >
                  <span className="pc-menu-icon">
                    <CalendarCog aria-hidden size={16} />
                  </span>
                  <span className="pc-menu-copy">
                    <strong>Event setup</strong>
                    <small>Dates, venue, formats and publication.</small>
                  </span>
                </Link>
                {viewer.canCreateEvents ? (
                  <>
                    <Link
                      className="pc-menu-item"
                      to="/admin/events/new"
                      onClick={closeDialog}
                    >
                      <span className="pc-menu-icon">
                        <CalendarPlus aria-hidden size={16} />
                      </span>
                      <span className="pc-menu-copy">
                        <strong>New event</strong>
                        <small>
                          Program Cue defaults, no templates carried over.
                        </small>
                      </span>
                    </Link>
                    <Link
                      className="pc-menu-item"
                      to="/admin/events/clone"
                      onClick={closeDialog}
                    >
                      <span className="pc-menu-icon">
                        <CopyPlus aria-hidden size={16} />
                      </span>
                      <span className="pc-menu-copy">
                        <strong>Clone this event</strong>
                        <small>
                          Reuse {event.name}’s configuration and templates.
                        </small>
                      </span>
                    </Link>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </Dialog>
      ) : null}

      {/* No description line on this panel or the notifications one: "New work
          in this event" restated the button just pressed, and cost a row to do
          it. A description earns its place only when it carries something the
          trigger did not. */}
      {dialog === "new" ? (
        <Dialog
          title="Create"
          icon={<Plus aria-hidden size={16} />}
          size="sm"
          placement="top-end"
          onClose={closeDialog}
        >
          <div className="pc-menu">
            <Link
              className="pc-menu-item"
              to="/admin/sessions/new?from=global"
              onClick={closeDialog}
              data-dialog-autofocus
            >
              <span className="pc-menu-icon">
                <Files aria-hidden size={16} />
              </span>
              <span className="pc-menu-copy">
                <strong>Direct session</strong>
                <small>
                  Add an invited, sponsored or guaranteed programme session.
                </small>
              </span>
            </Link>
            <Link
              className="pc-menu-item"
              to="/admin/submissions/new"
              onClick={closeDialog}
            >
              <span className="pc-menu-icon">
                <CopyPlus aria-hidden size={16} />
              </span>
              <span className="pc-menu-copy">
                <strong>Application record</strong>
                <small>
                  Enter an application for an accepted event participant.
                </small>
              </span>
            </Link>
            <Link
              className="pc-menu-item"
              to="/admin/tasks"
              onClick={closeDialog}
            >
              <span className="pc-menu-icon">
                <ListChecks aria-hidden size={16} />
              </span>
              <span className="pc-menu-copy">
                <strong>Task</strong>
                <small>Assign readiness work to a person or a session.</small>
              </span>
            </Link>
          </div>
        </Dialog>
      ) : null}

      {dialog === "notifications" ? (
        <Dialog
          title="Notifications"
          icon={<Bell aria-hidden size={16} />}
          size="sm"
          placement="top-end"
          onClose={closeDialog}
        >
          {rankedNotifications.length ? (
            <div className="pc-menu">
              {rankedNotifications.map((notification, index) => (
                <Link
                  className="pc-menu-item"
                  to={notification.href}
                  onClick={closeDialog}
                  key={notification.label}
                  data-dialog-autofocus={index === 0 ? "" : undefined}
                >
                  <span
                    className="pc-menu-icon"
                    data-tone={notification.severity}
                  >
                    {notification.severity === "danger" ? (
                      <TriangleAlert aria-hidden size={15} />
                    ) : (
                      <CircleAlert aria-hidden size={15} />
                    )}
                  </span>
                  <span className="pc-menu-copy">
                    <strong>{notification.label}</strong>
                    <small>{notification.detail}</small>
                  </span>
                  <span className="pc-count" data-tone={notification.severity}>
                    {notification.count}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="pc-empty-state">
              <CheckCircle2 aria-hidden className="pc-state-icon" />
              <h2 className="pc-empty-state-title">No operational alerts</h2>
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
          title="Account"
          icon={<UserRound aria-hidden size={16} />}
          size="sm"
          placement="top-end"
          onClose={closeDialog}
        >
          <div className="pc-identity">
            <span className="pc-identity-avatar" aria-hidden>
              {initialsOf(viewer.name)}
            </span>
            <span className="pc-identity-copy">
              <strong>{viewer.name}</strong>
              <span>{viewer.email}</span>
              <span className="status info">
                <UserRound aria-hidden size={13} /> {readableRole(viewer.role)}
              </span>
            </span>
          </div>
          {viewer.demo ? (
            <p className="help pc-identity-note">
              Demo identities are enabled only by the demo Worker configuration.
            </p>
          ) : null}
          <div className="pc-menu">
            {viewer.demo ? (
              <Link className="pc-menu-item" to="/demo" onClick={closeDialog}>
                <span className="pc-menu-icon">
                  <ListChecks aria-hidden size={16} />
                </span>
                <span className="pc-menu-copy">
                  <strong>Evaluator guide and reset</strong>
                  <small>
                    Walk the demo, or return it to its starting records.
                  </small>
                </span>
              </Link>
            ) : null}
            <Form method="post" action="/sign-out">
              <button className="pc-menu-item pc-menu-signout" type="submit">
                <span className="pc-menu-icon">
                  <LogOut aria-hidden size={16} />
                </span>
                <span className="pc-menu-copy">
                  <strong>
                    {viewer.demo ? "Browse anonymously" : "Sign out"}
                  </strong>
                  <small>
                    {viewer.demo
                      ? "Leave the demo identity and view public surfaces."
                      : "End this session on this device."}
                  </small>
                </span>
              </button>
            </Form>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

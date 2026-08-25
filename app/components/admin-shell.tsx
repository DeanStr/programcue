import {
  Bell,
  ChevronDown,
  ClipboardCopy,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  Link,
  useFetcher,
  useLocation,
  useMatches,
  useNavigate,
  useSubmit,
} from "react-router";
import type {
  CommandRecord,
  RecentCommandRecord,
} from "~/platform/operations/command-palette-service.server";
import type { SavedViewListItem } from "~/platform/operations/saved-view-service.server";
import { AdminCommandDialog } from "./admin-shell-command-dialog";

import { AdminAuxiliaryDialogs } from "./admin-shell-dialogs";
import {
  type AdminAssistantNavigationState,
  type AdminCommandSearchResult,
  type AdminCommandSearchScope,
  type AdminNavigationItem,
  adminCommandMatches,
  adminCommandRecordSelection,
  adminCommandRecordsForKey,
  adminCommandSearchKey,
  adminPageBreadcrumbs,
  adminRecordBreadcrumb,
  canOpenAdminAssistant,
  NAV_ITEMS,
  primaryNavigationChildren,
  primaryNavigationGroups,
  primaryNavigationItemActive,
  primaryNavigationItemExpanded,
  savedViewArea,
} from "./admin-shell-navigation";
import { BrandMark } from "./brand-mark";
import { Dialog } from "./dialog";
import { Button } from "./ui/button";

export {
  type AdminAssistantNavigationState,
  type AdminCommandSearchResult,
  type AdminCommandSearchScope,
  type AdminNavigationItem,
  type AdminRecordBreadcrumb,
  adminAssistantDraft,
  adminAssistantDraftFromNavigationState,
  adminAssistantIntent,
  adminCommandMatches,
  adminCommandRecordSelection,
  adminCommandRecordsForKey,
  adminCommandSearchKey,
  adminPageBreadcrumbs,
  adminRecordBreadcrumb,
  canOpenAdminAssistant,
  NAV_ITEMS,
  primaryNavigationChildren,
  primaryNavigationGroups,
  primaryNavigationItemActive,
  primaryNavigationItemExpanded,
  primaryNavigationSection,
  savedViewArea,
} from "./admin-shell-navigation";

const SIDEBAR_COLLAPSE_COOKIE = "program_cue_sidebar";

function readSidebarCollapsedCookie() {
  return document.cookie
    .split("; ")
    .includes(`${SIDEBAR_COLLAPSE_COOKIE}=collapsed`);
}

function writeSidebarCollapsedCookie(collapsed: boolean) {
  // A cookie rather than local storage so the shell can eventually be rendered
  // at the stored width on the server and skip the restoring frame entirely.
  // biome-ignore lint/suspicious/noDocumentCookie: This non-sensitive preference cookie must work in browsers without the asynchronous Cookie Store API.
  document.cookie = `${SIDEBAR_COLLAPSE_COOKIE}=${
    collapsed ? "collapsed" : "expanded"
  }; path=/; max-age=31536000; samesite=lax`;
}

export type AdminShellDialog =
  | "command"
  | "event"
  | "new"
  | "notifications"
  | "viewer"
  | "views"
  | "shortcuts"
  | null;

export type AdminShellEvent = {
  id: string;
  name: string;
  timezone: string;
  dates: string;
  venue: string;
  city: string;
};

export type AdminShellEventOption = {
  eventId: string;
  eventName: string;
  organisationName: string;
  role: string;
  invitationPending: boolean;
  pendingInvitationRole: string | null;
};

export type AdminShellViewer = {
  name: string;
  email: string;
  role: string;
  demo: boolean;
  canCreateEvents: boolean;
};

export type AdminShellNotification = {
  label: string;
  count: number;
  href: string;
  severity: "danger" | "warning";
  /* What is actually true of this condition. Deriving one sentence from
     severity alone told an operator that overdue tasks block publication,
     which only blocking schedule conflicts do. */
  detail: string;
};

export type AdminShellCommandPalette = {
  savedViews: SavedViewListItem[];
  recentRecords: RecentCommandRecord[];
  organisationSearchAllowed: boolean;
};

type AdminNavigationGroups = ReturnType<typeof primaryNavigationGroups>;
type CopyDeepLinkState = "idle" | "copied" | "unavailable";

function AdminSidebar({
  navigationGroups,
  navigationItems,
  pathname,
  viewer,
  demoRoleLabel,
  collapsed,
  toggleCollapsed,
}: {
  navigationGroups: AdminNavigationGroups;
  navigationItems: ReadonlyArray<AdminNavigationItem>;
  pathname: string;
  viewer: AdminShellViewer;
  demoRoleLabel: string;
  collapsed: boolean;
  toggleCollapsed(): void;
}) {
  const location = { pathname };
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <Link
        className="brand"
        to={
          viewer.role === "committee_chair" ? "/admin/review" : "/admin/command"
        }
        aria-label="Program Cue home"
      >
        <BrandMark />
        <span>Program Cue</span>
      </Link>
      <nav className="nav">
        {navigationGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-group-label">{group.label}</span>
            {group.items.map(([id, Icon, label]) => {
              const expanded = primaryNavigationItemExpanded(
                id,
                location.pathname,
              );
              const children = expanded
                ? primaryNavigationChildren(id, navigationItems)
                : [];
              return (
                <div className="nav-item" key={id}>
                  <Link
                    to={`/admin/${id}`}
                    className={
                      primaryNavigationItemActive(id, location.pathname)
                        ? "active"
                        : undefined
                    }
                    /* Icon-only mode hides the children, so the parent has
                         to answer "which family am I in" on its own or the
                         collapsed rail states no location at all. */
                    data-family-current={
                      expanded &&
                      !primaryNavigationItemActive(id, location.pathname)
                        ? ""
                        : undefined
                    }
                    aria-current={
                      primaryNavigationItemActive(id, location.pathname)
                        ? "page"
                        : undefined
                    }
                    /* The label span is display:none at and below 1024px,
                         which leaves the link with no accessible name at all,
                         and no tooltip for a mouse user either. */
                    aria-label={label}
                    title={label}
                  >
                    <span className="nav-icon">
                      <Icon aria-hidden size={16} strokeWidth={1.8} />
                    </span>
                    <span className="nav-label">{label}</span>
                  </Link>
                  {children.length ? (
                    <div className="nav-child">
                      {children.map(([childId, , childLabel]) => (
                        <Link
                          key={childId}
                          to={`/admin/${childId}`}
                          className={
                            primaryNavigationItemActive(
                              childId,
                              location.pathname,
                            )
                              ? "active"
                              : undefined
                          }
                          aria-current={
                            primaryNavigationItemActive(
                              childId,
                              location.pathname,
                            )
                              ? "page"
                              : undefined
                          }
                        >
                          <span className="nav-label">{childLabel}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {/* Production had a bordered card here stating that an authenticated
              user is authenticated. Only the demo state is worth a line: it
              says the records are disposable. */}
        {viewer.demo ? (
          <Link
            className="sidebar-demo"
            to="/demo"
            title="Open evaluator guide and reset controls"
          >
            <span>Demo · {demoRoleLabel}</span>
          </Link>
        ) : null}
        <button
          type="button"
          className="sidebar-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={() => toggleCollapsed()}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden size={16} strokeWidth={1.8} />
          ) : (
            <PanelLeftClose aria-hidden size={16} strokeWidth={1.8} />
          )}
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}

function AdminTopbar({
  setMobileNavOpen,
  setDialog,
  eventInitials,
  event,
  dateLocation,
  commandTriggerRef,
  openCommandDialog,
  viewer,
  notificationCount,
  initials,
}: {
  setMobileNavOpen(value: boolean): void;
  setDialog(value: AdminShellDialog): void;
  eventInitials: string;
  event: AdminShellEvent;
  dateLocation: string;
  commandTriggerRef: React.RefObject<HTMLButtonElement | null>;
  openCommandDialog(): void;
  viewer: AdminShellViewer;
  notificationCount: number;
  initials: string;
}) {
  return (
    <header className="topbar">
      {/* The sidebar is display:none below 760px. Without this the whole
            admin product has no navigation at all on a phone. */}
      <button
        type="button"
        className="icon-btn pc-mobile-nav-trigger"
        aria-label="Open navigation"
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu aria-hidden size={18} />
      </button>
      <button
        type="button"
        className="event-switcher"
        aria-label="Switch event"
        onClick={() => setDialog("event")}
      >
        <span className="event-thumb" aria-hidden>
          {eventInitials}
        </span>
        <span>
          <strong>{event.name}</strong>
          <small>{dateLocation}</small>
        </span>
        <ChevronDown aria-hidden size={15} />
      </button>
      <button
        ref={commandTriggerRef}
        type="button"
        className="command-trigger"
        aria-label="Search or run a command"
        onClick={openCommandDialog}
      >
        <Search aria-hidden size={14} />
        {/* One control, one keycap. ? opened the shortcut reference, not
              this, so it advertised a second way to search that did not
              search. The shortcut dialog documents it. */}
        <span>Search or run a command…</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="top-actions">
        {viewer.role !== "committee_chair" ? (
          <Button
            /* The label span is display:none below 760px, which leaves the
                 only filled primary in the global chrome with no name. */
            aria-label="New"
            variant="primary"
            onClick={() => setDialog("new")}
          >
            <Plus aria-hidden size={15} />
            <span>New</span>
          </Button>
        ) : null}
        <button
          type="button"
          className={`icon-btn${notificationCount ? " badge-dot" : ""}`}
          data-count={notificationCount || undefined}
          aria-label={`${notificationCount} operational notification${notificationCount === 1 ? "" : "s"}`}
          onClick={() => setDialog("notifications")}
        >
          <Bell aria-hidden size={16} />
        </button>
        <button
          type="button"
          className="avatar"
          title={viewer.name}
          aria-label="Open account menu"
          onClick={() => setDialog("viewer")}
        >
          {initials}
        </button>
      </div>
    </header>
  );
}

function AdminMobileNavigation({
  mobileNavOpen,
  setMobileNavOpen,
  navigationGroups,
  navigationItems,
  pathname,
}: {
  mobileNavOpen: boolean;
  setMobileNavOpen(value: boolean): void;
  navigationGroups: AdminNavigationGroups;
  navigationItems: ReadonlyArray<AdminNavigationItem>;
  pathname: string;
}) {
  const location = { pathname };
  return (
    <>
      {mobileNavOpen ? (
        <Dialog title="Navigation" onClose={() => setMobileNavOpen(false)}>
          <nav aria-label="Primary" className="pc-mobile-nav">
            {navigationGroups.map((group) => (
              <div className="pc-mobile-nav-group" key={group.label}>
                <span className="nav-group-label">{group.label}</span>
                {group.items.map(([id, Icon, label]) => (
                  <div className="nav-item" key={id}>
                    <Link
                      to={`/admin/${id}`}
                      className={
                        primaryNavigationItemActive(id, location.pathname)
                          ? "active"
                          : undefined
                      }
                      aria-current={
                        primaryNavigationItemActive(id, location.pathname)
                          ? "page"
                          : undefined
                      }
                      data-dialog-autofocus={
                        primaryNavigationItemActive(id, location.pathname)
                          ? ""
                          : undefined
                      }
                      onClick={() => setMobileNavOpen(false)}
                    >
                      <span className="nav-icon">
                        <Icon aria-hidden size={17} strokeWidth={1.8} />
                      </span>
                      {label}
                    </Link>
                    {primaryNavigationItemExpanded(id, location.pathname)
                      ? primaryNavigationChildren(id, navigationItems).map(
                          ([childId, , childLabel]) => (
                            <Link
                              key={childId}
                              className={`pc-mobile-nav-child${
                                primaryNavigationItemActive(
                                  childId,
                                  location.pathname,
                                )
                                  ? " active"
                                  : ""
                              }`}
                              to={`/admin/${childId}`}
                              aria-current={
                                primaryNavigationItemActive(
                                  childId,
                                  location.pathname,
                                )
                                  ? "page"
                                  : undefined
                              }
                              onClick={() => setMobileNavOpen(false)}
                            >
                              {childLabel}
                            </Link>
                          ),
                        )
                      : null}
                  </div>
                ))}
              </div>
            ))}
          </nav>
        </Dialog>
      ) : null}
    </>
  );
}

function AdminPageFrame({
  currentEventOption,
  breadcrumbs,
  event,
  homeHref,
  copyDeepLink,
  copyState,
  children,
}: {
  currentEventOption: AdminShellEventOption;
  breadcrumbs: ReturnType<typeof adminPageBreadcrumbs>;
  event: AdminShellEvent;
  homeHref: string;
  copyDeepLink(): Promise<void>;
  copyState: CopyDeepLinkState;
  children: React.ReactNode;
}) {
  return (
    <main id="main" className="main" tabIndex={-1}>
      <div className="pc-context-bar admin-context-bar">
        <nav aria-label="Breadcrumb">
          <ol className="pc-breadcrumbs admin-breadcrumbs">
            <li>
              <Link to="/events/select" reloadDocument>
                {currentEventOption.organisationName}
              </Link>
            </li>
            <li>
              {breadcrumbs.length ? (
                <Link to={homeHref}>{event.name}</Link>
              ) : (
                <span aria-current="page">{event.name}</span>
              )}
            </li>
            {breadcrumbs.map((crumb) => (
              <li key={`${crumb.href ?? "current"}:${crumb.label}`}>
                {crumb.href ? (
                  <Link to={crumb.href}>{crumb.label}</Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <button
          /* Ghost, not a bordered button: a rarely-used utility sitting on
               the same edge and at the same weight as the page's real action
               left the eye no way to rank the two. */
          className="btn small ghost pc-copy-deep-link"
          type="button"
          onClick={() => void copyDeepLink()}
          aria-label="Copy a deep link to this page"
        >
          <ClipboardCopy aria-hidden size={14} />
          {copyState === "copied"
            ? "Link copied"
            : copyState === "unavailable"
              ? "Copy unavailable"
              : "Copy page link"}
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied"
            ? "Page link copied to the clipboard."
            : copyState === "unavailable"
              ? "The browser did not allow clipboard access."
              : ""}
        </span>
      </div>
      {children}
    </main>
  );
}

export function AdminShell({
  event,
  eventOptions,
  viewer,
  notifications,
  commandPalette,
  children,
}: {
  event: AdminShellEvent;
  eventOptions: ReadonlyArray<AdminShellEventOption>;
  viewer: AdminShellViewer;
  notifications: ReadonlyArray<AdminShellNotification>;
  commandPalette: AdminShellCommandPalette;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [collapsed, setCollapsed] = useState(false);
  const [motionReady, setMotionReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dialog, setDialog] = useState<AdminShellDialog>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandScope, setCommandScope] =
    useState<AdminCommandSearchScope>("event");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );
  const recordSearch = useFetcher<{ records: CommandRecord[] }>();
  const requestedRecordSearchKey = useRef<string | null>(null);
  const commandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commandReturnFocusRef = useRef<HTMLElement | null>(null);
  const [recordSearchResult, setRecordSearchResult] =
    useState<AdminCommandSearchResult | null>(null);

  const closeDialog = useCallback(() => setDialog(null), []);
  const openCommandDialog = useCallback(() => {
    commandReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : commandTriggerRef.current;
    // Every invocation is a new intent. Reopening stale text or an
    // organisation-wide scope made the palette look broken and could search a
    // broader boundary than the operator expected.
    setCommandQuery("");
    setCommandScope("event");
    setDialog("command");
  }, []);
  const initials = viewer.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const eventInitials = event.name
    .split(/\s+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word[0] ?? ""))
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const dateLocation = [
    event.dates,
    [event.venue, event.city].filter(Boolean).join(", "),
    event.timezone,
  ]
    .filter(Boolean)
    .join(" · ");
  const notificationCount = notifications.reduce(
    (sum, notification) => sum + notification.count,
    0,
  );
  const navigationItems =
    viewer.role === "committee_chair"
      ? NAV_ITEMS.filter(([id]) => id === "review")
      : NAV_ITEMS.filter(
          ([id]) => id !== "crm" || viewer.canCreateEvents || viewer.demo,
        );
  const navigationGroups = primaryNavigationGroups(navigationItems);
  const demoRoleLabel = viewer.role.replaceAll("_", " ");
  const viewArea = savedViewArea(location.pathname);
  const currentHref = `${location.pathname}${location.search}${location.hash}`;
  const currentEventOption = eventOptions.find(
    (option) => option.eventId === event.id,
  );
  if (!currentEventOption) {
    throw new Error(
      "The current event is missing from the authorised event options.",
    );
  }
  const breadcrumbs = adminPageBreadcrumbs(
    location.pathname,
    adminRecordBreadcrumb(matches),
  );

  useHotkeys("mod+k", openCommandDialog, {
    preventDefault: true,
    enableOnFormTags: false,
  });
  useHotkeys("shift+/", () => setDialog("shortcuts"), {
    preventDefault: true,
    enableOnFormTags: false,
  });

  const currentRecordSearchKey =
    dialog === "command"
      ? adminCommandSearchKey(commandQuery, commandScope, event.id)
      : null;
  const currentRecordSearchResult = adminCommandRecordsForKey(
    recordSearchResult,
    currentRecordSearchKey,
  );
  const recordSearchPending = Boolean(
    currentRecordSearchKey &&
      (recordSearch.state !== "idle" || currentRecordSearchResult === null),
  );

  useEffect(() => {
    if (!currentRecordSearchKey) return;
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams({
        q: commandQuery.trim(),
        scope: commandScope,
      });
      requestedRecordSearchKey.current = currentRecordSearchKey;
      void recordSearch.load(`/admin/search?${search}`);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [commandQuery, commandScope, currentRecordSearchKey, recordSearch.load]);

  useEffect(() => {
    const key = requestedRecordSearchKey.current;
    if (recordSearch.state !== "idle" || !recordSearch.data || !key) return;
    setRecordSearchResult({ key, records: recordSearch.data.records });
  }, [recordSearch.data, recordSearch.state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The current URL is the deliberate reset trigger for transient copy feedback.
  useEffect(() => setCopyState("idle"), [currentHref]);

  // Switching event reloads the document, so component state alone threw the
  // rail width away every time an operator changed event.
  useEffect(() => {
    setCollapsed(readSidebarCollapsedCookie());
    // Restoring a stored width is a starting position, not a movement the
    // operator made, so the transition only arms once that paint has landed.
    const outer = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setMotionReady(true));
    });
    return () => window.cancelAnimationFrame(outer);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeSidebarCollapsedCookie(next);
  }

  async function copyDeepLink() {
    if (!navigator.clipboard?.writeText) {
      setCopyState("unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyState("copied");
    } catch {
      setCopyState("unavailable");
    }
  }

  function selectCommand(href: string) {
    closeDialog();
    void navigate(href);
  }

  function selectAssistantDraft(prompt: string) {
    closeDialog();
    void navigate("/admin/assistant", {
      state: {
        assistantDraft: prompt,
      } satisfies AdminAssistantNavigationState,
    });
  }

  function selectRecord(record: CommandRecord) {
    const selection = adminCommandRecordSelection(record, event.id);
    closeDialog();
    if (selection.kind === "navigate") {
      void navigate(selection.href);
      return;
    }
    void submit(
      { eventId: selection.eventId, returnTo: selection.returnTo },
      { method: "post", action: "/events/select" },
    );
  }

  const staticMatch = (value: string) =>
    adminCommandMatches(commandQuery, value);

  return (
    <div
      className={`app-admin${collapsed ? " sidebar-is-collapsed" : ""}${
        motionReady ? " shell-motion-ready" : ""
      }`}
    >
      <AdminSidebar
        navigationGroups={navigationGroups}
        navigationItems={navigationItems}
        pathname={location.pathname}
        viewer={viewer}
        demoRoleLabel={demoRoleLabel}
        collapsed={collapsed}
        toggleCollapsed={toggleCollapsed}
      />
      <AdminTopbar
        setMobileNavOpen={setMobileNavOpen}
        setDialog={setDialog}
        eventInitials={eventInitials}
        event={event}
        dateLocation={dateLocation}
        commandTriggerRef={commandTriggerRef}
        openCommandDialog={openCommandDialog}
        viewer={viewer}
        notificationCount={notificationCount}
        initials={initials}
      />
      <AdminMobileNavigation
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
        navigationGroups={navigationGroups}
        navigationItems={navigationItems}
        pathname={location.pathname}
      />
      <AdminPageFrame
        currentEventOption={currentEventOption}
        breadcrumbs={breadcrumbs}
        event={event}
        homeHref={
          viewer.role === "committee_chair" ? "/admin/review" : "/admin/command"
        }
        copyDeepLink={copyDeepLink}
        copyState={copyState}
      >
        {children}
      </AdminPageFrame>

      <AdminCommandDialog
        open={dialog === "command"}
        closeDialog={closeDialog}
        commandPalette={commandPalette}
        commandQuery={commandQuery}
        setCommandQuery={setCommandQuery}
        commandScope={commandScope}
        setCommandScope={setCommandScope}
        recordSearchPending={recordSearchPending}
        currentRecordSearchResult={currentRecordSearchResult}
        navigationItems={navigationItems}
        pathname={location.pathname}
        staticMatch={staticMatch}
        selectRecord={selectRecord}
        selectCommand={selectCommand}
        selectAssistantDraft={selectAssistantDraft}
        setDialog={setDialog}
        viewArea={viewArea}
        viewerRole={viewer.role}
        canCreateEvents={viewer.canCreateEvents}
        assistantAvailable={canOpenAdminAssistant(viewer.role)}
        returnFocus={commandReturnFocusRef}
      />

      <AdminAuxiliaryDialogs
        dialog={dialog}
        viewArea={viewArea}
        closeDialog={closeDialog}
        currentHref={currentHref}
        commandPalette={commandPalette}
        selectCommand={selectCommand}
        eventOptions={eventOptions}
        event={event}
        viewer={viewer}
        notifications={notifications}
      />
    </div>
  );
}

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  BookOpen,
  Cable,
  CalendarCog,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  ClipboardCopy,
  ContactRound,
  Files,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  ListChecks,
  Mail,
  Menu,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  Plus,
  Search,
  Settings,
  UsersRound,
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
import type { AdminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
import type {
  CommandRecord,
  RecentCommandRecord,
} from "~/platform/operations/command-palette-service.server";
import type {
  SavedViewArea,
  SavedViewListItem,
} from "~/platform/operations/saved-view-service.server";
import { AdminCommandDialog } from "./admin-shell-command-dialog";

import { AdminAuxiliaryDialogs } from "./admin-shell-dialogs";
import { BrandMark } from "./brand-mark";
import { Dialog } from "./dialog";
import { Button } from "./ui/button";

export type AdminNavigationItem = readonly [string, LucideIcon, string];

export const NAV_ITEMS = [
  ["command", LayoutDashboard, "Home"],
  ["event", CalendarCog, "Event settings"],
  ["branding", Palette, "Branding"],
  ["site", Globe2, "Public site"],
  ["submissions", Files, "Applications"],
  /* Sparkles is the universal "a machine wrote this" glyph and the palette
     already spends it on the assistant. Humans score submissions here. */
  ["review", ClipboardCheck, "Review & selection"],
  ["speakers", UsersRound, "Speakers"],
  ["crm", ContactRound, "Speaker network"],
  ["resources", BookOpen, "Speaker resources"],
  ["schedule", CalendarDays, "Programme"],
  ["communications", Mail, "Communications"],
  ["tasks", ListChecks, "Tasks"],
  /* Files and FileStack are the same stacked-paper outline at 16px, which is
     exactly the size the rail runs at when the icon is the only label. */
  ["content", FolderOpen, "Session content & files"],
  ["programme", PanelTop, "Publish & embed"],
  ["integrations", Cable, "Integrations"],
  ["settings", Settings, "API & webhooks"],
  ["operations", Activity, "Operations"],
] as const satisfies ReadonlyArray<AdminNavigationItem>;

/* Keep a stable set of user-facing workspace families. Their children expose
   the existing routes without making the rail mirror the internal model. */
const NAV_GROUPS = [
  {
    label: "Event work",
    ids: ["command", "submissions", "speakers", "schedule", "communications"],
  },
  {
    label: "Administration",
    ids: ["event", "operations"],
  },
] as const;

/* Speaker Network and Resources are full workspaces that no rail entry pointed
   at, so the rail marked Speakers current for them and contradicted the
   breadcrumb printed directly below it. They are the speaker family's second
   level and appear whenever that family is where you are. */
const NAV_CHILDREN: Record<string, ReadonlyArray<string>> = {
  submissions: ["review"],
  speakers: ["crm", "resources"],
  schedule: ["content", "programme"],
  communications: ["tasks"],
  event: ["branding", "site"],
  operations: ["integrations", "settings"],
};

function navigationFamily(id: string) {
  return [id, ...(NAV_CHILDREN[id] ?? [])];
}

export function primaryNavigationGroups(
  items: ReadonlyArray<AdminNavigationItem>,
) {
  const placementCounts = new Map<string, number>();
  for (const group of NAV_GROUPS) {
    for (const parentId of group.ids) {
      for (const id of navigationFamily(parentId)) {
        placementCounts.set(id, (placementCounts.get(id) ?? 0) + 1);
      }
    }
  }
  const invalidConfiguration = NAV_ITEMS.filter(
    ([id]) => placementCounts.get(id) !== 1,
  ).map(([id]) => id);
  if (invalidConfiguration.length) {
    throw new Error(
      `Administrator navigation items must have exactly one family: ${invalidConfiguration.join(", ")}`,
    );
  }
  const unknownItems = items
    .filter(([id]) => !placementCounts.has(id))
    .map(([id]) => id);
  if (unknownItems.length) {
    throw new Error(
      `Administrator navigation items are not assigned to a family: ${unknownItems.join(", ")}`,
    );
  }
  const available = new Map(items.map((item) => [item[0], item]));
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.ids.flatMap((parentId) => {
      const parent = available.get(parentId);
      if (parent) return [parent];
      return (NAV_CHILDREN[parentId] ?? []).flatMap((childId) => {
        const child = available.get(childId);
        return child ? [child] : [];
      });
    }),
  })).filter((group) => group.items.length > 0);
  return groups;
}

export function primaryNavigationSection(pathname: string) {
  const section = pathname.split("/").filter(Boolean)[1] ?? "command";
  if (section === "sessions") return "schedule";
  if (section === "events" || section === "files") return "event";
  return section;
}

export function primaryNavigationItemActive(id: string, pathname: string) {
  return primaryNavigationSection(pathname) === id;
}

export function primaryNavigationItemExpanded(id: string, pathname: string) {
  return navigationFamily(id).includes(primaryNavigationSection(pathname));
}

export function primaryNavigationChildren(
  id: string,
  items: ReadonlyArray<AdminNavigationItem>,
) {
  const available = new Map(items.map((item) => [item[0], item]));
  return (NAV_CHILDREN[id] ?? []).flatMap((childId) => {
    const item = available.get(childId);
    return item ? [item] : [];
  });
}
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

export function canOpenAdminAssistant(role: string) {
  return role !== "committee_chair";
}

function savedViewArea(pathname: string): SavedViewArea | null {
  if (pathname.startsWith("/admin/submissions")) return "submissions";
  if (pathname.startsWith("/admin/review")) return "evaluations";
  if (pathname.startsWith("/admin/speakers")) return "speakers";
  if (
    pathname.startsWith("/admin/schedule") ||
    pathname.startsWith("/admin/programme") ||
    pathname.startsWith("/admin/sessions")
  )
    return "sessions";
  if (
    pathname.startsWith("/admin/tasks") ||
    pathname.startsWith("/admin/command")
  )
    return "tasks";
  if (pathname.startsWith("/admin/operations")) return "operations";
  return null;
}

const ADMIN_SECTION_LABELS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map(([id, , label]) => [id, label]),
);

export type AdminRecordBreadcrumb =
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "resolved"; label: string };

export function adminRecordBreadcrumb(
  matches: ReadonlyArray<{
    loaderData: unknown;
    handle?: unknown;
  }>,
): AdminRecordBreadcrumb {
  for (const match of matches) {
    const handle = match.handle as AdminRecordBreadcrumbHandle | undefined;
    if (typeof handle?.adminRecordBreadcrumbLabel !== "function") continue;
    if (match.loaderData === undefined || match.loaderData === null) {
      return { state: "unavailable" };
    }
    const label = handle.adminRecordBreadcrumbLabel(match.loaderData);
    if (label !== null) {
      return { state: "resolved", label };
    }
  }
  return { state: "none" };
}

function requiredRecordBreadcrumb(
  breadcrumb: AdminRecordBreadcrumb,
  unavailableLabel: string,
) {
  if (breadcrumb.state === "resolved") return breadcrumb.label;
  if (breadcrumb.state === "unavailable") return unavailableLabel;
  throw new Error("The record detail route has no breadcrumb handle.");
}

export function adminPageBreadcrumbs(
  pathname: string,
  recordBreadcrumb: AdminRecordBreadcrumb = { state: "none" },
) {
  const parts = pathname.split("/").filter(Boolean);
  const section = parts[1] ?? "command";
  const sectionLabel =
    section === "events"
      ? "Event settings"
      : section === "sessions"
        ? "Programme"
        : section === "files"
          ? "Event settings"
          : (ADMIN_SECTION_LABELS[section] ??
            section
              .replaceAll("-", " ")
              .replace(/^./, (letter) => letter.toUpperCase()));
  const sectionHref =
    section === "events"
      ? "/admin/event"
      : section === "sessions"
        ? "/admin/schedule"
        : section === "files"
          ? "/admin/event"
          : `/admin/${section}`;

  if (parts.length <= 2) {
    return section === "command"
      ? []
      : [{ label: sectionLabel, href: null as string | null }];
  }

  const detailLabel =
    pathname === "/admin/events/new"
      ? "New event"
      : pathname === "/admin/events/clone"
        ? "Clone event"
        : pathname === "/admin/submissions/form"
          ? "Form builder"
          : pathname === "/admin/submissions/new"
            ? "Create application record"
            : pathname === "/admin/sessions/new"
              ? "Create direct session"
              : pathname === "/admin/tasks/bulk"
                ? "Bulk task update"
                : pathname === "/admin/sessions/bulk"
                  ? "Bulk session update"
                  : pathname === "/admin/files/retention"
                    ? "Data retention"
                    : section === "submissions"
                      ? requiredRecordBreadcrumb(
                          recordBreadcrumb,
                          "Application",
                        )
                      : section === "crm" && parts[2] === "pipeline"
                        ? "Sourcing pipeline"
                        : section === "crm" && parts[2] === "outreach"
                          ? "Speaker invitations"
                          : section === "crm" && parts[2] === "contacts"
                            ? requiredRecordBreadcrumb(
                                recordBreadcrumb,
                                "Contact",
                              )
                            : section === "speakers"
                              ? requiredRecordBreadcrumb(
                                  recordBreadcrumb,
                                  "Speaker",
                                )
                              : section === "content" && parts[2] === "sessions"
                                ? requiredRecordBreadcrumb(
                                    recordBreadcrumb,
                                    "Session",
                                  )
                                : "Detail";

  return [
    { label: sectionLabel, href: sectionHref },
    { label: detailLabel, href: null as string | null },
  ];
}

export type AdminCommandSearchScope = "event" | "organisation";
export type AdminCommandSearchResult = {
  key: string;
  records: CommandRecord[];
};

export function adminCommandSearchKey(
  query: string,
  scope: AdminCommandSearchScope,
  eventId: string,
) {
  const normalizedQuery = query.trim();
  return normalizedQuery.length >= 2
    ? JSON.stringify([eventId, scope, normalizedQuery])
    : null;
}

export function adminCommandRecordsForKey(
  result: AdminCommandSearchResult | null,
  currentKey: string | null,
) {
  return result && result.key === currentKey ? result.records : null;
}

export function adminCommandRecordSelection(
  record: Pick<CommandRecord, "eventId" | "href">,
  currentEventId: string,
) {
  return record.eventId === currentEventId
    ? ({ kind: "navigate", href: record.href } as const)
    : ({
        kind: "select-event",
        eventId: record.eventId,
        returnTo: record.href,
      } as const);
}

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
  copyDeepLink,
  copyState,
  children,
}: {
  currentEventOption: AdminShellEventOption;
  breadcrumbs: ReturnType<typeof adminPageBreadcrumbs>;
  event: AdminShellEvent;
  copyDeepLink(): Promise<void>;
  copyState: CopyDeepLinkState;
  children: React.ReactNode;
}) {
  return (
    <main id="main" className="main" tabIndex={-1}>
      <div className="pc-context-bar">
        <nav aria-label="Breadcrumb">
          <ol className="pc-breadcrumbs">
            <li>
              <Link to="/events/select">
                {currentEventOption.organisationName}
              </Link>
            </li>
            <li>
              {breadcrumbs.length ? (
                <Link to="/admin/command">{event.name}</Link>
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
    setDialog("command");
  }, []);
  const closeCommandDialog = useCallback(() => {
    setDialog(null);
    // The controlled Radix root unmounts in the same event as Escape. Restore
    // after its focus scope has completed teardown, using the element captured
    // synchronously when the toolbar button or keyboard shortcut opened it.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() =>
        commandReturnFocusRef.current?.focus(),
      );
    });
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
    !commandQuery.trim() ||
    value.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase());

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
        copyDeepLink={copyDeepLink}
        copyState={copyState}
      >
        {children}
      </AdminPageFrame>

      <AdminCommandDialog
        open={dialog === "command"}
        closeDialog={closeCommandDialog}
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
        setDialog={setDialog}
        viewArea={viewArea}
        viewerRole={viewer.role}
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

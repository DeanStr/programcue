import { useHotkeys } from "react-hotkeys-hook";
import {
  Bell,
  BookOpen,
  CalendarCog,
  CalendarDays,
  Cable,
  ChevronDown,
  ClipboardCopy,
  ContactRound,
  Files,
  Grid3X3,
  LayoutDashboard,
  ListChecks,
  Activity,
  Mail,
  PanelTop,
  Plus,
  Search,
  Settings,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  useFetcher,
  useLocation,
  useNavigate,
  useSubmit,
} from "react-router";

import type {
  CommandRecord,
  RecentCommandRecord,
} from "~/platform/operations/command-palette-service.server";
import type {
  SavedViewArea,
  SavedViewListItem,
} from "~/platform/operations/saved-view-service.server";

import { AdminAuxiliaryDialogs } from "./admin-shell-dialogs";
import { AdminCommandDialog } from "./admin-shell-command-dialog";
import { Button } from "./ui/button";

export type AdminNavigationItem = readonly [string, LucideIcon, string];

export const NAV_ITEMS = [
  ["command", LayoutDashboard, "Command Centre"],
  ["event", CalendarCog, "Event Setup"],
  ["submissions", Files, "Submissions"],
  ["review", Sparkles, "Review"],
  ["speakers", UsersRound, "Speakers"],
  ["crm", ContactRound, "Speaker Network"],
  ["resources", BookOpen, "Resources"],
  ["schedule", CalendarDays, "Schedule"],
  ["communications", Mail, "Communications"],
  ["tasks", ListChecks, "Tasks"],
  ["programme", PanelTop, "Programme"],
  ["integrations", Cable, "Integrations"],
  ["settings", Settings, "Settings"],
  ["operations", Activity, "Operations"],
] as const satisfies ReadonlyArray<AdminNavigationItem>;
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

export function adminPageBreadcrumbs(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const section = parts[1] ?? "command";
  const sectionLabel =
    section === "events"
      ? "Event Setup"
      : section === "sessions"
        ? "Sessions"
        : section === "files"
          ? "Files"
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
          ? "/admin/settings"
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
          : pathname === "/admin/tasks/bulk"
            ? "Bulk task update"
            : pathname === "/admin/sessions/bulk"
              ? "Bulk session update"
              : pathname === "/admin/files/retention"
                ? "Data retention"
                : section === "submissions"
                  ? "Application detail"
                  : section === "crm" && parts[2] === "pipeline"
                    ? "Sourcing pipeline"
                    : section === "crm" && parts[2] === "outreach"
                      ? "Speaker invitations"
                      : section === "crm" && parts[2] === "contacts"
                        ? "Contact"
                        : section === "speakers"
                          ? "Speaker detail"
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
  const navigate = useNavigate();
  const submit = useSubmit();
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<AdminShellDialog>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandScope, setCommandScope] =
    useState<AdminCommandSearchScope>("event");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );
  const recordSearch = useFetcher<{ records: CommandRecord[] }>();
  const requestedRecordSearchKey = useRef<string | null>(null);
  const [recordSearchResult, setRecordSearchResult] =
    useState<AdminCommandSearchResult | null>(null);

  const closeDialog = useCallback(() => setDialog(null), []);
  const initials = viewer.name
    .split(/\s+/)
    .map((part) => part[0])
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
  const demoRoleLabel = `${viewer.role.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())} demo`;
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
  const breadcrumbs = adminPageBreadcrumbs(location.pathname);

  useHotkeys("mod+k", () => setDialog("command"), {
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
  }, [commandQuery, commandScope, currentRecordSearchKey]);

  useEffect(() => {
    const key = requestedRecordSearchKey.current;
    if (recordSearch.state !== "idle" || !recordSearch.data || !key) return;
    setRecordSearchResult({ key, records: recordSearch.data.records });
  }, [recordSearch.data, recordSearch.state]);

  useEffect(() => setCopyState("idle"), [currentHref]);

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
    <div className={`app-admin${collapsed ? " sidebar-is-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Primary navigation">
        <Link
          className="brand"
          to={
            viewer.role === "committee_chair"
              ? "/admin/review"
              : "/admin/command"
          }
          aria-label="Program Cue home"
        >
          <span className="brand-mark">P</span>
          <span>Program Cue</span>
        </Link>
        <nav className="nav">
          {navigationItems.map(([id, Icon, label]) => (
            <NavLink
              key={id}
              to={`/admin/${id}`}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <span className="nav-icon">
                <Icon aria-hidden size={16} strokeWidth={1.8} />
              </span>
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {viewer.demo ? (
            <Link
              className="demo-card"
              to="/demo"
              title="Open evaluator guide and reset controls"
            >
              <strong>{demoRoleLabel}</strong>
              <div className="mini">
                Evaluator guide · reset · test identities
              </div>
            </Link>
          ) : (
            <div className="demo-card">
              <strong>Production workspace</strong>
              <div className="mini">Authenticated · server authorised</div>
            </div>
          )}
          <button
            type="button"
            className="sidebar-collapse"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "›" : "‹"} <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button
          type="button"
          className="event-switcher"
          aria-label="Switch event"
          onClick={() => setDialog("event")}
        >
          <span className="event-thumb">
            <Grid3X3 aria-hidden size={17} />
          </span>
          <span>
            <strong>{event.name}</strong>
            <small>{dateLocation}</small>
          </span>
          <ChevronDown aria-hidden size={15} />
        </button>
        <button
          type="button"
          className="command-trigger"
          aria-label="Search or run a command"
          onClick={() => setDialog("command")}
        >
          <Search aria-hidden size={14} />
          <span>Search or run a command…</span>
          <kbd>⌘K</kbd>
          <kbd>?</kbd>
        </button>
        <div className="top-actions">
          {viewer.role !== "committee_chair" ? (
            <Button variant="primary" onClick={() => setDialog("new")}>
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
            className="btn small pc-copy-deep-link"
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
        setDialog={setDialog}
        viewArea={viewArea}
        viewerRole={viewer.role}
        assistantAvailable={canOpenAdminAssistant(viewer.role)}
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

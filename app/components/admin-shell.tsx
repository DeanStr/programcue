import { Command } from "cmdk";
import { useHotkeys } from "react-hotkeys-hook";
import {
  Bell,
  BookOpen,
  CalendarCog,
  CalendarDays,
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardCopy,
  Files,
  Grid3X3,
  LayoutDashboard,
  ListChecks,
  Activity,
  Mail,
  PanelTop,
  Plus,
  Save,
  Search,
  Settings,
  Sparkles,
  Tags,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Form,
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

import { Dialog } from "./dialog";
import { Button } from "./ui/button";

const NAV_ITEMS = [
  ["command", LayoutDashboard, "Command Centre"],
  ["event", CalendarCog, "Event Setup"],
  ["submissions", Files, "Submissions"],
  ["review", Sparkles, "Review"],
  ["speakers", UsersRound, "Speakers"],
  ["resources", BookOpen, "Resources"],
  ["schedule", CalendarDays, "Schedule"],
  ["communications", Mail, "Communications"],
  ["tasks", ListChecks, "Tasks"],
  ["programme", PanelTop, "Programme"],
  ["integrations", Cable, "Integrations"],
  ["settings", Settings, "Settings"],
  ["operations", Activity, "Operations"],
] as const;

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

function recordIcon(kind: CommandRecord["kind"]) {
  switch (kind) {
    case "speaker":
      return UserRound;
    case "submission":
      return Files;
    case "session":
      return CalendarDays;
    case "task":
      return ListChecks;
    case "room":
      return Grid3X3;
    case "track":
      return Tags;
    case "resource":
      return BookOpen;
    case "operation":
      return Activity;
  }
  kind satisfies never;
  throw new Error(`Unsupported command record kind: ${String(kind)}`);
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
    pathname === "/admin/events/clone"
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
                : "Detail";

  return [
    { label: sectionLabel, href: sectionHref },
    { label: detailLabel, href: null as string | null },
  ];
}

type AdminCommandSearchScope = "event" | "organisation";
type AdminCommandSearchResult = {
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
  const [dialog, setDialog] = useState<
    | "command"
    | "event"
    | "new"
    | "notifications"
    | "viewer"
    | "views"
    | "shortcuts"
    | null
  >(null);
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
      : NAV_ITEMS;
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

      {dialog === "command" ? (
        <Dialog title="Search or run a command" onClose={closeDialog}>
          <Command label="Program Cue commands" shouldFilter={false}>
            <label className="label">
              Search Program Cue
              <Command.Input
                className="field"
                autoFocus
                style={{ width: "100%" }}
                value={commandQuery}
                onValueChange={setCommandQuery}
                placeholder="Record, operation or command"
              />
            </label>
            {commandPalette.organisationSearchAllowed ? (
              <fieldset className="command-scope" aria-label="Search scope">
                <button
                  type="button"
                  className={`btn small${commandScope === "event" ? " primary" : ""}`}
                  aria-pressed={commandScope === "event"}
                  onClick={() => setCommandScope("event")}
                >
                  Current event
                </button>
                <button
                  type="button"
                  className={`btn small${commandScope === "organisation" ? " primary" : ""}`}
                  aria-pressed={commandScope === "organisation"}
                  onClick={() => setCommandScope("organisation")}
                >
                  Organisation
                </button>
              </fieldset>
            ) : null}
            <Command.List className="command-results">
              {commandQuery.trim().length >= 2 ? (
                <Command.Group heading="Find records">
                  {recordSearchPending ? (
                    <div className="command-group-title" role="status">
                      Searching authorised records…
                    </div>
                  ) : null}
                  {!recordSearchPending &&
                  currentRecordSearchResult?.length === 0 ? (
                    <div className="command-group-title">
                      No authorised records match.
                    </div>
                  ) : null}
                  {currentRecordSearchResult?.map((record) => {
                    const Icon = recordIcon(record.kind);
                    return (
                      <Command.Item
                        key={`${record.eventId}:${record.kind}:${record.id}`}
                        value={`${record.label} ${record.description} ${record.aliases.join(" ")}`}
                        className="command-item"
                        onSelect={() => selectRecord(record)}
                      >
                        <span>
                          <Icon aria-hidden size={15} />{" "}
                          <span>
                            <strong>{record.label}</strong>
                            <small className="subtle">
                              {record.description}
                              {commandScope === "organisation"
                                ? ` · ${record.eventName}`
                                : ""}
                            </small>
                          </span>
                        </span>
                        <span className="meta">{record.kind}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              {navigationItems.some(([, , label]) =>
                staticMatch(`navigate ${label}`),
              ) ? (
                <Command.Group heading="Navigate">
                  {navigationItems
                    .filter(([, , label]) => staticMatch(`navigate ${label}`))
                    .map(([id, Icon, label]) => (
                      <Command.Item
                        key={id}
                        value={`navigate ${label}`}
                        className={`command-item${location.pathname === `/admin/${id}` ? " selected" : ""}`}
                        onSelect={() => selectCommand(`/admin/${id}`)}
                      >
                        <span>
                          <Icon aria-hidden size={15} /> {label}
                        </span>
                        <span className="meta">Open</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ) : null}
              {viewer.role !== "committee_chair" &&
              [
                [
                  "Create direct session proposal application",
                  Files,
                  "Direct session",
                  "/admin/submissions?create=direct-session",
                ],
                [
                  "Create readiness task checklist",
                  ListChecks,
                  "Task",
                  "/admin/tasks?create=task",
                ],
              ].some(([value]) => staticMatch(String(value))) ? (
                <Command.Group heading="Create">
                  {(
                    [
                      [
                        "Create direct session proposal application",
                        Files,
                        "Direct session",
                        "/admin/submissions?create=direct-session",
                      ],
                      [
                        "Create readiness task checklist",
                        ListChecks,
                        "Task",
                        "/admin/tasks?create=task",
                      ],
                    ] as const
                  )
                    .filter(([value]) => staticMatch(value))
                    .map(([value, Icon, label, href]) => (
                      <Command.Item
                        key={value}
                        value={value}
                        className="command-item"
                        onSelect={() => selectCommand(href)}
                      >
                        <span>
                          <Icon aria-hidden size={15} /> {label}
                        </span>
                        <span className="meta">Configure</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ) : null}
              {viewer.role !== "committee_chair" &&
              [
                "prepare targeted reminder follow up",
                "bulk update tag archive restore sessions",
                "export event csv data",
                "import event csv data",
                "save current view filter",
              ].some(staticMatch) ? (
                <Command.Group heading="Actions">
                  {staticMatch("prepare targeted reminder follow up") ? (
                    <Command.Item
                      value="prepare targeted reminder follow up"
                      className="command-item"
                      onSelect={() =>
                        selectCommand("/admin/communications?action=reminder")
                      }
                    >
                      <span>
                        <Mail aria-hidden size={15} /> Prepare targeted reminder
                      </span>
                      <span className="meta">Preview first</span>
                    </Command.Item>
                  ) : null}
                  {staticMatch("bulk update tag archive restore sessions") ? (
                    <Command.Item
                      value="bulk update tag archive restore sessions"
                      className="command-item"
                      onSelect={() => selectCommand("/admin/sessions/bulk")}
                    >
                      <span>
                        <Tags aria-hidden size={15} /> Bulk update sessions
                      </span>
                      <span className="meta">Preview first</span>
                    </Command.Item>
                  ) : null}
                  {staticMatch("export event csv data") ? (
                    <Command.Item
                      value="export event csv data"
                      className="command-item"
                      onSelect={() =>
                        selectCommand("/admin/operations?panel=exports")
                      }
                    >
                      <span>
                        <Activity aria-hidden size={15} /> Export event data
                      </span>
                      <span className="meta">Configure</span>
                    </Command.Item>
                  ) : null}
                  {staticMatch("import event csv data") ? (
                    <Command.Item
                      value="import event csv data"
                      className="command-item"
                      onSelect={() =>
                        selectCommand("/admin/operations?panel=imports")
                      }
                    >
                      <span>
                        <Activity aria-hidden size={15} /> Import CSV records
                      </span>
                      <span className="meta">Preview first</span>
                    </Command.Item>
                  ) : null}
                  {viewArea && staticMatch("save current view filter") ? (
                    <Command.Item
                      value="save current view filter"
                      className="command-item"
                      onSelect={() => setDialog("views")}
                    >
                      <span>
                        <Save aria-hidden size={15} /> Save current view
                      </span>
                      <span className="meta">Name view</span>
                    </Command.Item>
                  ) : null}
                </Command.Group>
              ) : null}
              {commandPalette.savedViews.some((view) =>
                staticMatch(`${view.name} ${view.area} saved view`),
              ) ? (
                <Command.Group heading="Saved views">
                  {commandPalette.savedViews
                    .filter((view) =>
                      staticMatch(`${view.name} ${view.area} saved view`),
                    )
                    .map((view) => (
                      <Command.Item
                        key={view.id}
                        value={`${view.name} ${view.area} saved view`}
                        className="command-item"
                        onSelect={() => selectCommand(view.href)}
                      >
                        <span>
                          <Save aria-hidden size={15} />{" "}
                          <span>
                            <strong>{view.name}</strong>
                            <small className="subtle">
                              {view.area} ·{" "}
                              {view.visibility === "event"
                                ? `shared by ${view.ownerName}`
                                : "private"}
                            </small>
                          </span>
                        </span>
                        <span className="meta">Open</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ) : null}
              {!commandQuery.trim() && commandPalette.recentRecords.length ? (
                <Command.Group heading="Recent">
                  {commandPalette.recentRecords.map((record) => (
                    <Command.Item
                      key={record.id}
                      value={`${record.label} ${record.description}`}
                      className="command-item"
                      onSelect={() => selectCommand(record.href)}
                    >
                      <span>
                        <Activity aria-hidden size={15} />{" "}
                        <span>
                          <strong>{record.label}</strong>
                          <small className="subtle">{record.description}</small>
                        </span>
                      </span>
                      <span className="meta">Open</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {["help shortcuts keyboard", "help api documentation"].some(
                staticMatch,
              ) ? (
                <Command.Group heading="Help">
                  {staticMatch("help shortcuts keyboard") ? (
                    <Command.Item
                      value="help shortcuts keyboard"
                      className="command-item"
                      onSelect={() => setDialog("shortcuts")}
                    >
                      <span>
                        <CircleHelp aria-hidden size={15} /> Keyboard shortcuts
                      </span>
                      <span className="meta">?</span>
                    </Command.Item>
                  ) : null}
                  {staticMatch("help api documentation") ? (
                    <Command.Item
                      value="help api documentation"
                      className="command-item"
                      onSelect={() => {
                        closeDialog();
                        window.open(
                          "/api/docs",
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }}
                    >
                      <span>
                        <BookOpen aria-hidden size={15} /> API reference
                      </span>
                      <span className="meta">New tab</span>
                    </Command.Item>
                  ) : null}
                </Command.Group>
              ) : null}
              {canOpenAdminAssistant(viewer.role) &&
              staticMatch("ask assistant event help ai") ? (
                <Command.Group heading="Ask assistant">
                  <Command.Item
                    value="ask assistant event help ai"
                    className="command-item"
                    onSelect={() => selectCommand("/admin/assistant")}
                  >
                    <span>
                      <Sparkles aria-hidden size={15} /> Ask about this event
                    </span>
                    <span className="meta">Open assistant</span>
                  </Command.Item>
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </Dialog>
      ) : null}

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
    </div>
  );
}

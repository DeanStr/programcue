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
  UserRound,
  UsersRound,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Form, Link, NavLink, useLocation, useNavigate } from "react-router";

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
  name: string;
  dates: string;
  venue: string;
  city: string;
};

export type AdminShellViewer = {
  name: string;
  email: string;
  role: string;
  demo: boolean;
};

export type AdminShellNotification = {
  label: string;
  count: number;
  href: string;
  severity: "danger" | "warning";
};

export function AdminShell({
  event,
  viewer,
  notifications,
  children,
}: {
  event: AdminShellEvent;
  viewer: AdminShellViewer;
  notifications: ReadonlyArray<AdminShellNotification>;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<"command" | "event" | "new" | "notifications" | "viewer" | null>(null);

  const closeDialog = useCallback(() => setDialog(null), []);
  const initials = viewer.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  const dateLocation = [event.dates, [event.venue, event.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const notificationCount = notifications.reduce((sum, notification) => sum + notification.count, 0);
  const navigationItems = viewer.role === "committee_chair"
    ? NAV_ITEMS.filter(([id]) => id === "review")
    : NAV_ITEMS;
  const demoRoleLabel = `${viewer.role.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())} demo`;

  useHotkeys("mod+k", () => setDialog("command"), { preventDefault: true, enableOnFormTags: false });

  return (
    <div className={`app-admin${collapsed ? " sidebar-is-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand" to={viewer.role === "committee_chair" ? "/admin/review" : "/admin/command"} aria-label="Program Cue home">
          <span className="brand-mark">P</span><span>Program Cue</span>
        </Link>
        <nav className="nav">
          {navigationItems.map(([id, Icon, label]) => <NavLink key={id} to={`/admin/${id}`} className={({ isActive }) => isActive ? "active" : undefined}>
            <span className="nav-icon"><Icon aria-hidden size={16} strokeWidth={1.8} /></span><span className="nav-label">{label}</span>
          </NavLink>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-card">
            <strong>{viewer.demo ? demoRoleLabel : "Production workspace"}</strong>
            <div className="mini">{viewer.demo ? "Seeded event · D1 persistence" : "Authenticated · server authorised"}</div>
          </div>
          <button type="button" className="sidebar-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? "›" : "‹"} <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button type="button" className="event-switcher" aria-label="Switch event" onClick={() => setDialog("event")}>
          <span className="event-thumb"><Grid3X3 aria-hidden size={17} /></span>
          <span><strong>{event.name}</strong><small>{dateLocation}</small></span>
          <ChevronDown aria-hidden size={15} />
        </button>
        <button type="button" className="command-trigger" onClick={() => setDialog("command")}>
          <Search aria-hidden size={14} /><span>Search or run a command…</span><kbd>⌘K</kbd>
        </button>
        <div className="top-actions">
          {viewer.role !== "committee_chair" ? <Button variant="primary" onClick={() => setDialog("new")}><Plus aria-hidden size={15} /><span>New</span></Button> : null}
          <button type="button" className={`icon-btn${notificationCount ? " badge-dot" : ""}`} data-count={notificationCount || undefined} aria-label={`${notificationCount} operational notification${notificationCount === 1 ? "" : "s"}`} onClick={() => setDialog("notifications")}><Bell aria-hidden size={16} /></button>
          <button type="button" className="avatar" title={viewer.name} aria-label="Open account menu" onClick={() => setDialog("viewer")}>{initials}</button>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>{children}</main>

      {dialog === "command" ? (
        <Dialog title="Search or run a command" onClose={closeDialog}>
          <Command label="Program Cue commands">
            <label className="label">Search Program Cue
              <Command.Input className="field" autoFocus style={{ width: "100%" }} />
            </label>
            <Command.List className="command-results">
              <Command.Empty className="command-group-title">No matching commands.</Command.Empty>
              <Command.Group heading="Navigation">
                {navigationItems.map(([id, Icon, label]) => <Command.Item key={id} value={label} className={`command-item${location.pathname === `/admin/${id}` ? " selected" : ""}`} onSelect={() => {
                  closeDialog();
                  void navigate(`/admin/${id}`);
                }}>
                  <span><Icon aria-hidden size={15} /> {label}</span><span className="meta">Open</span>
                </Command.Item>)}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog>
      ) : null}

      {dialog === "event" ? (
        <Dialog title="Current event" onClose={closeDialog} footer={<button type="button" className="btn" onClick={closeDialog}>Close</button>}>
          <section className="card pad"><strong>{event.name}</strong><p className="subtle">{dateLocation}</p><span className="status success">Current event</span></section>
        </Dialog>
      ) : null}

      {dialog === "new" ? (
        <Dialog title="Create" onClose={closeDialog} footer={<button type="button" className="btn" onClick={closeDialog}>Close</button>}>
          <div className="grid grid-2">
            <Link className="card pad" to="/admin/submissions" onClick={closeDialog}><strong>Submission</strong><p className="subtle">Add a direct programme proposal.</p></Link>
            <Link className="card pad" to="/admin/tasks" onClick={closeDialog}><strong>Task</strong><p className="subtle">Create readiness work.</p></Link>
          </div>
        </Dialog>
      ) : null}

      {dialog === "notifications" ? (
        <Dialog title="Notifications" onClose={closeDialog} footer={<button type="button" className="btn" onClick={closeDialog}>Close</button>}>
          {notifications.length ? <div className="stack">{notifications.map((notification) => <Link className="card pad" to={notification.href} onClick={closeDialog} key={notification.label}><span className={`status ${notification.severity}`}>{notification.count}</span><strong className="mt">{notification.label}</strong><p className="subtle">Open the exact affected records.</p></Link>)}</div> : <div className="pc-empty-state"><CheckCircle2 aria-hidden className="pc-state-icon" /><h2>No operational alerts</h2><p>There are no overdue tasks, blocking conflicts or failed operations in the current event.</p></div>}
        </Dialog>
      ) : null}

      {dialog === "viewer" ? (
        <Dialog title={viewer.name} onClose={closeDialog} footer={<button type="button" className="btn" onClick={closeDialog}>Close</button>}>
          <p>{viewer.email}</p><span className="status info"><UserRound aria-hidden size={13} /> {viewer.role}</span>{viewer.demo ? <><p className="help">Demo identities are enabled only by the demo Worker configuration.</p><div className="divider" /><h3>Switch demo surface</h3><div className="grid grid-2">{(["administrator", "evaluator", "submitter", "speaker"] as const).map((role) => <form method="post" action="/demo/role" key={role}><input type="hidden" name="role" value={role} /><button className="btn" type="submit" style={{ width: "100%", textTransform: "capitalize" }}>{role}</button></form>)}</div></> : <><div className="divider" /><Form method="post" action="/sign-out"><button className="btn" type="submit">Sign out</button></Form></>}
        </Dialog>
      ) : null}
    </div>
  );
}

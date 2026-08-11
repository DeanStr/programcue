import { Command } from "cmdk";
import {
  Activity,
  BookOpen,
  CalendarDays,
  CircleHelp,
  Files,
  Grid3X3,
  ListChecks,
  Mail,
  Save,
  Sparkles,
  Tags,
  UserRound,
} from "lucide-react";

import type { CommandRecord } from "~/platform/operations/command-palette-service.server";
import { Dialog } from "./dialog";
import type {
  AdminCommandSearchScope,
  AdminNavigationItem,
  AdminShellCommandPalette,
  AdminShellDialog,
} from "./admin-shell";

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

export function AdminCommandDialog({
  open,
  closeDialog,
  commandPalette,
  commandQuery,
  setCommandQuery,
  commandScope,
  setCommandScope,
  recordSearchPending,
  currentRecordSearchResult,
  navigationItems,
  pathname,
  staticMatch,
  selectRecord,
  selectCommand,
  setDialog,
  viewArea,
  viewerRole,
  assistantAvailable,
}: {
  open: boolean;
  closeDialog: () => void;
  commandPalette: AdminShellCommandPalette;
  commandQuery: string;
  setCommandQuery: (value: string) => void;
  commandScope: AdminCommandSearchScope;
  setCommandScope: (value: AdminCommandSearchScope) => void;
  recordSearchPending: boolean;
  currentRecordSearchResult: CommandRecord[] | null;
  navigationItems: ReadonlyArray<AdminNavigationItem>;
  pathname: string;
  staticMatch: (value: string) => boolean;
  selectRecord: (record: CommandRecord) => void;
  selectCommand: (href: string) => void;
  setDialog: (dialog: AdminShellDialog) => void;
  viewArea: string | null;
  viewerRole: string;
  assistantAvailable: boolean;
}) {
  if (!open) return null;
  return (
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
                    className={`command-item${pathname === `/admin/${id}` ? " selected" : ""}`}
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
          {viewerRole !== "committee_chair" &&
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
          {viewerRole !== "committee_chair" &&
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
                    window.open("/api/docs", "_blank", "noopener,noreferrer");
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
          {assistantAvailable && staticMatch("ask assistant event help ai") ? (
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
  );
}

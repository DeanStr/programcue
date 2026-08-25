import { Command } from "cmdk";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  CircleHelp,
  CornerDownLeft,
  Files,
  Grid3X3,
  ListChecks,
  Mail,
  Palette,
  Save,
  Search,
  Sparkles,
  Tags,
  UserPlus,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { RefObject } from "react";

import { PRODUCT_GUIDE_URL } from "~/lib/product-guide";
import type { CommandRecord } from "~/platform/operations/command-palette-service.server";
import type {
  AdminCommandSearchScope,
  AdminNavigationItem,
  AdminShellCommandPalette,
  AdminShellDialog,
} from "./admin-shell";
import {
  adminAssistantDraft,
  adminAssistantIntent,
} from "./admin-shell-navigation";
import { Dialog } from "./dialog";

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

/**
 * A command the palette can run without searching for a record.
 *
 * Held as data rather than as a column of hand-written conditionals so that
 * "does anything match?" is a length rather than a second copy of the same
 * predicates that can drift from the first.
 */
type StaticCommand = {
  /** The searchable text, and the stable identity cmdk keys rows by. */
  value: string;
  icon: LucideIcon;
  label: string;
  description?: string;
  meta?: string;
  run: () => void;
  /** Only offered where the current page has a view area to save. */
  requiresViewArea?: boolean;
};

/** One row shape for every group, so the eye reads down a single column. */
function CommandRow({
  icon: Icon,
  label,
  description,
  meta,
  current,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  meta?: string;
  current?: boolean;
}) {
  return (
    <>
      <span className="command-icon">
        <Icon aria-hidden size={16} />
      </span>
      <span className="pc-menu-copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="meta">
        {current ? <span className="pc-current-chip">Current</span> : null}
        {meta}
      </span>
    </>
  );
}

function StaticCommandGroup({
  heading,
  commands,
}: {
  heading: string;
  commands: StaticCommand[];
}) {
  if (!commands.length) return null;
  return (
    <Command.Group heading={heading}>
      {commands.map((command) => (
        <Command.Item
          key={command.value}
          value={command.value}
          className="command-item"
          onSelect={command.run}
        >
          <CommandRow
            icon={command.icon}
            label={command.label}
            description={command.description}
            meta={command.meta}
          />
        </Command.Item>
      ))}
    </Command.Group>
  );
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
  canCreateEvents,
  assistantAvailable,
  returnFocus,
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
  canCreateEvents: boolean;
  assistantAvailable: boolean;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  if (!open) return null;
  const trimmedQuery = commandQuery.trim();
  const canRunCommands =
    viewerRole === "owner" || viewerRole === "administrator";
  const assistantIntent = adminAssistantIntent(commandQuery);
  const assistantDraft = adminAssistantDraft(commandQuery);
  const assistantPrompt =
    assistantDraft.status === "ready" ? assistantDraft.prompt : null;

  const createCommands: StaticCommand[] = [
    ...(canCreateEvents
      ? [
          {
            value: "create new event conference workspace",
            icon: CalendarPlus,
            label: "New event",
            description: "Start with a blank event or an event template",
            meta: "Create",
            run: () => selectCommand("/admin/events/new"),
          },
        ]
      : []),
    {
      value: "create direct session proposal application",
      icon: Files,
      label: "Direct session",
      description: "Enter a proposal on behalf of an invited speaker",
      meta: "Configure",
      run: () => selectCommand("/admin/sessions/new"),
    },
    {
      value: "create manual application record proposal",
      icon: Files,
      label: "Application record",
      description: "Enter an application for an accepted participant",
      meta: "Create",
      run: () => selectCommand("/admin/submissions/new"),
    },
    {
      value: "create readiness task checklist",
      icon: ListChecks,
      label: "Task",
      description: "Assign readiness work to a person or a session",
      meta: "Configure",
      run: () => selectCommand("/admin/tasks"),
    },
  ];
  const actionCommands: StaticCommand[] = [
    {
      value: "build edit application call for speakers cfp form builder",
      icon: Files,
      label: "Application form builder",
      description: "Edit questions and preview the applicant experience",
      meta: "Open",
      run: () => selectCommand("/admin/submissions/form"),
    },
    {
      value: "brand branding event logo colours colors typography",
      icon: Palette,
      label: "Brand this event",
      description: "Set the event logo, colours and typography",
      meta: "Open",
      run: () => selectCommand("/admin/branding"),
    },
    {
      value: "invite add administrator admin event access role",
      icon: UserPlus,
      label: "Invite administrator",
      description:
        viewerRole === "owner"
          ? "Grant event or organisation administration access"
          : "Grant administration access to this event",
      meta: "Invite",
      run: () =>
        selectCommand("/admin/event?invite=administrator#event-setup-access"),
    },
    {
      value:
        "manage create invite evaluation review team evaluator committee access",
      icon: UsersRound,
      label: "Manage evaluation team",
      description: "Create teams and invite evaluators or committee chairs",
      meta: "Open",
      run: () => selectCommand("/admin/review?view=setup#evaluation-access"),
    },
    {
      value: "prepare targeted reminder follow up",
      icon: Mail,
      label: "Prepare targeted reminder",
      description: "Choose recipients and preview before sending",
      meta: "Preview first",
      run: () => selectCommand("/admin/communications?action=reminder"),
    },
    {
      value: "bulk update tag archive restore sessions",
      icon: Tags,
      label: "Bulk update sessions",
      description: "Tag, archive or restore a selection",
      meta: "Preview first",
      run: () => selectCommand("/admin/sessions/bulk"),
    },
    {
      value: "export event csv data",
      icon: Activity,
      label: "Export event data",
      description: "Download the current records as CSV",
      meta: "Configure",
      run: () => selectCommand("/admin/operations?panel=exports"),
    },
    {
      value: "import event csv data",
      icon: Activity,
      label: "Import CSV records",
      description: "Check a file against the schema before it lands",
      meta: "Preview first",
      run: () => selectCommand("/admin/operations?panel=imports"),
    },
    {
      value: "save current view filter",
      icon: Save,
      label: "Save current view",
      description: "Keep these filters and this sort order",
      meta: "Name view",
      requiresViewArea: true,
      run: () => setDialog("views"),
    },
  ];
  const helpCommands: StaticCommand[] = [
    {
      value: "help shortcuts keyboard",
      icon: CircleHelp,
      label: "Keyboard shortcuts",
      meta: "?",
      run: () => setDialog("shortcuts"),
    },
    {
      value: "help product guide documentation",
      icon: BookOpen,
      label: "Product guide",
      description: "How to use Program Cue",
      meta: "New tab",
      run: () => {
        closeDialog();
        window.open(PRODUCT_GUIDE_URL, "_blank", "noopener,noreferrer");
      },
    },
    {
      value: "help api documentation",
      icon: BookOpen,
      label: "API reference",
      meta: "New tab",
      run: () => {
        closeDialog();
        window.open("/api/docs", "_blank", "noopener,noreferrer");
      },
    },
  ];
  const assistantCommands: StaticCommand[] =
    !assistantAvailable || assistantDraft.status === "invalid"
      ? []
      : assistantPrompt
        ? [
            {
              value: `ask assistant ${assistantPrompt}`,
              icon: Sparkles,
              label: "Ask assistant",
              description:
                assistantPrompt.length > 140
                  ? `${assistantPrompt.slice(0, 139)}…`
                  : assistantPrompt,
              meta: "Editable draft",
              run: () =>
                selectCommand(
                  `/admin/assistant?prompt=${encodeURIComponent(assistantPrompt)}`,
                ),
            },
          ]
        : [
            {
              value: "ask assistant event help ai",
              icon: Sparkles,
              label: "Ask about this event",
              description: "Answers are grounded in the current records",
              meta: "Open assistant",
              run: () => selectCommand("/admin/assistant"),
            },
          ];

  const matching = (commands: StaticCommand[], allowed = true) =>
    allowed
      ? commands.filter(
          (command) =>
            (command.requiresViewArea ? Boolean(viewArea) : true) &&
            staticMatch(command.value),
        )
      : [];

  const navigateMatches = navigationItems.filter(([, , label, description]) =>
    staticMatch(`navigate ${label} ${description ?? ""}`),
  );
  const createMatches = matching(createCommands, canRunCommands);
  const actionMatches = matching(actionCommands, canRunCommands);
  const helpMatches = matching(helpCommands);
  const assistantMatches = matching(assistantCommands);
  const savedViewMatches = commandPalette.savedViews.filter((view) =>
    staticMatch(`${view.name} ${view.area} saved view`),
  );
  const recentMatches = trimmedQuery ? [] : commandPalette.recentRecords;
  const staticMatchCount =
    navigateMatches.length +
    createMatches.length +
    actionMatches.length +
    helpMatches.length +
    assistantMatches.length +
    savedViewMatches.length +
    recentMatches.length;

  /* Record search is asynchronous while commands are local. Suppress a
     no-record message when a local command already answers the query; showing
     "No records" above an exact action made a successful match read as a
     failure. */
  const searchingRecords =
    !assistantIntent && trimmedQuery.length >= 2 && recordSearchPending;
  const searchesRecords = !assistantIntent && trimmedQuery.length >= 2;
  const recordMatches = currentRecordSearchResult ?? [];
  const showRecordSearchStatus = searchingRecords && staticMatchCount === 0;
  const showNoRecordMatches =
    !assistantIntent &&
    !searchingRecords &&
    recordMatches.length === 0 &&
    staticMatchCount === 0;
  const showRecords =
    searchesRecords &&
    (recordMatches.length > 0 || showRecordSearchStatus || showNoRecordMatches);
  const showNothingMatches =
    !searchesRecords && !searchingRecords && staticMatchCount === 0;
  const waitingForRecordQuery = trimmedQuery.length === 1;

  return (
    <Dialog
      title="Search or run a command"
      onClose={closeDialog}
      returnFocus={returnFocus}
      placement="top"
      titleHidden
      bare
      footer={
        <div className="pc-palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft aria-hidden size={11} />
            </kbd>{" "}
            open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      }
    >
      {/* Input first: the palette is the search field, and a modal title bar
          above it spent the top third restating the placeholder. */}
      <Command label="Program Cue commands" shouldFilter={false} loop>
        <div className="pc-palette-head">
          <Search aria-hidden size={17} />
          <Command.Input
            className="pc-palette-input"
            autoFocus
            value={commandQuery}
            onValueChange={setCommandQuery}
            placeholder="Search records, or run a command…"
          />
          <button
            type="button"
            className="icon-btn modal-close"
            aria-label="Close"
            onClick={closeDialog}
          >
            <X aria-hidden size={17} />
          </button>
        </div>
        {commandPalette.organisationSearchAllowed && !assistantIntent ? (
          <fieldset className="pc-palette-scope">
            <legend className="sr-only">Search scope</legend>
            <div className="pc-segmented">
              <button
                type="button"
                aria-pressed={commandScope === "event"}
                onClick={() => setCommandScope("event")}
              >
                This event
              </button>
              <button
                type="button"
                aria-pressed={commandScope === "organisation"}
                onClick={() => setCommandScope("organisation")}
              >
                Whole organisation
              </button>
            </div>
          </fieldset>
        ) : null}
        <Command.List className="command-results">
          {assistantIntent && !assistantAvailable ? (
            <div className="pc-palette-empty" role="status">
              The event assistant is not available for this role.
            </div>
          ) : assistantDraft.status === "invalid" ? (
            <div className="pc-palette-empty" role="status">
              {assistantDraft.message}
            </div>
          ) : waitingForRecordQuery && staticMatchCount === 0 ? (
            <div className="pc-palette-empty" role="status">
              Type one more character to search authorised records.
            </div>
          ) : showNothingMatches ? (
            <div className="pc-palette-empty">
              Nothing matches “{trimmedQuery}”.
            </div>
          ) : null}
          {showRecords ? (
            <Command.Group heading="Records">
              {showRecordSearchStatus ? (
                <div className="pc-palette-status" role="status">
                  <span className="pc-spin" aria-hidden /> Searching authorised
                  records…
                </div>
              ) : null}
              {showNoRecordMatches ? (
                <div className="pc-palette-status">
                  No authorised records match “{trimmedQuery}”.
                </div>
              ) : null}
              {recordMatches.map((record) => (
                <Command.Item
                  key={`${record.eventId}:${record.kind}:${record.id}`}
                  value={`${record.label} ${record.description} ${record.aliases.join(" ")}`}
                  className="command-item"
                  onSelect={() => selectRecord(record)}
                >
                  <CommandRow
                    icon={recordIcon(record.kind)}
                    label={record.label}
                    description={
                      commandScope === "organisation"
                        ? `${record.description} · ${record.eventName}`
                        : record.description
                    }
                    meta={record.kind}
                  />
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {navigateMatches.length ? (
            <Command.Group heading="Navigate">
              {navigateMatches.map(([id, Icon, label, description]) => (
                <Command.Item
                  key={id}
                  value={`navigate ${label} ${description ?? ""}`}
                  className="command-item"
                  onSelect={() => selectCommand(`/admin/${id}`)}
                >
                  <CommandRow
                    icon={Icon}
                    label={label}
                    description={description}
                    meta={pathname === `/admin/${id}` ? undefined : "Open"}
                    current={pathname === `/admin/${id}`}
                  />
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          <StaticCommandGroup heading="Create" commands={createMatches} />
          <StaticCommandGroup heading="Actions" commands={actionMatches} />
          {savedViewMatches.length ? (
            <Command.Group heading="Saved views">
              {savedViewMatches.map((view) => (
                <Command.Item
                  key={view.id}
                  value={`${view.name} ${view.area} saved view`}
                  className="command-item"
                  onSelect={() => selectCommand(view.href)}
                >
                  <CommandRow
                    icon={Save}
                    label={view.name}
                    description={
                      view.visibility === "event"
                        ? `${view.area} · shared by ${view.ownerName}`
                        : `${view.area} · private`
                    }
                    meta="Open"
                  />
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {recentMatches.length ? (
            <Command.Group heading="Recent">
              {recentMatches.map((record) => (
                <Command.Item
                  key={record.id}
                  value={`${record.label} ${record.description}`}
                  className="command-item"
                  onSelect={() => selectCommand(record.href)}
                >
                  <CommandRow
                    icon={Activity}
                    label={record.label}
                    description={record.description}
                    meta="Open"
                  />
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          <StaticCommandGroup heading="Help" commands={helpMatches} />
          <StaticCommandGroup
            heading="Ask assistant"
            commands={assistantMatches}
          />
        </Command.List>
      </Command>
    </Dialog>
  );
}

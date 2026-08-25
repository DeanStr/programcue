import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  Cable,
  CalendarCog,
  CalendarDays,
  ClipboardCheck,
  ContactRound,
  Files,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  ListChecks,
  Mail,
  Palette,
  PanelTop,
  Settings,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { AdminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
import { AI_ASSISTANT_PROMPT_MAX_LENGTH } from "~/modules/ai/ai-types";
import type { CommandRecord } from "~/platform/operations/command-palette-service.server";
import type { SavedViewArea } from "~/platform/operations/saved-view-service.server";

export type AdminNavigationItem = readonly [
  string,
  LucideIcon,
  string,
  string?,
];

export const NAV_ITEMS = [
  ["command", LayoutDashboard, "Home"],
  [
    "assistant",
    Sparkles,
    "Event assistant",
    "Ask questions grounded in the current event records",
  ],
  ["event", CalendarCog, "Event settings"],
  ["branding", Palette, "Branding"],
  [
    "site",
    Globe2,
    "Event website",
    "Homepage, event information, sponsors and recordings",
  ],
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
  [
    "programme",
    PanelTop,
    "Programme publishing",
    "Published schedule, attendee programme and website embeds",
  ],
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
  command: ["assistant"],
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

export function canOpenAdminAssistant(role: string) {
  return role === "owner" || role === "administrator";
}

export function adminAssistantIntent(query: string) {
  return /^ask(?:\s|:|$)/iu.test(query.trim());
}

export type AdminAssistantDraft =
  | { status: "none" }
  | { status: "ready"; prompt: string }
  | { status: "invalid"; message: string };

export type AdminAssistantNavigationState = {
  assistantDraft: string;
};

function normalizedCommandText(value: string) {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Match command intent as words instead of one exact substring.
 *
 * Operators commonly remember the right concepts in the wrong order (for
 * example, "admin invite" rather than "invite administrator"). Requiring
 * every normalized query word keeps the result set predictable without
 * introducing fuzzy near-matches that are risky in an action launcher.
 */
export function adminCommandMatches(query: string, candidate: string) {
  const queryWords = normalizedCommandText(query).split(/\s+/u).filter(Boolean);
  if (!queryWords.length) return true;
  const normalizedCandidate = normalizedCommandText(candidate);
  return queryWords.every((word) => normalizedCandidate.includes(word));
}

/**
 * Treat `ask …`, `ask: …` and `ask assistant: …` as an explicit assistant
 * handoff. The prompt remains a draft on the assistant page; parsing it here
 * never executes a model request or a domain command.
 */
export function adminAssistantDraft(query: string): AdminAssistantDraft {
  const trimmed = query.trim();
  const assistantPrefixed = trimmed.match(
    /^ask\s+assistant(?:\s*:\s*|\s+)(.+)$/iu,
  );
  const direct = trimmed.match(/^ask(?:\s*:\s*|\s+)(.+)$/iu);
  const prompt = (assistantPrefixed?.[1] ?? direct?.[1] ?? "").trim();
  if (!prompt || prompt.toLowerCase() === "assistant") {
    return { status: "none" };
  }
  if (prompt.length > AI_ASSISTANT_PROMPT_MAX_LENGTH) {
    return {
      status: "invalid",
      message: `Assistant requests are limited to ${AI_ASSISTANT_PROMPT_MAX_LENGTH.toLocaleString("en")} characters. Shorten this draft before continuing.`,
    };
  }
  return { status: "ready", prompt };
}

export function adminAssistantDraftFromNavigationState(
  state: unknown,
): AdminAssistantDraft {
  if (!state || typeof state !== "object" || !("assistantDraft" in state)) {
    return { status: "none" };
  }
  const prompt = state.assistantDraft;
  if (typeof prompt !== "string") {
    return {
      status: "invalid",
      message: "The assistant draft navigation state is invalid.",
    };
  }
  if (prompt.length > AI_ASSISTANT_PROMPT_MAX_LENGTH) {
    return {
      status: "invalid",
      message: `Assistant requests are limited to ${AI_ASSISTANT_PROMPT_MAX_LENGTH.toLocaleString("en")} characters. Shorten this draft before continuing.`,
    };
  }
  return prompt ? { status: "ready", prompt } : { status: "none" };
}

export function savedViewArea(pathname: string): SavedViewArea | null {
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
  if (adminAssistantIntent(normalizedQuery)) return null;
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

import { describe, expect, it } from "vitest";
import { adminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
import type { CommandRecord } from "~/platform/operations/command-palette-service.server";
import {
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
} from "./admin-shell";

describe("administrator navigation context", () => {
  it("extracts explicit assistant drafts without treating them as record searches", () => {
    expect(adminAssistantDraft("ask Which speakers are incomplete?")).toEqual({
      status: "ready",
      prompt: "Which speakers are incomplete?",
    });
    expect(
      adminAssistantDraft(" ASK assistant:  Summarise readiness "),
    ).toEqual({ status: "ready", prompt: "Summarise readiness" });
    expect(adminAssistantDraft("ask assistant")).toEqual({ status: "none" });
    expect(adminAssistantDraft("find assistant proposals")).toEqual({
      status: "none",
    });
    expect(adminAssistantIntent("ask")).toBe(true);
    expect(adminAssistantIntent("ask:")).toBe(true);
    expect(adminAssistantIntent("askassistant status")).toBe(false);
    expect(
      adminCommandSearchKey(
        "ask Which speakers are incomplete?",
        "event",
        "event-1",
      ),
    ).toBeNull();
    expect(adminCommandSearchKey("ask:", "event", "event-1")).toBeNull();

    const boundaryPrompt = `ask ${"a".repeat(3_998)}😀`;
    const boundaryDraft = adminAssistantDraft(boundaryPrompt);
    expect(boundaryDraft).toEqual({
      status: "ready",
      prompt: `${"a".repeat(3_998)}😀`,
    });
    if (boundaryDraft.status !== "ready") {
      throw new Error("Expected the boundary assistant draft to be valid.");
    }

    expect(adminAssistantDraft(`ask ${"a".repeat(4_001)}`)).toEqual({
      status: "invalid",
      message:
        "Assistant requests are limited to 4,000 characters. Shorten this draft before continuing.",
    });
    expect(adminAssistantDraft(`ask ${"界".repeat(1_667)}`)).toEqual({
      status: "ready",
      prompt: "界".repeat(1_667),
    });
  });

  it("validates ephemeral assistant navigation drafts", () => {
    expect(adminAssistantDraftFromNavigationState(null)).toEqual({
      status: "none",
    });
    expect(
      adminAssistantDraftFromNavigationState({ unrelated: "state" }),
    ).toEqual({ status: "none" });
    expect(
      adminAssistantDraftFromNavigationState({
        assistantDraft: "Which tasks are overdue?",
      }),
    ).toEqual({
      status: "ready",
      prompt: "Which tasks are overdue?",
    });
    expect(
      adminAssistantDraftFromNavigationState({ assistantDraft: 42 }),
    ).toEqual({
      status: "invalid",
      message: "The assistant draft navigation state is invalid.",
    });
    expect(
      adminAssistantDraftFromNavigationState({
        assistantDraft: "a".repeat(4_001),
      }),
    ).toEqual({
      status: "invalid",
      message:
        "Assistant requests are limited to 4,000 characters. Shorten this draft before continuing.",
    });
  });

  it("matches command intent by normalized words in any order", () => {
    expect(
      adminCommandMatches(
        "admin invite",
        "invite add administrator admin event access role",
      ),
    ).toBe(true);
    expect(
      adminCommandMatches(
        "FORM build",
        "build edit application call for speakers cfp form builder",
      ),
    ).toBe(true);
    expect(adminCommandMatches("equipe", "Équipe evaluator access")).toBe(true);
    expect(adminCommandMatches("invite speaker", "invite administrator")).toBe(
      false,
    );
    expect(adminCommandMatches("", "anything")).toBe(true);
  });

  it("keeps an event section and current workflow in detail breadcrumbs", () => {
    expect(adminPageBreadcrumbs("/admin/submissions/form")).toEqual([
      { label: "Applications", href: "/admin/submissions" },
      { label: "Form builder", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/events/clone")).toEqual([
      { label: "Event settings", href: "/admin/event" },
      { label: "Clone event", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/events/new")).toEqual([
      { label: "Event settings", href: "/admin/event" },
      { label: "New event", href: null },
    ]);
    expect(
      adminPageBreadcrumbs("/admin/speakers/person-demo-speaker", {
        state: "resolved",
        label: "Priya Raman",
      }),
    ).toEqual([
      { label: "Speakers", href: "/admin/speakers" },
      { label: "Priya Raman", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/crm/pipeline")).toEqual([
      { label: "Speaker network", href: "/admin/crm" },
      { label: "Sourcing pipeline", href: null },
    ]);
  });

  it("projects record labels from existing detail loader data", () => {
    expect(
      adminRecordBreadcrumb([
        {
          handle: adminRecordBreadcrumbHandle(["submission", "title"]),
          loaderData: {
            submission: { title: "Designing trustworthy systems" },
          },
        },
      ]),
    ).toEqual({
      state: "resolved",
      label: "Designing trustworthy systems",
    });
    expect(() =>
      adminRecordBreadcrumb([
        {
          handle: adminRecordBreadcrumbHandle(["detail", "profile", "name"]),
          loaderData: { detail: {} },
        },
      ]),
    ).toThrow(/breadcrumb label/i);
    expect(
      adminRecordBreadcrumb([
        {
          handle: adminRecordBreadcrumbHandle(["submission", "title"]),
          loaderData: undefined,
        },
      ]),
    ).toEqual({ state: "unavailable" });
    expect(
      adminRecordBreadcrumb([
        {
          handle: adminRecordBreadcrumbHandle(["current", "title"]),
          loaderData: null,
        },
      ]),
    ).toEqual({ state: "unavailable" });
    expect(() =>
      adminPageBreadcrumbs("/admin/speakers/person-demo-speaker"),
    ).toThrow(/breadcrumb handle/i);
    expect(
      adminPageBreadcrumbs("/admin/speakers/person-demo-speaker", {
        state: "unavailable",
      }),
    ).toEqual([
      { label: "Speakers", href: "/admin/speakers" },
      { label: "Speaker", href: null },
    ]);
  });

  it("uses a single current-page crumb for a top-level workflow", () => {
    expect(adminPageBreadcrumbs("/admin/operations")).toEqual([
      { label: "Operations", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/command")).toEqual([]);
  });

  it("does not expose records from a stale query or scope", () => {
    const records: CommandRecord[] = [];
    const eventKey = adminCommandSearchKey("Priya", "event", "event-1");
    const organisationKey = adminCommandSearchKey(
      "Priya",
      "organisation",
      "event-1",
    );

    expect(eventKey).not.toBeNull();
    expect(organisationKey).not.toBe(eventKey);
    expect(
      adminCommandRecordsForKey({ key: organisationKey!, records }, eventKey),
    ).toBeNull();
    expect(
      adminCommandRecordsForKey({ key: eventKey!, records }, eventKey),
    ).toBe(records);
    expect(
      adminCommandRecordsForKey(
        { key: eventKey!, records },
        adminCommandSearchKey("Priya", "event", "event-2"),
      ),
    ).toBeNull();
    expect(adminCommandSearchKey(" p ", "event", "event-1")).toBeNull();
  });

  it("selects an organisation result's event before opening its record", () => {
    const record = {
      eventId: "event-2",
      href: "/admin/schedule?session=session-2",
    };
    expect(adminCommandRecordSelection(record, "event-1")).toEqual({
      kind: "select-event",
      eventId: "event-2",
      returnTo: "/admin/schedule?session=session-2",
    });
    expect(adminCommandRecordSelection(record, "event-2")).toEqual({
      kind: "navigate",
      href: "/admin/schedule?session=session-2",
    });
  });

  it("offers the assistant command only to roles authorised for its route", () => {
    expect(canOpenAdminAssistant("owner")).toBe(true);
    expect(canOpenAdminAssistant("administrator")).toBe(true);
    expect(canOpenAdminAssistant("committee_chair")).toBe(false);
    expect(canOpenAdminAssistant("evaluator")).toBe(false);
    expect(canOpenAdminAssistant("unexpected_role")).toBe(false);
  });

  it("keeps seven stable workspace families and their tools at the second level", () => {
    const groups = primaryNavigationGroups(NAV_ITEMS);
    expect(groups.map((group) => group.label)).toEqual([
      "Event work",
      "Administration",
    ]);
    expect(groups[0]?.items.map(([id]) => id)).toEqual([
      "command",
      "submissions",
      "speakers",
      "schedule",
      "communications",
    ]);
    expect(groups[1]?.items.map(([id]) => id)).toEqual(["event", "operations"]);
    expect(
      groups.flatMap((group) => group.items).map(([id]) => id),
    ).not.toEqual(
      expect.arrayContaining([
        "review",
        "resources",
        "crm",
        "content",
        "programme",
        "tasks",
        "branding",
        "site",
        "integrations",
        "settings",
      ]),
    );
  });

  it("promotes an authorised child explicitly and rejects unmapped items", () => {
    const review = NAV_ITEMS.find(([id]) => id === "review")!;
    expect(primaryNavigationGroups([review])).toEqual([
      { label: "Event work", items: [review] },
    ]);
    expect(() =>
      primaryNavigationGroups([
        ["unmapped", NAV_ITEMS[0][1], "Unmapped destination"],
      ]),
    ).toThrow(/not assigned to a family/i);
  });

  it("marks the section actually open, never a sibling standing in for it", () => {
    expect(primaryNavigationItemActive("content", "/admin/content")).toBe(true);
    expect(
      primaryNavigationItemActive(
        "content",
        "/admin/content/sessions/session-1",
      ),
    ).toBe(true);
    expect(primaryNavigationItemActive("speakers", "/admin/crm/pipeline")).toBe(
      false,
    );
    expect(primaryNavigationItemActive("crm", "/admin/crm/pipeline")).toBe(
      true,
    );
    expect(primaryNavigationItemActive("resources", "/admin/resources")).toBe(
      true,
    );
    expect(primaryNavigationItemActive("programme", "/admin/schedule")).toBe(
      false,
    );
    expect(primaryNavigationItemActive("schedule", "/admin/sessions/new")).toBe(
      true,
    );
  });

  it("opens the speaker family's second level anywhere inside that family", () => {
    expect(primaryNavigationItemExpanded("speakers", "/admin/speakers")).toBe(
      true,
    );
    expect(primaryNavigationItemExpanded("speakers", "/admin/resources")).toBe(
      true,
    );
    expect(
      primaryNavigationItemExpanded("speakers", "/admin/crm/pipeline"),
    ).toBe(true);
    expect(primaryNavigationItemExpanded("speakers", "/admin/schedule")).toBe(
      false,
    );
    expect(
      primaryNavigationChildren("speakers", NAV_ITEMS).map(([id]) => id),
    ).toEqual(["crm", "resources"]);
    expect(
      primaryNavigationChildren("submissions", NAV_ITEMS).map(([id]) => id),
    ).toEqual(["review"]);
    expect(
      primaryNavigationChildren("schedule", NAV_ITEMS).map(([id]) => id),
    ).toEqual(["content", "programme"]);
    expect(
      primaryNavigationChildren("communications", NAV_ITEMS).map(([id]) => id),
    ).toEqual(["tasks"]);
    expect(
      primaryNavigationChildren("event", NAV_ITEMS).map(([id]) => id),
    ).toEqual(["branding", "site"]);
  });

  it("drops a second-level tool the viewer is not authorised for", () => {
    const withoutOrganisationAccess = NAV_ITEMS.filter(([id]) => id !== "crm");
    expect(
      primaryNavigationChildren("speakers", withoutOrganisationAccess).map(
        ([id]) => id,
      ),
    ).toEqual(["resources"]);
  });
});

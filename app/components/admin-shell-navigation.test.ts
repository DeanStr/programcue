import { describe, expect, it } from "vitest";

import {
  adminCommandRecordsForKey,
  adminCommandRecordSelection,
  adminCommandSearchKey,
  adminPageBreadcrumbs,
  canOpenAdminAssistant,
  NAV_ITEMS,
  primaryNavigationChildren,
  primaryNavigationGroups,
  primaryNavigationItemActive,
  primaryNavigationItemExpanded,
} from "./admin-shell";
import type { CommandRecord } from "~/platform/operations/command-palette-service.server";

describe("administrator navigation context", () => {
  it("keeps an event section and current workflow in detail breadcrumbs", () => {
    expect(adminPageBreadcrumbs("/admin/submissions/form")).toEqual([
      { label: "Submissions", href: "/admin/submissions" },
      { label: "Form builder", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/events/clone")).toEqual([
      { label: "Event Setup", href: "/admin/event" },
      { label: "Clone event", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/events/new")).toEqual([
      { label: "Event Setup", href: "/admin/event" },
      { label: "New event", href: null },
    ]);
    expect(adminPageBreadcrumbs("/admin/speakers/person-demo-speaker")).toEqual(
      [
        { label: "Speakers", href: "/admin/speakers" },
        { label: "Speaker detail", href: null },
      ],
    );
    expect(adminPageBreadcrumbs("/admin/crm/pipeline")).toEqual([
      { label: "Speaker Network", href: "/admin/crm" },
      { label: "Sourcing pipeline", href: null },
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
  });

  it("chunks the top level by workflow phase and keeps second-level tools out of it", () => {
    const groups = primaryNavigationGroups(NAV_ITEMS);
    expect(groups.map((group) => group.label)).toEqual([
      "Core work",
      "Delivery",
      "Manage",
    ]);
    expect(groups[0]?.items.map(([id]) => id)).toEqual([
      "command",
      "event",
      "branding",
      "submissions",
      "review",
    ]);
    expect(groups[1]?.items.map(([id]) => id)).toEqual([
      "speakers",
      "schedule",
      "programme",
      "communications",
      "tasks",
      "content",
    ]);
    expect(groups[2]?.items.map(([id]) => id)).toEqual([
      "integrations",
      "operations",
      "settings",
    ]);
    expect(
      groups.flatMap((group) => group.items).map(([id]) => id),
    ).not.toEqual(expect.arrayContaining(["resources", "crm"]));
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
    expect(primaryNavigationChildren("schedule", NAV_ITEMS)).toEqual([]);
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

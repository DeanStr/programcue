import { describe, expect, it } from "vitest";

import {
  adminCommandRecordsForKey,
  adminCommandRecordSelection,
  adminCommandSearchKey,
  adminPageBreadcrumbs,
  canOpenAdminAssistant,
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
      { label: "Speaker CRM", href: "/admin/crm" },
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
});

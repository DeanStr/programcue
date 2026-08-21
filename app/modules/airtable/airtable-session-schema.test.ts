import { describe, expect, it } from "vitest";

import { AIRTABLE_SESSION_TABLE_SPECS } from "./airtable-session-schema";

function spec(key: (typeof AIRTABLE_SESSION_TABLE_SPECS)[number]["key"]) {
  const table = AIRTABLE_SESSION_TABLE_SPECS.find((entry) => entry.key === key);
  if (!table) throw new Error(`Missing Airtable session table ${key}.`);
  return table;
}

describe("Airtable session payload schemas", () => {
  it("defaults a pre-0052 schedule policy payload to blocking unavailability", () => {
    const parsed = spec("schedulePolicies").schema.parse({
      id: "evt-foe-2025",
      event_id: "evt-foe-2025",
      room_overlap_action: "block",
      speaker_overlap_action: "block",
      required_resource_overlap_action: "block",
      exclusive_track_overlap_action: "warn",
      event_boundary_action: "block",
      capacity_action: "warn",
      minimum_turnaround_minutes: 0,
      revision: 1,
      updated_at: 1_700_000_000,
    });
    expect(parsed).toMatchObject({
      speaker_unavailable_action: "block",
    });
  });

  it("still reads a pre-0052 schedule conflict that is not speaker unavailability", () => {
    const parsed = spec("scheduleConflicts").schema.parse({
      id: "conflict-room",
      event_id: "evt-foe-2025",
      schedule_version_id: "version-1",
      conflict_type: "room",
      severity: "blocking",
      fingerprint: "room:entry-a:entry-b",
      primary_entry_id: "entry-a",
      conflicting_entry_id: "entry-b",
      details_json: '{"message":"Room overlap"}',
      created_at: 1_700_000_000,
      resolved_by_person_id: null,
      resolved_at: null,
      resolution_json: null,
    });
    expect(parsed).toMatchObject({
      conflict_type: "room",
      fingerprint: "room:entry-a:entry-b",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  assessDraftSnapshot,
  createDraftRecoveryOperationGuard,
  DRAFT_RECOVERY_SCHEMA_VERSION,
  DRAFT_RECOVERY_TTL_MS,
  draftRecoveryKey,
  indexedDbDraftSnapshotStore,
  shouldPruneDraftSnapshot,
} from "./draft-recovery";

describe("draft recovery boundaries", () => {
  it("limits browser recovery retention to one day", () => {
    expect(DRAFT_RECOVERY_TTL_MS).toBe(24 * 60 * 60 * 1_000);
  });

  it("isolates snapshots by event, person, record type and record id", () => {
    const base = {
      eventId: "event-1",
      personId: "person-1",
      recordType: "review",
      recordId: "assignment-1",
    };
    const key = draftRecoveryKey(base);

    expect(draftRecoveryKey({ ...base, eventId: "event-2" })).not.toBe(key);
    expect(draftRecoveryKey({ ...base, personId: "person-2" })).not.toBe(key);
    expect(draftRecoveryKey({ ...base, recordType: "resource" })).not.toBe(key);
    expect(draftRecoveryKey({ ...base, recordId: "assignment-2" })).not.toBe(
      key,
    );
    expect(() => draftRecoveryKey({ ...base, personId: " " })).toThrow(
      "Draft recovery personId is required.",
    );
  });

  it("requires an explicit conflict choice when the server revision changed", () => {
    const now = 1_800_000_000_000;
    const snapshot = {
      schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION,
      serverRevision: "7",
      savedAt: now - 1_000,
      expiresAt: now + 60_000,
    };

    expect(assessDraftSnapshot(snapshot, 7, now)).toBe("restore_available");
    expect(assessDraftSnapshot(snapshot, 8, now)).toBe("conflict");
  });

  it("rejects expired and incompatible snapshots before considering revision", () => {
    const now = 1_800_000_000_000;
    expect(
      assessDraftSnapshot(
        {
          schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION,
          serverRevision: "1",
          savedAt: now - 1_000,
          expiresAt: now,
        },
        1,
        now,
      ),
    ).toBe("expired");
    expect(
      assessDraftSnapshot(
        {
          schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION + 1,
          serverRevision: "1",
          savedAt: now - 1_000,
          expiresAt: now + 1,
        },
        1,
        now,
      ),
    ).toBe("incompatible");
  });

  it("applies the current one-day limit to snapshots written under the old policy", () => {
    const now = 1_800_000_000_000;
    const legacySnapshot = {
      schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION,
      serverRevision: "1",
      savedAt: now - DRAFT_RECOVERY_TTL_MS - 1,
      expiresAt: now + 6 * DRAFT_RECOVERY_TTL_MS,
    };

    expect(assessDraftSnapshot(legacySnapshot, 1, now)).toBe("expired");
    expect(
      shouldPruneDraftSnapshot(
        {
          ...legacySnapshot,
          key: "legacy-key",
          eventId: "event-1",
          personId: "person-1",
          recordType: "review",
          recordId: "assignment-1",
          payload: { notes: "expired" },
          writerId: "writer-1",
        },
        now,
      ),
    ).toBe(true);
  });

  it("marks expired, incompatible and malformed stored payloads for pruning", () => {
    const now = 1_800_000_000_000;
    const snapshot = {
      key: "key",
      eventId: "event-1",
      personId: "person-1",
      recordType: "review",
      recordId: "assignment-1",
      schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION,
      serverRevision: "1",
      payload: { notes: "recover me" },
      savedAt: now - 1_000,
      expiresAt: now + 1_000,
      writerId: "writer-1",
    };

    expect(shouldPruneDraftSnapshot(snapshot, now)).toBe(false);
    expect(shouldPruneDraftSnapshot({ ...snapshot, expiresAt: now }, now)).toBe(
      true,
    );
    expect(
      shouldPruneDraftSnapshot(
        { ...snapshot, schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION + 1 },
        now,
      ),
    ).toBe(true);
    expect(shouldPruneDraftSnapshot({ payload: "orphaned" }, now)).toBe(true);
  });

  it("fails explicitly when IndexedDB is unavailable", async () => {
    await expect(indexedDbDraftSnapshotStore.get("missing")).rejects.toThrow(
      "does not provide IndexedDB",
    );
  });

  it("ignores superseded work and every completion from an older record", () => {
    const guard = createDraftRecoveryOperationGuard();
    guard.changeContext();
    const oldLoad = guard.begin("load");
    const latestLoad = guard.begin("load");
    const oldSave = guard.begin("save");

    expect(guard.isCurrent(oldLoad)).toBe(false);
    expect(guard.isCurrent(latestLoad)).toBe(true);
    expect(guard.isCurrent(oldSave)).toBe(true);

    guard.changeContext();
    expect(guard.isCurrent(latestLoad)).toBe(false);
    expect(guard.isCurrent(oldSave)).toBe(false);

    const currentSave = guard.begin("save");
    expect(guard.isCurrent(currentSave)).toBe(true);
    guard.invalidate("save");
    expect(guard.isCurrent(currentSave)).toBe(false);
  });
});

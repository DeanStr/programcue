import { describe, expect, it } from "vitest";

import {
  auditDisplaySummary,
  auditOperationId,
  decodeAuditActivityCursor,
  encodeAuditActivityCursor,
} from "./audit-contract";
import { AuditReader } from "./audit-reader.server";

describe("audit display contract", () => {
  it("renders only fields allowlisted for the exact action and metadata version", () => {
    expect(
      auditDisplaySummary("schedule.published", 1, {
        entryCount: 27,
        privateProviderPayload: "must not cross the UI boundary",
      }),
    ).toBe("Entry Count: 27");
    expect(
      auditDisplaySummary("schedule.published", 2, {
        entryCount: 27,
      }),
    ).toBeNull();
    expect(
      auditDisplaySummary("schedule.published", 0, {
        entryCount: 27,
      }),
    ).toBeNull();
    expect(() => auditDisplaySummary("schedule.published", 1, {})).toThrow(
      "Audit metadata for schedule.published does not satisfy version 1.",
    );
    expect(
      auditDisplaySummary("schedule.review_link.created", 1, {
        versionNumber: 2,
        revision: 4,
        expiresAt: 1_700_000_000,
        entryCount: 3,
        token: "must-not-display",
      }),
    ).toBe(
      "Version Number: 2 · Revision: 4 · Expires At: 1700000000 · Entry Count: 3",
    );
    expect(
      auditDisplaySummary("schedule.review_link.revoked", 1, {
        reason: "published",
        versionNumber: 2,
        revision: 4,
        token: "must-not-display",
      }),
    ).toBe("Reason: published · Version Number: 2 · Revision: 4");
    expect(
      auditDisplaySummary("unknown.action", 1, { revision: 4 }),
    ).toBeNull();
  });

  it("binds activity cursors to the complete tenant scope and filter set", () => {
    const binding = {
      scope: "event" as const,
      organisationId: "organisation-a",
      eventId: "event-a",
      area: "schedule",
      actorKey: "person:person-a",
      query: "published",
    };
    const cursor = encodeAuditActivityCursor(binding, {
      createdAt: 100,
      id: "audit-a",
    });
    expect(decodeAuditActivityCursor(cursor, binding)).toEqual({
      createdAt: 100,
      id: "audit-a",
    });
    expect(() =>
      decodeAuditActivityCursor(cursor, { ...binding, eventId: "event-b" }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("does not interpret pre-contract metadata as an operation link", () => {
    const metadata = { operationId: "operation-a" };
    expect(auditOperationId("integration.run.created", 0, metadata)).toBeNull();
    expect(auditOperationId("integration.run.created", 1, metadata)).toBe(
      "operation-a",
    );
    expect(() =>
      auditOperationId("integration.run.created", 1, { operationId: "" }),
    ).toThrow("contains an invalid operation ID");
    expect(
      auditOperationId("submission.revised", 1, {
        operationId: "untrusted-operation",
      }),
    ).toBeNull();
  });
});

describe("audit reader input contract", () => {
  const reader = new AuditReader({} as CloudflareEnvironment);
  const scope = { organisationId: "organisation-a", eventId: "event-a" };
  const base = { entityType: "submission", entityId: "submission-a" };

  it("rejects invalid limits and action filters before querying storage", async () => {
    await expect(
      reader.eventEntityHistory(scope, { ...base, limit: 0 }),
    ).rejects.toThrow("integer from 1 to 100");
    await expect(
      reader.eventEntityHistory(scope, {
        ...base,
        actions: ["submission.revised", "submission.revised"],
      }),
    ).rejects.toThrow("actions must be unique");
    await expect(
      reader.eventEntityHistory(scope, {
        ...base,
        actions: ["submission.revised"],
        actionPrefix: "submission.",
      }),
    ).rejects.toThrow("either audit actions or an action prefix");
  });
});

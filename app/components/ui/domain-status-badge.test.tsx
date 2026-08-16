import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DomainStatusBadge,
  STATUS_PRESENTATIONS,
  statusPresentation,
  type StatusPresentation,
} from "./domain-status-badge";

describe("controlled status presentation", () => {
  it("uses one user-facing label for legacy and canonical review states", () => {
    expect(statusPresentation("submission", "in_review").label).toBe(
      "Under review",
    );
    expect(statusPresentation("submission", "under_review").label).toBe(
      "Under review",
    );
  });

  it("renders text and an accessible status name independent of colour", () => {
    const markup = renderToStaticMarkup(
      <DomainStatusBadge domain="operation" status="queue_failed" />,
    );
    expect(markup).toContain("Queue failed");
    expect(markup).toContain('aria-label="Queue failed status"');
    expect(markup).toContain('data-status-value="queue_failed"');
  });

  it("rejects an unsupported stored status", () => {
    expect(() => statusPresentation("task", "done-ish")).toThrow();
  });

  it("words every status as a phrase rather than its stored value", () => {
    const domains: Array<[string, Record<string, StatusPresentation>]> =
      Object.entries(STATUS_PRESENTATIONS);
    const stored: string[] = [];
    for (const [domain, statuses] of domains) {
      for (const [status, { label }] of Object.entries(statuses)) {
        if (!/^[A-Z]/u.test(label) || /[_.]/u.test(label))
          stored.push(`${domain}.${status} → ${label}`);
      }
    }
    expect(stored).toEqual([]);
  });
});

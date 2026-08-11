import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DomainStatusBadge, statusPresentation } from "./domain-status-badge";

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

  it("fails fast when a surface tries to invent a status label", () => {
    expect(() => statusPresentation("task", "done-ish")).toThrow(
      "Unsupported task status: done-ish.",
    );
  });
});

import { describe, expect, it } from "vitest";

import type { Viewer } from "./authorize.server";
import {
  hasRecentAuthentication,
  requireRecentAuthentication,
} from "./recent-authentication.server";

const viewer: Viewer = {
  personId: "person-1",
  name: "Programme owner",
  email: "owner@example.com",
  role: "owner",
  organisationId: "organisation-1",
  eventId: "event-1",
  demo: false,
};

describe("privileged recent authentication", () => {
  it("accepts a real session created within the fifteen-minute window", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    expect(
      hasRecentAuthentication(
        {
          ...viewer,
          authenticationCreatedAt: new Date(now - 14 * 60 * 1_000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("redirects a stale session to an explicit sign-in-again handoff", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    let response: Response | null = null;
    try {
      requireRecentAuthentication(
        new Request("https://app.programcue.com/admin/api?tab=webhooks"),
        {
          ...viewer,
          authenticationCreatedAt: new Date(now - 16 * 60 * 1_000),
        },
        now,
      );
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Fapi%3Ftab%3Dwebhooks&reauthenticate=true",
    );
  });

  it("keeps the explicitly non-production identities frictionless", () => {
    expect(hasRecentAuthentication({ ...viewer, demo: true })).toBe(true);
    expect(hasRecentAuthentication({ ...viewer, evaluation: true })).toBe(true);
  });
});

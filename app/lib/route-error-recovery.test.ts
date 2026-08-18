import { describe, expect, it } from "vitest";

import {
  routeErrorRecovery,
  sanitizeRouteErrorMessage,
  shouldOfferErrorRetry,
} from "./route-error-recovery";

describe("routeErrorRecovery", () => {
  it("sends evaluation 404s and 403s back to the persona guide", () => {
    expect(
      routeErrorRecovery({
        status: 404,
        pathname: "/apply/evaluation-demo",
        evaluation: true,
      }),
    ).toEqual({ href: "/evaluate", label: "Choose an evaluation persona" });
    expect(
      routeErrorRecovery({
        status: 403,
        pathname: "/admin/command",
        evaluation: true,
      }),
    ).toEqual({ href: "/evaluate", label: "Choose an evaluation persona" });
  });

  it("does not send a public 404 to Command Centre", () => {
    expect(
      routeErrorRecovery({
        status: 404,
        pathname: "/public/programme/future-of-events-2027/pages/faq",
        evaluation: false,
      }),
    ).toEqual({ href: "/", label: "Go to home" });
  });

  it("keeps loaded administrator context on the command centre", () => {
    expect(
      routeErrorRecovery({
        status: 403,
        pathname: "/admin/review",
        evaluation: false,
        adminContextLoaded: true,
      }),
    ).toEqual({ href: "/admin/command", label: "Go to Command Centre" });
  });

  it("sends 401s to sign-in, or the persona guide in evaluation", () => {
    expect(
      routeErrorRecovery({
        status: 401,
        pathname: "/admin/command",
        evaluation: false,
        adminContextLoaded: true,
      }),
    ).toEqual({ href: "/sign-in", label: "Sign in" });
    expect(
      routeErrorRecovery({
        status: 401,
        pathname: "/apply/future-of-events-2027",
        evaluation: true,
      }),
    ).toEqual({ href: "/evaluate", label: "Choose an evaluation persona" });
    expect(shouldOfferErrorRetry(401)).toBe(false);
  });

  it("hides retry on permission and missing-page errors", () => {
    expect(shouldOfferErrorRetry(403)).toBe(false);
    expect(shouldOfferErrorRetry(404)).toBe(false);
    expect(shouldOfferErrorRetry(500)).toBe(true);
  });

  it("strips React Router internals from 404 copy", () => {
    expect(
      sanitizeRouteErrorMessage(404, 'Error: No route matches URL "/admin"'),
    ).toBe("That page does not exist, or the link has changed.");
  });
});

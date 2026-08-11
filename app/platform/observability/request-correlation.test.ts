import { describe, expect, it } from "vitest";

import { requestCorrelationId } from "./request-correlation";

describe("request correlation", () => {
  it("prefers a valid Cloudflare Ray ID over a caller identifier", () => {
    const request = new Request("https://programcue.test/api/v1/health", {
      headers: {
        "cf-ray": "8f1234567890abcd-LHR",
        "x-correlation-id": "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
      },
    });

    expect(requestCorrelationId(request)).toBe("8f1234567890abcd-LHR");
  });

  it("accepts a machine-shaped caller UUID", () => {
    const request = new Request("https://programcue.test/api/v1/health", {
      headers: {
        "x-correlation-id": "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
      },
    });

    expect(requestCorrelationId(request)).toBe(
      "74a367c9-21d1-4e2b-8da8-5b955c395fa8",
    );
  });

  it.each([
    "short",
    "caller.request:001",
    "person@example.test",
    "contains spaces and personal text",
    "a".repeat(129),
  ])("replaces unsafe caller correlation value %s", (candidate) => {
    const request = new Request("https://programcue.test/api/v1/health", {
      headers: { "x-correlation-id": candidate },
    });

    expect(requestCorrelationId(request)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

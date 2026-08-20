import { describe, expect, it } from "vitest";
import { isHtmlDocumentRequest } from "./html-navigation";

describe("isHtmlDocumentRequest", () => {
  it("treats browser navigations as documents", () => {
    expect(
      isHtmlDocumentRequest(
        new Request("https://app.programcue.com/admin/search", {
          headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
        }),
      ),
    ).toBe(true);
  });

  it("treats XHR and fetch as data requests", () => {
    expect(
      isHtmlDocumentRequest(
        new Request("https://app.programcue.com/admin/search", {
          headers: { "sec-fetch-mode": "cors", accept: "application/json" },
        }),
      ),
    ).toBe(false);
    expect(
      isHtmlDocumentRequest(
        new Request("https://app.programcue.com/admin/search", {
          headers: { "sec-fetch-mode": "same-origin", accept: "text/html" },
        }),
      ),
    ).toBe(false);
  });

  it("falls back to the Accept header when fetch mode is absent", () => {
    expect(
      isHtmlDocumentRequest(
        new Request("https://app.programcue.com/admin/search", {
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe(true);
    expect(
      isHtmlDocumentRequest(
        new Request("https://app.programcue.com/admin/search", {
          headers: { accept: "application/json" },
        }),
      ),
    ).toBe(false);
  });
});

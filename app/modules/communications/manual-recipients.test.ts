import { describe, expect, it } from "vitest";
import { namedRecipient, parseManualRecipients } from "./manual-recipients";

describe("named communication recipients", () => {
  it("retains punctuation without creating additional recipients", () => {
    const name = 'Sam "SJ" Whitfield, Jr.; <Chair>';
    expect(
      parseManualRecipients(
        [
          namedRecipient(name, "sam@example.com"),
          namedRecipient("Priya Raman", "priya@example.com"),
        ].join("\n"),
      ),
    ).toEqual([
      { name, address: "sam@example.com" },
      { name: "Priya Raman", address: "priya@example.com" },
    ]);
  });

  it("accepts existing plain and named recipient lists", () => {
    expect(
      parseManualRecipients(
        "sam@example.com; Priya Raman <priya@example.com>, marcus@example.com",
      ),
    ).toEqual([
      { name: null, address: "sam@example.com" },
      { name: "Priya Raman", address: "priya@example.com" },
      { name: null, address: "marcus@example.com" },
    ]);
  });

  it("rejects generated recipients containing line breaks", () => {
    expect(() =>
      namedRecipient("Sam\nSomeone Else", "sam@example.com"),
    ).toThrow("single email address");
    expect(() =>
      namedRecipient("Sam", "sam@example.com\nother@example.com"),
    ).toThrow("single email address");
  });
});

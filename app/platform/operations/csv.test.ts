import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";

describe("CSV parser", () => {
  it("parses quoted delimiters, escaped quotes and newlines", () => {
    expect(
      parseCsv('name,description\r\n"Ada, A.","Line one\nLine ""two"""\r\n'),
    ).toEqual({
      headers: ["name", "description"],
      rows: [{ name: "Ada, A.", description: 'Line one\nLine "two"' }],
    });
  });

  it("rejects malformed widths and unterminated quoted values", () => {
    expect(() => parseCsv("a,b\n1")).toThrow("expected 2");
    expect(() => parseCsv('a,b\n"1,2')).toThrow("quoted field");
    expect(() => parseCsv('name,email\n"Ada"x,ada@example.com')).toThrow(
      "text after a closing quote",
    );
  });
});

import { describe, expect, it } from "vitest";

import { matchingCsvHeader, parseCsv } from "./csv";

describe("CSV parser", () => {
  it("parses quoted delimiters, escaped quotes and newlines", () => {
    expect(
      parseCsv('name,description\r\n"Ada, A.","Line one\nLine ""two"""\r\n'),
    ).toEqual({
      headers: ["name", "description"],
      rows: [{ name: "Ada, A.", description: 'Line one\nLine "two"' }],
    });
  });

  it("preserves camelCase headers used by export and data-import schemas", () => {
    expect(
      parseCsv("roundId,jobTitle,durationMinutes\nround-1,Director,60\n"),
    ).toEqual({
      headers: ["roundId", "jobTitle", "durationMinutes"],
      rows: [
        { roundId: "round-1", jobTitle: "Director", durationMinutes: "60" },
      ],
    });
  });

  it("matches roster and CRM aliases without regard to header capitalisation", () => {
    const parsed = parseCsv("Name,Email,JobTitle\nAda,ada@example.com,CTO\n");
    expect(matchingCsvHeader(parsed.headers, ["name", "speaker"])).toBe("Name");
    expect(matchingCsvHeader(parsed.headers, ["email", "email_address"])).toBe(
      "Email",
    );
    expect(
      matchingCsvHeader(parsed.headers, ["title", "jobTitle", "job_title"]),
    ).toBe("JobTitle");
    expect(
      parsed.rows[0]?.[matchingCsvHeader(parsed.headers, ["jobTitle"])!],
    ).toBe("CTO");
  });

  it("rejects headers that differ only by capitalisation", () => {
    expect(() => parseCsv("Name,name\nAda,ada@example.com\n")).toThrow(
      /capitalisation/i,
    );
  });

  it("rejects malformed widths and unterminated quoted values", () => {
    expect(() => parseCsv("a,b\n1")).toThrow("expected 2");
    expect(() => parseCsv('a,b\n"1,2')).toThrow("quoted field");
    expect(() => parseCsv('name,email\n"Ada"x,ada@example.com')).toThrow(
      "text after a closing quote",
    );
  });
});

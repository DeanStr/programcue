import { describe, expect, it } from "vitest";

import {
  submissionReferenceClipboard,
  undoRemainingLabel,
  undoRemainingMilliseconds,
} from "./operational-ui-rules";

describe("operational UI rules", () => {
  it("copies the selected applications in visible order as safe tab-separated references", () => {
    expect(
      submissionReferenceClipboard([
        { publicReference: "PC-002", title: "Second\tapplication" },
        { publicReference: "PC-001", title: "First\napplication" },
        {
          publicReference: "+PC-003",
          title: '  =HYPERLINK("https://example.test")',
        },
      ]),
    ).toBe(
      "Reference\tApplication\nPC-002\tSecond application\nPC-001\tFirst application\n'+PC-003\t'=HYPERLINK(\"https://example.test\")",
    );
  });

  it("fails fast when copying is requested without a selection", () => {
    expect(() => submissionReferenceClipboard([])).toThrow(
      "Select at least one application",
    );
  });

  it("keeps undo feedback bounded by the authoritative expiry", () => {
    expect(undoRemainingMilliseconds(1_300, 1_000_001)).toBe(299_999);
    expect(undoRemainingLabel(299_999)).toBe("5m 00s left");
    expect(undoRemainingMilliseconds(1_000, 1_000_001)).toBe(0);
    expect(undoRemainingLabel(0)).toBe("Undo window expired");
  });
});

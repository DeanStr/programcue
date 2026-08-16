import { describe, expect, it } from "vitest";

import {
  clearedPublicProgrammeFacetMessage,
  clearUnavailablePublicProgrammeFacets,
} from "./public-programme-filter-state";

const available = {
  day: ["Monday, May 10"],
  track: ["Operations"],
  format: ["Workshop"],
  room: ["Main stage"],
};

describe("public programme saved facets", () => {
  it("removes only unavailable facets and preserves other URL state", () => {
    const result = clearUnavailablePublicProgrammeFacets(
      new URLSearchParams(
        "day=Old+date&track=Operations&format=Retired&query=keynote&speaker=person-1",
      ),
      available,
    );

    expect(result.cleared).toEqual(["day", "format"]);
    expect(result.search.get("day")).toBeNull();
    expect(result.search.get("format")).toBeNull();
    expect(result.search.get("track")).toBe("Operations");
    expect(result.search.get("query")).toBe("keynote");
    expect(result.search.get("speaker")).toBe("person-1");
    expect(clearedPublicProgrammeFacetMessage(result.cleared)).toBe(
      "Saved day, format filters are no longer available and were cleared.",
    );
  });
});

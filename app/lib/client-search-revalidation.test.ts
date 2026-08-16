import { describe, expect, it } from "vitest";

import {
  onlyClientSearchParametersChanged,
  PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS,
  SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
} from "./client-search-revalidation";

describe("client-owned URL filter revalidation", () => {
  it("skips public loader work for client filters but not speaker shares", () => {
    const current = new URL(
      "https://example.test/public/programme/event?track=Current",
    );
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL(
          "https://example.test/public/programme/event?track=Next&query=keynote",
        ),
        PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(true);
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL(
          "https://example.test/public/programme/event?track=Next&speaker=person-1",
        ),
        PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(false);
  });

  it("keeps schedule loader work for server-owned focus parameters", () => {
    const current = new URL("https://example.test/admin/schedule?filter=draft");
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL(
          "https://example.test/admin/schedule?filter=draft&sourceQuery=panel",
        ),
        SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(true);
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL(
          "https://example.test/admin/schedule?filter=conflicts&sourceQuery=panel",
        ),
        SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(false);
  });

  it("does not suppress path changes or unchanged searches", () => {
    const current = new URL("https://example.test/admin/schedule");
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL("https://example.test/admin/schedule"),
        SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(false);
    expect(
      onlyClientSearchParametersChanged(
        current,
        new URL("https://example.test/admin/other?sourceQuery=panel"),
        SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
      ),
    ).toBe(false);
  });
});

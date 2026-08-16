import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventDateRangeFields } from "./event-date-range-fields";

describe("EventDateRangeFields", () => {
  it("renders a valid initial event range", () => {
    const markup = renderToStaticMarkup(
      <EventDateRangeFields
        initialStartDate="2027-05-10"
        initialEndDate="2027-05-12"
      />,
    );
    expect(markup).toContain('value="2027-05-10"');
    expect(markup).toContain('value="2027-05-12"');
  });

  it("fails fast when the initial event dates are corrupt", () => {
    expect(() =>
      renderToStaticMarkup(
        <EventDateRangeFields
          initialStartDate="2027-02-30"
          initialEndDate="2027-03-02"
        />,
      ),
    ).toThrow("Initial event start date must be a valid ISO calendar date.");

    expect(() =>
      renderToStaticMarkup(
        <EventDateRangeFields
          initialStartDate="2027-05-12"
          initialEndDate="2027-05-10"
        />,
      ),
    ).toThrow("Initial event end date cannot be before the initial start date.");
  });
});

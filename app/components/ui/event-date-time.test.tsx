import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventDateTime, formatEventDateTime } from "./event-date-time";

describe("event timestamp presentation", () => {
  it("formats the same instant in the configured event timezone", () => {
    const epoch = Date.parse("2027-03-14T07:30:00Z") / 1_000;
    expect(
      formatEventDateTime(epoch, "America/Toronto", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    ).toContain("3:30 AM");
  });

  it("exposes an exact event-local timestamp to hover, focus and assistive technology", () => {
    const epoch = Date.parse("2027-11-07T06:30:00Z") / 1_000;
    const markup = renderToStaticMarkup(
      <EventDateTime epochSeconds={epoch} timeZone="America/Toronto">
        1:30 AM
      </EventDateTime>,
    );

    expect(markup).toContain('dateTime="2027-11-07T06:30:00.000Z"');
    expect(markup).toContain(
      'data-exact-time="November 7, 2027 at 1:30:00 AM EST (America/Toronto)"',
    );
    expect(markup).toContain(
      '<span class="sr-only">November 7, 2027 at 1:30:00 AM EST (America/Toronto)</span>',
    );
    expect(markup).toContain('<span aria-hidden="true">1:30 AM</span>');
    expect(markup).toContain('tabindex="0"');
  });

  it("fails instead of silently formatting without an event timezone", () => {
    expect(() => formatEventDateTime(1_800_000_000, "")).toThrow(
      "An IANA event timezone is required",
    );
  });
});

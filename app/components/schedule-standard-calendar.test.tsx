import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ScheduleStandardEventContent,
  scheduleStandardFirstDay,
} from "./schedule-standard-calendar";

describe("standard schedule calendar presentation", () => {
  it("renders event time and title in stable wrapping hooks", () => {
    const markup = renderToStaticMarkup(
      <ScheduleStandardEventContent
        event={{ title: "Community and Connection · Studio B" }}
        timeText="9:30 AM"
        timeClass="fc-generated-time"
        titleClass="fc-generated-title"
      />,
    );

    expect(markup).toContain('class="schedule-standard-event-content"');
    expect(markup).toContain(
      'class="schedule-standard-event-time fc-generated-time"',
    );
    expect(markup).toContain(
      'class="schedule-standard-event-title fc-generated-title"',
    );
    expect(markup).toContain("9:30 AM");
    expect(markup).toContain("Community and Connection · Studio B");
  });

  it("starts a conference week on the event's first calendar day", () => {
    expect(
      scheduleStandardFirstDay(Date.UTC(2025, 4, 20, 9, 0, 0) / 1_000),
    ).toBe(2);
  });
});

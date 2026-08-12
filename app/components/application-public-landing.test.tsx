import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicApplicationLanding } from "./application-public-landing";
import { DEFAULT_FORM_SCHEMA } from "~/modules/submissions/submission-schema";

describe("public application landing", () => {
  it("renders UTC event-date markers without shifting them in western timezones", () => {
    const markup = renderToStaticMarkup(
      <PublicApplicationLanding
        form={{
          name: "Call for proposals",
          eventName: "Example summit",
          eventSlug: "example-summit",
          eventTimezone: "America/New_York",
          eventStartsAt: Date.parse("2025-05-20T00:00:00Z") / 1_000,
          eventEndsAt: Date.parse("2025-05-22T00:00:00Z") / 1_000,
          eventVenue: null,
          eventCity: null,
          eventDescription: null,
          closesAt: null,
          minSpeakers: 1,
          maxSpeakers: 2,
          accessMode: "email_verified",
          allowAnonymousDrafts: false,
          version: { schema: DEFAULT_FORM_SCHEMA, versionNumber: 1 },
        }}
        accepting
        availabilityReason={null}
        featuredSpeakers={[]}
        programmeUrl={null}
        accessPanel={<p>Apply now</p>}
      />,
    );

    expect(markup).toContain("May 20, 2025 – May 22, 2025");
    expect(markup).not.toContain("May 19, 2025");
  });
});

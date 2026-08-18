import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_SCHEMA } from "~/modules/submissions/submission-schema";
import { PublicApplicationLanding } from "./application-public-landing";

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
          participantWelcomeText: "Welcome from the event team.",
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
    expect(markup).toContain("Welcome from the event team.");
    expect(markup).toContain('href="#apply"');
    expect(markup).toContain("Continue to application");
    expect(markup).not.toContain(">Start application</a>");
    expect(markup).toContain(
      "How a small programme team removed three weeks of manual work",
    );
    expect(markup).not.toContain("https://…");
  });

  it("renders an authored field example instead of inventing or hiding it", () => {
    const markup = renderToStaticMarkup(
      <PublicApplicationLanding
        form={{
          name: "Call for proposals",
          eventName: "Example summit",
          eventSlug: "example-summit",
          eventTimezone: "UTC",
          eventStartsAt: Date.parse("2025-05-20T00:00:00Z") / 1_000,
          eventEndsAt: Date.parse("2025-05-22T00:00:00Z") / 1_000,
          eventVenue: null,
          eventCity: null,
          eventDescription: null,
          participantWelcomeText: null,
          closesAt: null,
          minSpeakers: 1,
          maxSpeakers: 1,
          accessMode: "email_verified",
          allowAnonymousDrafts: false,
          version: {
            schema: {
              ...DEFAULT_FORM_SCHEMA,
              fields: DEFAULT_FORM_SCHEMA.fields.map((field) =>
                field.id === "video"
                  ? { ...field, example: "https://youtu.be/unlisted-preview" }
                  : field,
              ),
            },
            versionNumber: 1,
          },
        }}
        accepting
        availabilityReason={null}
        featuredSpeakers={[]}
        programmeUrl={null}
        accessPanel={<p>Apply now</p>}
      />,
    );

    expect(markup).toContain("https://youtu.be/unlisted-preview");
  });
});

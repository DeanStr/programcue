import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  CalendarAdministration,
  CommunicationRecipientIdentity,
} from "./communications-centre-panels";
import {
  CommunicationDraftPreview,
  deliveryActionLabel,
} from "./communication-draft-preview";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";

describe("communications presentation", () => {
  it("uses grammatically correct delivery labels", () => {
    expect(deliveryActionLabel("Schedule", 1)).toBe("Schedule 1 delivery");
    expect(deliveryActionLabel("Schedule", 2)).toBe("Schedule 2 deliveries");
    expect(deliveryActionLabel("Confirm", 1)).toBe("Confirm 1 delivery");
    expect(deliveryActionLabel("Confirm", 0)).toBe("Confirm 0 deliveries");
  });

  it("renders an invitation recipient name and email on distinct lines", () => {
    const markup = renderToStaticMarkup(
      <CommunicationRecipientIdentity
        name="Priya Shah"
        email="priya@example.com"
      />,
    );

    expect(markup).toBe(
      '<div class="comms-recipient-identity"><div class="comms-recipient-name"><strong>Priya Shah</strong></div><div class="comms-recipient-email"><small>priya@example.com</small></div></div>',
    );
  });

  it("labels every published-session invitation field in the responsive card", () => {
    const loaderData = {
      eventTimezone: "UTC",
      connections: [],
      calendarTargets: [
        {
          sessionId: "session-1",
          sessionTitle: "Opening keynote",
          personId: "person-1",
          personName: "Priya Shah",
          email: "priya@example.com",
          invitationId: null,
          method: null,
          invitationStatus: null,
          sequenceNumber: null,
          invitationConnectionId: null,
          invitationProvider: null,
          rsvpStatus: null,
          activeConnectionId: null,
          activeProvider: null,
        },
      ],
    } as unknown as CommunicationsCentreLoaderData;
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CalendarAdministration
              loaderData={loaderData}
              working={false}
              pendingIntent={null}
            />
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('data-label="Session"');
    expect(markup).toContain('data-label="Speaker"');
    expect(markup).toContain('data-label="Current state"');
    expect(markup).toContain('data-label="Actions"');
    expect(markup).toContain('class="pc-record-action-cell"');
  });

  it("isolates tenant-authored email preview HTML from the application origin", () => {
    const preview = {
      recipients: {
        selected: 1,
        deliverable: [{ name: "Priya Shah", address: "priya@example.com" }],
        suppressed: [],
        invalid: [],
      },
      rendered: { html: "<script>window.parent.pwned = true</script>" },
      provider: { configured: true, queueConfigured: true },
      confirmation: {
        recipientFingerprint: "recipients",
        deliverableFingerprint: "deliverable",
        suppressedCount: 0,
      },
    } as unknown as Parameters<typeof CommunicationDraftPreview>[0]["preview"];
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunicationDraftPreview
              preview={preview}
              revision={1}
              scheduledAt={null}
              eventTimezone="UTC"
              working={false}
              pendingIntent={null}
              configurationDirty={false}
            />
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });
});

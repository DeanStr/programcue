import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre";
import {
  CommunicationDraftPreview,
  deliveryActionLabel,
} from "./communication-draft-preview";
import { CalendarAdministration } from "./communications-calendar-panels";
import { TemplatePreview } from "./communications-template-panels";

describe("communications presentation", () => {
  it("uses grammatically correct delivery labels", () => {
    expect(deliveryActionLabel("Schedule", 1)).toBe("Schedule 1 delivery");
    expect(deliveryActionLabel("Schedule", 2)).toBe("Schedule 2 deliveries");
    expect(deliveryActionLabel("Confirm", 1)).toBe("Confirm 1 delivery");
    expect(deliveryActionLabel("Confirm", 0)).toBe("Confirm 0 deliveries");
  });

  it("previews the product-owned action for submission confirmations", () => {
    const markup = renderToStaticMarkup(
      <TemplatePreview
        draft={{
          name: "Application received",
          category: "submission_confirmation",
          subject: "We received your application",
          body: "Thanks for applying.",
          physicalAddress: "100 Programme Way",
          buttonText: "Stale organizer button",
          buttonUrl: "https://example.test/stale",
        }}
      />,
    );

    expect(markup).toContain("Manage application");
    expect(markup).toContain("Exact application URL generated when sent");
    expect(markup).not.toContain("Stale organizer button");
    expect(markup).not.toContain("https://example.test/stale");
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

  it("offers every connected calendar provider owned by a scheduled speaker", () => {
    const loaderData = {
      connections: [
        {
          id: "google-connection",
          personId: "speaker",
          personName: "Test Speaker",
          email: "speaker@example.com",
          provider: "google",
          accountReference: "google-account",
          status: "connected",
          expiresAt: null,
          lastSyncedAt: null,
          updatedAt: 1,
        },
        {
          id: "microsoft-connection",
          personId: "speaker",
          personName: "Test Speaker",
          email: "speaker@example.com",
          provider: "microsoft",
          accountReference: "microsoft-account",
          status: "connected",
          expiresAt: null,
          lastSyncedAt: null,
          updatedAt: 2,
        },
      ],
      calendarTargets: [
        {
          sessionId: "acceptance-session",
          sessionTitle: "Calendar provider acceptance",
          personId: "speaker",
          personName: "Test Speaker",
          email: "speaker@example.com",
          participationStatus: "confirmed",
          invitationId: null,
          method: null,
          invitationStatus: null,
          sequenceNumber: null,
          invitationConnectionId: null,
          invitationProvider: null,
          rsvpStatus: null,
          activeConnectionId: "google-connection",
          activeProvider: "google",
        },
        {
          sessionId: "cancelled-session",
          sessionTitle: "Cancelled calendar provider acceptance",
          personId: "speaker",
          personName: "Test Speaker",
          email: "speaker@example.com",
          participationStatus: "confirmed",
          invitationId: "cancelled-invitation",
          method: "CANCEL",
          invitationStatus: "cancelled",
          sequenceNumber: 2,
          invitationConnectionId: "google-connection",
          invitationProvider: "google",
          rsvpStatus: null,
          activeConnectionId: "google-connection",
          activeProvider: "google",
        },
      ],
      eventTimezone: "UTC",
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

    expect(markup).toContain("Send to Google Calendar");
    expect(markup).toContain("Send to Microsoft Outlook");
    expect(markup).toContain('value="google-connection"');
    expect(markup).toContain('value="microsoft-connection"');
    expect(markup).not.toContain("Update Google Calendar");
    expect(markup).not.toContain("Update Microsoft Outlook");
  });

  it("offers cancellation but no request or update for declined invitation history", () => {
    const loaderData = {
      connections: [],
      calendarTargets: [
        {
          sessionId: "declined-session",
          sessionTitle: "Declined session",
          personId: "declined-speaker",
          personName: "Declined Speaker",
          email: "declined@example.com",
          participationStatus: "declined",
          invitationId: "historical-invitation",
          method: "REQUEST",
          invitationStatus: "sent",
          sequenceNumber: 0,
          invitationConnectionId: null,
          invitationProvider: "google",
          rsvpStatus: null,
          activeConnectionId: null,
          activeProvider: null,
        },
      ],
      eventTimezone: "UTC",
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

    expect(markup).toContain("Cancel invitation");
    expect(markup).toContain("Participation Declined");
    expect(markup).not.toContain("Email the invitation");
    expect(markup).not.toContain("Email an update");
    expect(markup).not.toContain("Update Google Calendar");
    expect(markup).not.toContain("Reconcile RSVP");
  });
});

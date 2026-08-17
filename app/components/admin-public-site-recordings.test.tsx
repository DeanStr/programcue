import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";
import { AdminPublicSiteRecordings } from "./admin-public-site-recordings";

const publishedRecording: PublicRecordingWorkspaceItem = {
  id: "recording-1",
  sessionId: "session-1",
  sessionTitle: "Opening keynote",
  draftTitle: "Opening keynote recording",
  draftRecordingUrl: "https://video.example.test/opening-keynote",
  draftCaptionsUrl: null,
  draftTranscriptUrl: null,
  draftRevision: 2,
  publishedTitle: "Opening keynote recording",
  publishedRecordingUrl: "https://video.example.test/opening-keynote",
  publishedCaptionsUrl: null,
  publishedTranscriptUrl: null,
  publishedRevision: 2,
  publishedAt: 1,
  lastOperationId: "operation-1",
};

function button(markup: string, label: string) {
  return [...markup.matchAll(/<button[^>]*>[\s\S]*?<\/button>/gu)]
    .map(([match]) => match)
    .find((match) => match.includes(label));
}

describe("public-site recording controls", () => {
  it("keeps urgent withdrawal available while site-editor changes are unsaved", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/admin/site",
          element: (
            <AdminPublicSiteRecordings
              recordings={[publishedRecording]}
              programme={null}
              programmeFeaturesAvailable
              blocked
              busy={false}
              onPublish={() => undefined}
              onUnpublish={() => undefined}
            />
          ),
        },
      ],
      { initialEntries: ["/admin/site"] },
    );
    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(button(markup, "Save recording draft")).toContain("disabled");
    expect(button(markup, "Withdraw")).not.toContain("disabled");
  });

  it("fails closed for Airtable editing while retaining withdrawal", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/admin/site",
          element: (
            <AdminPublicSiteRecordings
              recordings={[publishedRecording]}
              programme={null}
              programmeFeaturesAvailable={false}
              blocked={false}
              busy={false}
              onPublish={() => undefined}
              onUnpublish={() => undefined}
            />
          ),
        },
      ],
      { initialEntries: ["/admin/site"] },
    );
    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain(
      "unavailable for this event&#x27;s programme source",
    );
    expect(button(markup, "Save recording draft")).toContain("disabled");
    expect(button(markup, "Publish update")).toContain("disabled");
    expect(button(markup, "Withdraw")).not.toContain("disabled");
  });
});

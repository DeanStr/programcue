import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";
import { defaultPublicSiteDraft } from "~/modules/public-site/public-site";
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

function disclosure(markup: string, title: string) {
  return [...markup.matchAll(/<details[^>]*>[\s\S]*?<\/details>/gu)]
    .map(([match]) => match)
    .find((match) => match.includes(title));
}

function renderRecordings({
  recordings = [publishedRecording],
  programmeFeaturesAvailable = true,
  blockedReason = null,
}: {
  recordings?: PublicRecordingWorkspaceItem[];
  programmeFeaturesAvailable?: boolean;
  blockedReason?: string | null;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/admin/site",
        element: (
          <AdminPublicSiteRecordings
            recordings={recordings}
            programme={null}
            programmeFeaturesAvailable={programmeFeaturesAvailable}
            configuration={defaultPublicSiteDraft()}
            setConfiguration={() => undefined}
            blockedReason={blockedReason}
            busy={false}
            hidden={false}
            onPublish={() => undefined}
            onUnpublish={() => undefined}
          />
        ),
      },
    ],
    { initialEntries: ["/admin/site"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("public-site recording controls", () => {
  it("keeps urgent withdrawal available while site-editor changes are unsaved", () => {
    const markup = renderRecordings({
      blockedReason: "Save the website draft changes first.",
    });

    expect(button(markup, "Save recording draft")).toContain("disabled");
    expect(button(markup, "Withdraw")).not.toContain("disabled");
  });

  it("distinguishes draft-only, current, and changed published recordings", () => {
    const changedRecording = {
      ...publishedRecording,
      id: "recording-changed",
      sessionId: "session-changed",
      sessionTitle: "Updated session",
      draftRevision: 3,
    };
    const draftOnlyRecording = {
      ...publishedRecording,
      id: "recording-draft",
      sessionId: "session-draft",
      sessionTitle: "Draft session",
      publishedTitle: null,
      publishedRecordingUrl: null,
      publishedCaptionsUrl: null,
      publishedTranscriptUrl: null,
      publishedRevision: null,
      publishedAt: null,
    };
    const markup = renderRecordings({
      recordings: [publishedRecording, changedRecording, draftOnlyRecording],
    });

    expect(disclosure(markup, "Opening keynote")).toContain("Published");
    expect(disclosure(markup, "Updated session")).toContain("Changes waiting");
    expect(disclosure(markup, "Draft session")).toContain("Draft only");
  });

  it("fails closed for Airtable editing while retaining withdrawal", () => {
    const markup = renderRecordings({ programmeFeaturesAvailable: false });

    expect(markup).toContain(
      "unavailable for this event&#x27;s programme source",
    );
    expect(button(markup, "Save recording draft")).toContain("disabled");
    expect(button(markup, "Publish update")).toContain("disabled");
    expect(button(markup, "Withdraw")).not.toContain("disabled");
  });
});

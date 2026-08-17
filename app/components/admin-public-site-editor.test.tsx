import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { defaultPublicSiteDraft } from "~/modules/public-site/public-site";
import { AdminPublicSiteEditor } from "./admin-public-site-editor";

describe("public-site editor programme authority", () => {
  it("renders removal controls for selected IDs missing from the current programme", () => {
    const configuration = defaultPublicSiteDraft();
    configuration.featuredSpeakerIds = ["legacy-speaker"];
    configuration.featuredSessionIds = ["legacy-session"];
    const router = createMemoryRouter(
      [
        {
          path: "/admin/site",
          element: (
            <AdminPublicSiteEditor
              configuration={configuration}
              setConfiguration={() => undefined}
              draftRevision={1}
              serializedConfiguration={JSON.stringify(configuration)}
              programme={null}
              programmeReferencesAvailable={false}
              unsaved={false}
              busy={false}
              saving={false}
            />
          ),
        },
      ],
      { initialEntries: ["/admin/site"] },
    );

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain(
      "Remove unavailable selected speaker: legacy-speaker",
    );
    expect(markup).toContain(
      "Remove unavailable selected session: legacy-session",
    );
  });
});

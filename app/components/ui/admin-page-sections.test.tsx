import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AdminPageSection,
  AdminPageSectionNavigation,
} from "./admin-page-sections";

describe("administration page sections", () => {
  it("renders named anchor navigation and a desktop-expanded section", () => {
    const markup = renderToStaticMarkup(
      <>
        <AdminPageSectionNavigation
          label="Workspace sections"
          links={[{ id: "workspace-history", label: "History" }]}
        />
        <AdminPageSection
          id="workspace-history"
          label="History"
          description="Recent durable work"
        >
          <p>History content</p>
        </AdminPageSection>
      </>,
    );

    expect(markup).toContain('aria-label="Workspace sections"');
    expect(markup).toContain('href="#workspace-history"');
    expect(markup).toContain('aria-controls="workspace-history-content"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain(' hidden=""');
  });
});

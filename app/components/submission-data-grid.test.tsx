import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { SubmissionDataGrid } from "./submission-data-grid";
import type { AdminSubmission } from "~/modules/submissions/submission-repository-shared";

function renderGrid(submissions: AdminSubmission[]) {
  const router = createMemoryRouter(
    [{ path: "/", element: <SubmissionDataGrid submissions={submissions} /> }],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function pageSelectionControl(markup: string) {
  const control = markup.match(
    /<input[^>]+aria-label="Select every application on this page"[^>]*>/u,
  )?.[0];
  expect(control).toBeDefined();
  return control!;
}

describe("submission data grid", () => {
  it("disables page selection when the filtered page has no selectable records", () => {
    const markup = renderGrid([]);

    expect(pageSelectionControl(markup)).toContain('disabled=""');
    expect(markup).toContain("No matching applications");
  });

  it("keeps page selection available when the filtered page has a record", () => {
    const markup = renderGrid([
      {
        id: "submission-1",
        publicReference: "PC-001",
        title: "An observable session",
        category: "Operations",
        format: "Presentation",
        status: "assigned",
        submitterName: "Priya Shah",
        submitterEmail: "priya@example.com",
        speakerCount: 1,
        versionNumber: 1,
        submittedAt: 1,
        updatedAt: 1,
        routedTo: "Programme committee",
        routedTeamId: "team-1",
      },
    ]);

    expect(pageSelectionControl(markup)).not.toContain("disabled");
    expect(markup).toContain("An observable session");
    expect(markup).toContain('<summary class="btn small">');
    expect(markup).toContain(" Columns</summary>");
    expect(markup).toContain("<legend>Visible columns</legend>");
  });
});

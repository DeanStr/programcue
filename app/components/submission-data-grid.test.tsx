import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { SubmissionDataGrid } from "./submission-data-grid";
import type { AdminSubmission } from "~/modules/submissions/submission-repository-shared";

function renderGrid(
  submissions: AdminSubmission[],
  detailSearchParams = "",
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <SubmissionDataGrid
            submissions={submissions}
            detailSearchParams={detailSearchParams}
          />
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function submission(
  overrides: Partial<AdminSubmission> = {},
): AdminSubmission {
  return {
    id: "submission-1",
    publicReference: "PC-001",
    title: "A routed proposal",
    category: "Workshops",
    format: "Workshop",
    status: "submitted",
    submitterName: "Avery Applicant",
    submitterEmail: "avery@example.com",
    speakerCount: 1,
    versionNumber: 3,
    submittedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    routedTo: "Unassigned",
    routedTeamIds: [],
    routingState: "missing_automatic",
    ...overrides,
  };
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

  it("preserves the filtered working set and explains routing attention", () => {
    const markup = renderGrid(
      [submission()],
      "queue=1&page=2&routing=missing_automatic",
    );

    expect(markup).toContain("No automatic team route");
    expect(markup).toContain(
      "/admin/submissions/submission-1?queue=1&amp;page=2&amp;routing=missing_automatic",
    );
  });
});

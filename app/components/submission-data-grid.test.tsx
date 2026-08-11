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
});

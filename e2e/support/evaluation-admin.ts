import { expect, type Page } from "@playwright/test";

export type EvaluationAdminView = "Results" | "Assignments" | "Setup";

export async function openEvaluationView(
  page: Page,
  view: EvaluationAdminView,
) {
  const link = page
    .getByRole("navigation", { name: "Evaluation views" })
    .getByRole("link", { name: view, exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

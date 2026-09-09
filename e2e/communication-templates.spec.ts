import { expect, test } from "@playwright/test";
import { resetDemoEvent } from "./support/reset-demo-event";

test.afterEach(async ({ request }) => {
  await resetDemoEvent(request);
});

test("new email templates preserve separately published confirmation and decision versions", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  await resetDemoEvent(request);
  await page
    .context()
    .addCookies([
      {
        name: "program_cue_event",
        value: "evt-foe-2025",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  await page.goto("/admin/communications");
  await page.locator("body[data-hydrated='true']").waitFor();
  const ids: string[] = [];
  for (const template of [
    {
      name: "Separate submission confirmation",
      category: "submission_confirmation",
      label: "Submission confirmation",
    },
    { name: "Separate decision", category: "decision", label: "Decision" },
  ]) {
    await page.getByRole("link", { name: "New template", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "New email template", exact: true }),
    ).toBeVisible();
    await expect(page.locator('input[name="templateId"]')).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill(template.name);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(
        "Hello {{recipient.firstName}}, this is explicit local fixture content.",
      );
    await page
      .getByRole("textbox", { name: "Template name", exact: true })
      .fill(template.name);
    await page
      .getByRole("combobox", { name: "Type", exact: true })
      .selectOption(template.category);
    await page
      .getByRole("textbox", { name: /^Physical address/u })
      .fill("Evaluation fixture: local test venue");
    await page
      .getByRole("button", { name: "Save as new draft version", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: `Edit ${template.name}`,
        exact: true,
      }),
    ).toBeVisible();
    const id = await page.locator('input[name="templateId"]').inputValue();
    expect(ids).not.toContain(id);
    ids.push(id);
    await page
      .getByRole("button", {
        name: "Publish this saved version",
        exact: true,
      })
      .click();
    const link = page.getByRole("link", {
      name: `${template.name} ${template.label} · v1 Live`,
      exact: true,
    });
    await expect(link).toBeVisible();
    await page.reload();
    await expect(link).toBeVisible();
  }
  await expect(
    page.getByRole("link", {
      name: "Separate submission confirmation Submission confirmation · v1 Live",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Separate decision Decision · v1 Live",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", {
      name: "Separate submission confirmation Submission confirmation · v1 Live",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("Separate submission confirmation");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("Separate submission confirmation");
});

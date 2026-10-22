import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectLongTrackFilterContained } from "./support/application-grid";
import { openRecordPanel } from "./support/open-record-panel";
import { prepareVisualBaseline } from "./support/prepare-visual-baseline";
import { resetDemoEvent } from "./support/reset-demo-event";

test("column changes preserve unapplied application filters", async ({
  page,
}) => {
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  const filters = page.getByRole("search");
  await filters.getByLabel("Search", { exact: true }).fill("inclusive");
  await filters
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("assigned");
  await filters
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("title-asc");
  await page.getByText("Columns", { exact: true }).click();
  const submitter = page
    .getByRole("group", { name: "Visible columns" })
    .getByLabel("Submitter");
  await submitter.uncheck();
  await expect(page).toHaveURL(/columns=/);
  const header = page.getByRole("columnheader", { name: "Submitter" });
  await expect(header).toHaveCount(0);
  await expect(filters.getByLabel("Search", { exact: true })).toHaveValue(
    "inclusive",
  );
  await expect(
    filters.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("assigned");
  await expect(
    filters.getByRole("combobox", { name: "Sort", exact: true }),
  ).toHaveValue("title-asc");
  expect(new URL(page.url()).searchParams.get("query")).toBeNull();
  await expect(submitter).toBeFocused();
  await page.goBack();
  await expect(header).toBeVisible();
  await page.goForward();
  await expect(header).toHaveCount(0);
  await expect(filters.getByLabel("Search", { exact: true })).toHaveValue(
    "inclusive",
  );
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/query=inclusive/);
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await page.reload();
  await expect(filters.getByLabel("Search", { exact: true })).toHaveValue(
    "inclusive",
  );
  await expect(
    filters.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("assigned");
  await expect(
    filters.getByRole("combobox", { name: "Sort", exact: true }),
  ).toHaveValue("title-asc");
  await expect(header).toHaveCount(0);
});

test("application Apply remains readable during keyboard activation", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page
    .getByRole("search")
    .getByLabel("Search", { exact: true })
    .fill("inclusive");
  await page.mouse.move(0, 0);
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await apply.focus();
  await page.keyboard.down("Space");
  try {
    const scan = await new AxeBuilder({ page })
      .include(".submissions-filter-actions")
      .withRules(["color-contrast"])
      .analyze();
    expect(scan.violations).toEqual([]);
  } finally {
    await page.keyboard.up("Space");
  }
  await expect(page).toHaveURL(/query=inclusive/);
});

test("the submissions grid keeps server filters authoritative while managing the visible page", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // Evaluation setup supplies realistic routed records without bypassing the
  // production services used by the submissions queue.
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.goto("/admin/submissions?status=assigned");
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(page.locator('select[name="status"]')).toHaveValue("assigned");
  for (const selector of [".submissions-toolbar", ".pc-data-grid-toolbar"]) {
    const heights = await page
      .locator(selector)
      .locator(".field, .select, .btn")
      .evaluateAll((controls) =>
        controls
          .map((control) => control.getBoundingClientRect().height)
          .filter((height) => height > 0),
      );
    expect(
      Math.max(...heights) - Math.min(...heights),
      `${selector} controls should align`,
    ).toBeLessThanOrEqual(1);
  }
  await expect(
    page.locator(".pc-data-grid-toolbar").getByText("Density", { exact: true }),
  ).toBeVisible();
  const gridRegion = page.getByRole("region", {
    name: /Application queue table/,
  });
  const table = gridRegion.getByRole("table");
  const selectVisiblePage = gridRegion.getByRole("checkbox", {
    name: "Select every application on this page",
    exact: true,
  });
  await expect(selectVisiblePage).toBeEnabled();

  await selectVisiblePage.check();
  await expect(
    page.getByRole("main").getByText(/[1-9]\d* of [1-9]\d* selected/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy references" }).click();
  const clipboardStatus = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: /application references? copied/ });
  await expect(clipboardStatus).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^Reference\tApplication\n/);

  const density = page.getByRole("combobox", { name: "Density", exact: true });
  await density.focus();
  await density.selectOption("compact");
  await expect(page).toHaveURL(/density=compact/u);
  await expect(table).toHaveClass(/is-compact/);
  await expect(density).toBeFocused();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/density=compact/u);
  await page.getByText("Columns", { exact: true }).click();
  const visibleColumns = page.getByRole("group", {
    name: "Visible columns",
  });
  await expect(visibleColumns).toBeVisible();
  await visibleColumns.getByLabel("Submitter").uncheck();
  await expect(
    table.getByRole("columnheader", { name: "Submitter" }),
  ).toHaveCount(0);

  expect(new URL(page.url()).searchParams.get("status")).toBe("assigned");
});

test("application selection actions remain readable and clickable across widths and densities", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();

  for (const width of [320, 390, 600, 760, 761, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const density of ["comfortable", "compact"]) {
      await page.goto(`/admin/submissions?density=${density}`);
      await page.locator("body[data-hydrated='true']").waitFor();
      const selection = page.locator("tbody").getByRole("checkbox").first();
      await selection.check();
      for (const name of ["Copy references", "Clear selection"]) {
        const button = page.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        expect(
          await button.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              element.scrollWidth <= element.clientWidth &&
              element.contains(
                document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                ),
              )
            );
          }),
          `${name} at ${width}px in ${density} density`,
        ).toBe(true);
      }
      await page.getByRole("button", { name: "Copy references" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/^Reference\tApplication\n/);
      await page.getByRole("button", { name: "Clear selection" }).click();
      await expect(selection).not.toBeChecked();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("every column option remains clickable with one application", async ({
  page,
}) => {
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const density of ["comfortable", "compact"]) {
      await page.goto(`/admin/submissions?query=Designing&density=${density}`);
      await page.locator("body[data-hydrated='true']").waitFor();
      const table = page.getByRole("table");
      await expect(table.locator("tbody tr")).toHaveCount(1);
      await expect(
        table.getByRole("link", {
          name: "Designing inclusive attendee journeys",
        }),
      ).toBeVisible();

      await page.getByText("Columns", { exact: true }).click();
      const columns = page.getByRole("group", { name: "Visible columns" });
      const status = columns.getByLabel("Status");
      // Check the actual hit target before Playwright can scroll a clipped
      // ancestor to expose a control that a pointer user cannot reach.
      await expect
        .poll(() =>
          status.evaluate((input) => {
            const bounds = input.getBoundingClientRect();
            return input.contains(
              document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              ),
            );
          }),
        )
        .toBe(true);
      await status.uncheck();
      await expect(
        table.getByRole("columnheader", { name: "Status", exact: true }),
      ).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("query")).toBe("Designing");
      expect(new URL(page.url()).searchParams.get("density")).toBe(density);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("long track labels stay within the applications toolbar", async ({
  page,
}) => {
  await expectLongTrackFilterContained(page);
});

test("desktop applications keep filters and their actions on one row", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const controls = page.getByRole("search").locator(".field, .select, .btn");
  const bottoms = await controls.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().bottom),
  );
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("search").getByLabel("Density")).toHaveCount(0);
});

test("critical next actions keep their red rail at rest, on hover and on focus", async ({
  page,
  request,
}) => {
  await prepareVisualBaseline(request);
  await page.goto("/admin/command");
  await page.locator("body[data-hydrated='true']").waitFor();
  const action = page.locator(".command-top-action.is-danger");
  const red = "rgb(220, 38, 38)";
  await expect(action).toHaveCSS("border-left-color", red);
  const score = page.locator(".command-score-reading strong");
  await expect(score).toHaveCSS("color", "rgb(153, 27, 27)");
  await expect(page.locator(".command-score-condition")).toHaveText(
    "1 critical condition",
  );
  await expect(page.locator(".command-score-track")).toHaveCSS("height", "6px");
  await expect(
    page.locator(".command-workflow-row .command-meter").first(),
  ).toHaveCSS("height", "6px");
  const create = page
    .locator(".topbar")
    .getByRole("button", { name: "New", exact: true });
  await action.hover();
  await expect(action).toHaveCSS("border-left-color", red);
  await page.mouse.move(0, 0);
  await action.focus();
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS("border-left-color", red);
  await create.click();
  await expect(
    page.getByRole("dialog", { name: "Create", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
});

test("a manual application with a long event track opens after creation and reload", async ({
  page,
  context,
  request,
}) => {
  const trackName =
    "WORLDWIDE CONFERENCE MANAGEMENT, TECHNOLOGY AND INNOVATION: INTERNATIONAL PROGRAMMES AND COMMUNICATIONS STRATEGY";
  await resetDemoEvent(request);
  await context.addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  try {
    await page.goto("/admin/event");
    await page.locator("body[data-hydrated='true']").waitFor();
    await openRecordPanel(page, "Programme tracks");
    await page.getByLabel("New track", { exact: true }).fill("Long track test");
    await page.getByRole("button", { name: "Add track", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Long track test track name", exact: true })
      .fill(trackName);
    await page.getByRole("button", { name: "Save event", exact: true }).click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();

    await page.goto("/admin/submissions/new");
    await page
      .getByLabel("Session title", { exact: true })
      .fill("Long track application");
    await page
      .locator('select[name="trackIds"]')
      .selectOption({ label: trackName });
    await page
      .getByLabel("Abstract or description")
      .fill("A long track must remain readable in the immutable application.");
    await page.getByLabel("Submitter name", { exact: true }).fill("Priya Shah");
    await page
      .getByLabel("Submitter email", { exact: true })
      .fill("priya.speaker@example.com");
    await page.getByLabel("Speaker 1 name", { exact: true }).fill("Priya Shah");
    await page
      .getByLabel("Email", { exact: true })
      .fill("priya.speaker@example.com");
    const create = page.getByRole("button", {
      name: "Create manual application",
      exact: true,
    });
    await create.click();
    await page
      .getByRole("checkbox", { name: /I reviewed these identities/ })
      .check();
    await create.click();
    await expect(page).toHaveURL(/\/admin\/submissions\/[^/?]+\?created=1$/);
    await expect(
      page.getByRole("heading", {
        name: "Long track application",
        exact: true,
      }),
    ).toBeVisible();
    const reloaded = await page.reload();
    expect(reloaded?.ok()).toBe(true);
    await expect(page.getByRole("main")).toContainText(trackName);
    await page.goto(
      `/admin/submissions?category=${encodeURIComponent(trackName)}`,
    );
    await expect(page.getByRole("table")).toContainText(
      "Long track application",
    );
  } finally {
    await resetDemoEvent(request);
  }
});

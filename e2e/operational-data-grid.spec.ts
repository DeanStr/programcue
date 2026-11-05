import { expect, type Page, test } from "@playwright/test";
import { expectLongTrackFilterContained } from "./support/application-grid";
import { openRecordPanel } from "./support/open-record-panel";
import { prepareVisualBaseline } from "./support/prepare-visual-baseline";
import { resetDemoEvent } from "./support/reset-demo-event";

// Hold each Applications data request open so typing, view changes and Clear
// land while a filter request is still loading.
async function slowApplicationRequests(page: Page) {
  const requests: string[] = [];
  await page.route(/\/admin\/submissions\.data/u, async (route) => {
    requests.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  return requests;
}

test("phone-width application filters fold so the first screen shows applications", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  const filters = page.getByRole("search");
  const status = filters.getByRole("combobox", { name: "Status", exact: true });
  await expect(filters.getByLabel("Search", { exact: true })).toBeVisible();
  await expect(status).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Designing inclusive attendee journeys" }),
  ).toBeInViewport();

  const toggle = filters.getByRole("button", { name: "Filters", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await status.selectOption("assigned");
  await expect(page).toHaveURL(/status=assigned/u);
  await expect(
    filters.getByRole("button", { name: "Filters · 1", exact: true }),
  ).toBeVisible();
  await expect(status).toBeVisible();
});

test("application filters apply as the user types and keep focus and text", async ({
  page,
}) => {
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.getByRole("button", { name: "Apply filters" })).toHaveCount(
    0,
  );
  const requests = await slowApplicationRequests(page);
  const filters = page.getByRole("search");
  const search = filters.getByLabel("Search", { exact: true });
  await search.click();
  await page.keyboard.type("incl");
  // The first request is loading; the rest of the word must survive it.
  await expect.poll(() => requests.length).toBe(1);
  await page.keyboard.type("usive");
  await expect(page).toHaveURL(/query=inclusive/u);
  await expect(search).toHaveValue("inclusive");
  await expect(search).toBeFocused();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.locator(".submissions-pulse-line")).toHaveAttribute(
    "aria-live",
    "polite",
  );

  // A filter changed while a column change is loading keeps both.
  await filters
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("assigned");
  await page.getByText("Columns", { exact: true }).click();
  await page
    .getByRole("group", { name: "Visible columns" })
    .getByLabel("Submitter")
    .uncheck();
  await expect(page).toHaveURL(/status=assigned/u);
  await expect(page).toHaveURL(/columns=route%2Cspeakers%2Cstatus/u);
  await expect(page).toHaveURL(/query=inclusive/u);
  const header = page.getByRole("columnheader", { name: "Submitter" });
  await expect(header).toHaveCount(0);
  await expect(search).toHaveValue("inclusive");

  // Clear leaves the filtered entry in history; Back and Forward restore the
  // form from each URL.
  await filters.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/u);
  await expect(search).toHaveValue("");
  await expect(
    filters.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("");
  await expect(header).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/query=inclusive/u);
  await expect(search).toHaveValue("inclusive");
  await expect(
    filters.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("assigned");
  await expect(header).toHaveCount(0);
  await page.goForward();
  await expect(search).toHaveValue("");
  await page.goBack();
  await page.reload();
  await expect(search).toHaveValue("inclusive");
  await expect(
    filters.getByRole("combobox", { name: "Status", exact: true }),
  ).toHaveValue("assigned");
});

test("Back during a loading filter restores the earlier entry exactly", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page
    .getByRole("combobox", { name: "Density", exact: true })
    .selectOption("compact");
  await expect(page).toHaveURL(/density=compact/u);
  const requests = await slowApplicationRequests(page);
  const search = page.getByRole("search").getByLabel("Search", { exact: true });
  await search.fill("inclusive");
  // The filter request is still loading when the user goes back.
  await expect.poll(() => requests.length).toBe(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/submissions$/u);
  await expect(
    page.getByRole("combobox", { name: "Density", exact: true }),
  ).toHaveValue("comfortable");
  await expect(search).toHaveValue("");
  // Nothing re-applies the abandoned search over the restored entry.
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(/\/admin\/submissions$/u);
  await expect(search).toHaveValue("");
});

test("Back restores an entry whose search matches a loading request", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  const filters = page.getByRole("search");
  const search = filters.getByLabel("Search", { exact: true });
  await search.fill("inclusive");
  await expect(page).toHaveURL(/query=inclusive/u);
  await filters.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/u);

  const requests = await slowApplicationRequests(page);
  await search.click();
  await page.keyboard.type("inclusive");
  // The new request asks for exactly the entry Back returns to.
  await expect.poll(() => requests.length).toBe(1);
  await page.keyboard.type("-more");
  await page.goBack();
  await expect(page).toHaveURL(/query=inclusive(?:&|$)/u);
  await expect(search).toHaveValue("inclusive");
  // Neither the pending edit nor its debounce lands on the restored entry.
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(/query=inclusive(?:&|$)/u);
  await expect(search).toHaveValue("inclusive");
});

test("a select traversed from the keyboard applies once and Enter applies at once", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  const requests = await slowApplicationRequests(page);
  const sort = page
    .getByRole("search")
    .getByRole("combobox", { name: "Sort", exact: true });
  await sort.focus();
  // A closed select changes, and fires change, on every arrow key.
  for (let step = 0; step < 3; step += 1)
    await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/sort=title-desc/u);
  await page.waitForTimeout(600);
  expect(requests).toHaveLength(1);
  await expect(sort).toBeFocused();

  const search = page.getByRole("search").getByLabel("Search", { exact: true });
  await search.fill("Designing");
  await search.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  await expect(page).toHaveURL(/query=Designing/u);
  await page.waitForTimeout(600);
  expect(requests).toHaveLength(2);
});

test("a filter chosen before hydration is kept and applied", async ({
  page,
}) => {
  // Controlled filters would otherwise put the loaded value back on their
  // first render.
  await page.route(/\/assets\/.*\.js$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.goto("/admin/submissions", { waitUntil: "domcontentloaded" });
  const sort = page
    .getByRole("search")
    .getByRole("combobox", { name: "Sort", exact: true });
  await sort.selectOption("title-asc");
  await expect(page.locator("body[data-hydrated='true']")).toHaveCount(0);
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page).toHaveURL(/sort=title-asc/u);
  await expect(sort).toHaveValue("title-asc");
});

test("rapid view changes keep every change", async ({ page }) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  // Hold each view request open so the second change lands while the first
  // is still loading, which is when the rendered URL is stale.
  await slowApplicationRequests(page);
  await page.getByText("Columns", { exact: true }).click();
  const columns = page.getByRole("group", { name: "Visible columns" });
  await columns.getByLabel("Submitter").uncheck();
  await columns.getByLabel("Category route").uncheck();
  await expect(page).toHaveURL(/columns=speakers%2Cstatus$/u);
  await expect(
    page.getByRole("columnheader", { name: "Submitter" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Category route" }),
  ).toHaveCount(0);

  // A filter change lands while the density change is still loading.
  await page.getByLabel("Density").selectOption("compact");
  await page
    .getByRole("search")
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("title-asc");
  await expect(page).toHaveURL(/sort=title-asc/u);
  await expect(page).toHaveURL(/density=compact/u);
  await expect(page).toHaveURL(/columns=speakers%2Cstatus/u);
});

test("a view change replaced before it loads leaves no stale view", async ({
  page,
}) => {
  await page.goto("/admin/submissions");
  await page.locator("body[data-hydrated='true']").waitFor();
  await slowApplicationRequests(page);
  const density = page.getByLabel("Density");
  await density.selectOption("compact");
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(density).toHaveValue("comfortable");
  await expect(page.locator(".pc-data-grid")).not.toHaveClass(/is-compact/u);

  // The next change builds on what loaded, not on the abandoned request.
  await page.getByText("Columns", { exact: true }).click();
  await page
    .getByRole("group", { name: "Visible columns" })
    .getByLabel("Submitter")
    .uncheck();
  await expect(page).toHaveURL(/\?columns=route%2Cspeakers%2Cstatus$/u);
});

test("task filters without a text field apply from the keyboard", async ({
  page,
}) => {
  await page.goto("/admin/tasks");
  await page.locator("body[data-hydrated='true']").waitFor();
  const filters = page.locator(".tasks-filters");
  await filters.locator("summary").focus();
  await page.keyboard.press("Enter");
  const status = filters.getByLabel("Status");
  await status.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/state=not_started/u);
  await expect(status).toHaveValue("not_started");
  await expect(status).toBeFocused();
  await expect(page.getByRole("button", { name: "Apply filters" })).toHaveCount(
    0,
  );
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
  // A filter change keeps the selected density.
  await page
    .getByRole("search")
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("title-asc");
  await expect(page).toHaveURL(/sort=title-asc/u);
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
  const filters = page.getByRole("search");
  // The phone Filters button is not displayed at this width.
  await expect(filters.getByRole("button", { name: /^Filters/u })).toBeHidden();
  const controls = filters.locator(":is(.field, .select, .btn):visible");
  const bottoms = await controls.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().bottom),
  );
  expect(bottoms.length).toBeGreaterThan(5);
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
  // --state-bad-solid and --state-bad-text: crimson, distinct from copper.
  const red = "rgb(190, 18, 60)";
  await expect(action).toHaveCSS("border-left-color", red);
  const score = page.locator(".command-score-reading strong");
  await expect(score).toHaveCSS("color", "rgb(159, 18, 57)");
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
    // Her exact name and email are her identity: no review step.
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

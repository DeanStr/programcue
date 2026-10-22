import { expect, type Page } from "@playwright/test";

export async function expectLongTrackFilterContained(page: Page) {
  const trackName =
    "WORLDWIDE CONFERENCE MANAGEMENT, TECHNOLOGY AND INNOVATION: INTERNATIONAL PROGRAMMES AND COMMUNICATIONS STRATEGY";

  for (const width of [1024, 1440, 1280, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/submissions");
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const track = page
      .getByRole("search")
      .getByRole("combobox", { name: "Track", exact: true });
    // Exercise native select sizing with a label inside the supported
    // 120-character track-name limit, without creating domain records.
    await track.evaluate((select, name) => {
      select.append(new Option(name, name));
    }, trackName);

    for (const selection of ["", trackName]) {
      await track.selectOption(selection);
      await expect
        .poll(() =>
          track.evaluate(
            (select) =>
              select.getBoundingClientRect().right -
              document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  }
}

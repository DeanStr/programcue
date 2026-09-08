import { expect, test } from "@playwright/test";
import {
  completeApplicationTurnstile,
  installApplicationTurnstileMock,
  waitForApplicationTurnstileActions,
} from "./support/mock-turnstile";
import { openRecordPanel } from "./support/open-record-panel";

const accessCode =
  process.env.PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE ??
  "0123456789abcdef0123456789abcdef";

test("evaluation guide prioritizes the repeatable reviewer invitation", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();

  await expect(
    page.getByRole("heading", { name: "Reviewer invitation" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sam's evaluation alias (not an inbox)", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /routes it to Sam's controlled @programcue\.com fixture inbox/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("sam.reviewer@sbek-test.example.com", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Copy email" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("sam.reviewer@sbek-test.example.com");

  const optionalJourney = page.locator("details").filter({
    has: page.getByText("Optional: test your own inbox", { exact: true }),
  });
  await expect(optionalJourney).not.toHaveAttribute("open", "");
  await optionalJourney.locator("summary").click();
  await expect(optionalJourney).toHaveAttribute("open", "");
  await expect(optionalJourney).toContainText(
    "Resetting evaluation data removes its event access but does not delete the account.",
  );
});

test("locking evaluation returns the same browser to the ordinary authentication realm", async ({
  page,
}) => {
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose an evaluation persona" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Lock evaluation" }).click();

  await expect(page).toHaveURL(/\/evaluate$/u);
  await expect(
    page.getByRole("heading", { name: "Evaluation access", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlock evaluation" }),
  ).toBeVisible();
  const cookieNames = (await page.context().cookies()).map(
    (cookie) => cookie.name,
  );
  expect(cookieNames).not.toContain("__Host-program_cue_evaluation");
  expect(cookieNames).not.toContain("__Host-program_cue_event");
});

test("evaluation banner stays compact and usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();
  await page
    .getByRole("button", { name: "Open as Organisation owner" })
    .click();

  const banner = page.getByRole("complementary", {
    name: "Evaluation session",
  });
  const actions = banner.locator(".pc-eval-banner-actions");
  await expect(banner).toBeVisible();
  await expect
    .poll(() =>
      banner.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBeLessThanOrEqual(100);
  await expect
    .poll(() =>
      banner.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: Math.round(bounds.left),
          rightGap: Math.round(
            document.documentElement.clientWidth - bounds.right,
          ),
          overflow: element.scrollWidth - element.clientWidth,
        };
      }),
    )
    .toEqual({ left: 0, rightGap: 0, overflow: 0 });
  await expect(
    banner.getByRole("link", { name: "Evaluation guide" }),
  ).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "Change persona" }),
  ).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "Hide evaluation bar" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      actions
        .locator(".btn")
        .evaluateAll(
          (buttons) =>
            new Set(
              buttons.map((button) =>
                Math.round(button.getBoundingClientRect().top),
              ),
            ).size,
        ),
    )
    .toBe(1);
  await expect(banner).toHaveScreenshot("evaluation-banner-mobile.png");

  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(() =>
      banner.evaluate((element) => {
        const identity = element.querySelector<HTMLElement>(
          ".pc-eval-banner-identity",
        );
        const buttons = [...element.querySelectorAll<HTMLElement>(".btn")];
        if (!identity || buttons.length !== 3) return null;
        return {
          bannerOverflow: Math.max(
            0,
            element.scrollWidth - element.clientWidth,
          ),
          identityOverflow: Math.max(
            0,
            identity.scrollWidth - identity.clientWidth,
          ),
          buttonOverflows: buttons.map((button) =>
            Math.max(0, button.scrollWidth - button.clientWidth),
          ),
        };
      }),
    )
    .toEqual({
      bannerOverflow: 0,
      identityOverflow: 0,
      buttonOverflows: [0, 0, 0],
    });
  await expect
    .poll(() =>
      banner.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBeLessThanOrEqual(100);

  await banner.getByRole("button", { name: "Hide evaluation bar" }).click();
  const restore = page.getByRole("button", {
    name: /Show evaluation bar: Evaluation/,
  });
  await expect(restore).toBeFocused();
  await restore.click();
  await expect(
    page.getByRole("button", { name: "Hide evaluation bar" }),
  ).toBeFocused();
});

test("gate-only evaluation access reopens an anonymous application after redirect", async ({
  page,
}) => {
  await installApplicationTurnstileMock(page);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();

  await expect(
    page.getByRole("heading", { name: "Choose an evaluation persona" }),
  ).toBeVisible();
  await expect(
    page.getByText("No persona selected", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Application form" }).click();
  await expect(
    page.getByText("Evaluation access is active without a selected persona."),
  ).toBeVisible();

  await waitForApplicationTurnstileActions(page, [
    "application_start_anonymous",
  ]);
  await completeApplicationTurnstile(
    page,
    "application_start_anonymous",
    "XXXX.DUMMY.TOKEN.XXXX",
  );
  const start = page.getByRole("button", { name: "Start application" });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  await expect(page).toHaveURL(/\/apply\/form\?draft=[^&]+&notice=/u);
  await expect(
    page.getByRole("heading", { name: "Protect and submit this draft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your applications" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard anonymous session" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.locator(".validation-item.ok[role='status']").filter({
      hasText: "Your draft has been saved.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Untitled application", level: 1 }),
  ).toBeVisible();
});

test("accepted speaker saves a new anonymous application from the participant workspace", async ({
  page,
}) => {
  await installApplicationTurnstileMock(page);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();

  const acceptedSpeaker = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Accepted speaker", exact: true }),
  });
  await acceptedSpeaker
    .getByRole("button", { name: "Open as Accepted speaker" })
    .click();
  await expect(page).toHaveURL(/\/participant\/dashboard$/u);

  await page.getByRole("link", { name: "Applications", exact: true }).click();
  await page
    .getByRole("link", {
      name: /Call for Speakers.*Start a new application/u,
    })
    .click();
  await expect(
    page.getByText("Accepted speaker is selected for private workspaces."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Continue to application" }).click();

  await waitForApplicationTurnstileActions(page, [
    "application_start_anonymous",
  ]);
  await completeApplicationTurnstile(
    page,
    "application_start_anonymous",
    "XXXX.DUMMY.TOKEN.XXXX",
  );
  const start = page.getByRole("button", { name: "Start application" });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.locator(".validation-item.ok[role='status']").filter({
      hasText: "Your draft has been saved.",
    }),
  ).toBeVisible();
});

test("observed organiser proposal links require private access", async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();
  await page
    .getByRole("button", {
      name: "Create evaluator submitter account",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/apply\/form/u);
  await page.getByRole("button", { name: "Start application" }).click();
  const title = "Private proposal handoff";
  await page.getByLabel("Session title").fill(title);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Your draft has been saved.", { exact: true }),
  ).toBeVisible();
  await page.goto("/evaluate");
  await page
    .getByRole("button", { name: "Open as Event organiser", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/command$/u);
  await page.goto("/admin/submissions");
  const proposal = page.getByRole("link", { name: title, exact: true });
  await proposal.click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const proposalUrl = page.url();
  expect(new URL(proposalUrl).pathname).toMatch(
    /^\/admin\/submissions\/[^/]+$/u,
  );
  expect(new URL(proposalUrl).searchParams.has("draft")).toBe(false);
  await page.goto(proposalUrl);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();

  const unprivileged = await browser.newContext();
  try {
    const visitor = await unprivileged.newPage();
    await visitor.goto(new URL("/evaluate", proposalUrl).href);
    await visitor
      .getByRole("textbox", { name: "Access code" })
      .fill(accessCode);
    await visitor.getByRole("button", { name: "Unlock evaluation" }).click();
    await expect(
      visitor.getByText("No persona selected", { exact: true }),
    ).toBeVisible();
    await visitor.goto(proposalUrl);
    await expect(visitor).toHaveURL(/\/evaluate(?:\?|$)/u);
    await expect(visitor.getByText(title, { exact: true })).toHaveCount(0);
    await visitor
      .getByRole("button", { name: "Open as Reviewer", exact: true })
      .click();
    await expect(visitor).toHaveURL(/\/review\/workbench$/u);
    const denied = await visitor.goto(proposalUrl);
    expect(denied?.status()).toBe(403);
    await expect(visitor.getByText(title, { exact: true })).toHaveCount(0);
  } finally {
    await unprivileged.close();
  }
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 601 },
  { width: 390, height: 700 },
  { width: 844, height: 390 },
]) {
  test(`form settings remain clickable after scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/evaluate");
    await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
    await page.getByRole("button", { name: "Unlock evaluation" }).click();
    await page
      .getByRole("button", { name: "Open as Organisation owner" })
      .click();
    await expect(page).toHaveURL(/\/admin\/files\/retention$/u);
    await page.goto("/admin/submissions/form");
    await page.locator("body[data-hydrated='true']").waitFor();
    if (viewport.width < 1000) {
      await page
        .getByRole("button", { name: "Settings", exact: true })
        .first()
        .click();
    }
    const properties = page.locator(".fb-inspector summary").filter({
      hasText: "Form properties",
    });
    for (const hideBanner of [false, true]) {
      if (hideBanner) {
        await page.getByRole("button", { name: "Hide evaluation bar" }).click();
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // Match the evaluator's normal scroll-then-hit-test interaction. A sticky
      // toolbar must not obscure a control that the browser considers visible.
      await properties.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          properties.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              ),
            );
          }),
        )
        .toBe(true);
      await properties.click();
      await page.getByRole("textbox", { name: "Form name" }).click();
      await properties.click();
      const save = page.getByRole("button", {
        name: "Save draft",
        exact: true,
      });
      await save.focus();
      await expect(save).toBeFocused();
      await expect(save).toBeInViewport();
      const canvas = page.locator(".fb-canvas-page");
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      if (viewport.width < 1000) {
        await page.getByRole("button", { name: "Close preview" }).click();
        await page.getByRole("button", { name: "Canvas", exact: true }).click();
      }
      await expect
        .poll(() => canvas.evaluate((element) => element.clientHeight))
        .toBeGreaterThanOrEqual(200);
      const titleField = canvas
        .locator(".fb-canvas-field")
        .first()
        .getByRole("button");
      await titleField.click();
      await page
        .getByRole("button", { name: "Settings", exact: true })
        .first()
        .click();
      await expect(page.getByLabel("Label", { exact: true })).toHaveValue(
        "Session title",
      );
    }
  });
}

test("form recovery reconciles renamed event choices and stays saveable beneath the evaluation header", async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();
  await page
    .getByRole("button", { name: "Open as Organisation owner" })
    .click();
  await expect(page).toHaveURL(/\/admin\/files\/retention$/u);
  await page.goto("/admin/submissions/form");
  await page.locator("body[data-hydrated='true']").waitFor();
  const savedSchema = JSON.parse(
    await page.locator('input[name="schema"]').inputValue(),
  ) as {
    fields: Array<{ id: string; options: string[] }>;
  };
  const trackName = savedSchema.fields.find((field) => field.id === "category")!
    .options[0]!;
  const formatName = savedSchema.fields.find((field) => field.id === "format")!
    .options[0]!;
  const renamedTrack = `${trackName} renamed`;
  const renamedFormat = `${formatName} renamed`;
  const customLabel = "Recovered track outcomes";
  const editor = page.getByLabel("Visual call-for-speakers form editor");
  await editor.getByRole("button", { name: "Add Long text" }).click();
  await page.getByLabel("Label", { exact: true }).fill(customLabel);
  await page.getByLabel("Show this field when").selectOption("category");
  await page
    .getByRole("combobox", { name: "Equals", exact: true })
    .selectOption(trackName);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  async function renameChoices(
    fromTrack: string,
    toTrack: string,
    fromFormat: string,
    toFormat: string,
  ) {
    await page.goto("/admin/event");
    await openRecordPanel(page, "Programme tracks");
    await page
      .getByRole("textbox", { name: `${fromTrack} track name`, exact: true })
      .fill(toTrack);
    await openRecordPanel(page, "Session formats and durations");
    await page
      .getByRole("textbox", { name: `${fromFormat} format label`, exact: true })
      .fill(toFormat);
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();
  }

  let choicesRenamed = false;
  try {
    await renameChoices(trackName, renamedTrack, formatName, renamedFormat);
    choicesRenamed = true;
    await page.goto("/admin/submissions/form");
    await page.getByRole("button", { name: "Restore local edits" }).click();
    const customField = editor
      .locator(".fb-canvas-field")
      .filter({ hasText: customLabel });
    await expect(customField).toBeVisible();
    await customField.getByRole("button").click();
    await expect(
      page.getByRole("combobox", { name: "Equals", exact: true }),
    ).toHaveValue(renamedTrack);
    const save = page.getByRole("button", { name: "Save draft", exact: true });
    await save.evaluate((button) => button.scrollIntoView({ block: "start" }));
    await expect
      .poll(() =>
        save.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    await save.click();
    await expect(
      page.getByText("Draft form saved.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Draft conflict", { exact: true })).toHaveCount(
      0,
    );
    await page.reload();
    await expect(customField).toBeVisible();
    await customField.getByRole("button").click();
    await expect(
      page.getByRole("combobox", { name: "Equals", exact: true }),
    ).toHaveValue(renamedTrack);
    const introduction = page.getByLabel("Introduction");
    await introduction.fill(
      `${await introduction.inputValue()} Keyboard save check.`,
    );
    await save.focus();
    await expect(save).toBeFocused();
    await expect
      .poll(() =>
        save.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          const topbar = document
            .querySelector(".topbar")!
            .getBoundingClientRect();
          return (
            bounds.top >= topbar.bottom && bounds.bottom <= window.innerHeight
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Draft form saved.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Publish version", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm publication" }).click();
    await expect(
      page.getByText(/Published a new immutable form version/),
    ).toBeVisible();
    await page.reload();
    await expect(customField).toBeVisible();
    const publishedChoices = JSON.parse(
      await page.locator('input[name="schema"]').inputValue(),
    ) as typeof savedSchema;
    expect(
      publishedChoices.fields.find((field) => field.id === "category")?.options,
    ).toContain(renamedTrack);
    expect(
      publishedChoices.fields.find((field) => field.id === "format")?.options,
    ).toContain(renamedFormat);
  } finally {
    if (choicesRenamed) {
      await renameChoices(renamedTrack, trackName, renamedFormat, formatName);
    }
  }
});

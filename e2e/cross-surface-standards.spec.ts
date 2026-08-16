import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";

test.describe
  .serial("cross-surface interaction standards", () => {
    test.beforeAll(async ({ request }) => {
      await resetDemoSubmissions(request);
    });

    test.beforeEach(async ({ context }) => {
      await context.addCookies([
        {
          name: "program_cue_event",
          value: "evt-foe-2025",
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    });

    test.afterAll(async ({ request }) => {
      await resetDemoSubmissions(request);
    });

    test("administrator pages expose organisation/event context and a copyable filtered deep link", async ({
      context,
      page,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/admin/submissions?status=submitted");

      const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(
        breadcrumbs.getByRole("link", { name: "Future Events Association" }),
      ).toBeVisible();
      await expect(
        breadcrumbs.getByRole("link", { name: "Future of Events 2027" }),
      ).toBeVisible();
      await expect(
        breadcrumbs.getByText("Applications", { exact: true }),
      ).toHaveAttribute("aria-current", "page");

      await page
        .getByRole("button", { name: "Copy a deep link to this page" })
        .click();
      await expect(
        page.getByRole("button", { name: "Copy a deep link to this page" }),
      ).toContainText("Link copied");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("/admin/submissions?status=submitted");
    });

    test("navigable records remain real links and deliberate new-tab links disclose their behavior", async ({
      page,
    }) => {
      // The review workspace establishes the deterministic routed demo records.
      // Use that same production fixture boundary rather than relying on records
      // left behind by an earlier browser test.
      await page.goto("/admin/review");
      await page.locator("body[data-hydrated='true']").waitFor();
      await page.goto("/admin/submissions?status=assigned");
      const recordLink = page.locator(".pc-data-grid tbody a").first();
      await expect(recordLink).toHaveJSProperty("tagName", "A");
      await expect(recordLink).toHaveAttribute(
        "href",
        /\/admin\/submissions\//,
      );

      await page.goto("/admin/programme");
      const publicProgramme = page.getByRole("link", {
        name: /Public programme.*opens in a new tab/,
      });
      await expect(publicProgramme).toHaveAttribute("target", "_blank");
      await expect(publicProgramme).toHaveAttribute("rel", /noopener/);
    });

    test("event-local schedule times disclose an exact accessible timestamp", async ({
      page,
      request,
    }) => {
      await resetDemoEvent(request);
      await page.goto("/admin/programme");
      const publishedSession = page.getByRole("row").filter({
        has: page.getByText("The Future of Attendee Engagement", {
          exact: true,
        }),
      });
      const eventTime = publishedSession.locator(".pc-event-time");
      await expect(eventTime).toHaveAttribute(
        "data-exact-time",
        /America\/Toronto/,
      );
      await expect(eventTime.locator(".sr-only")).toHaveText(
        /America\/Toronto/,
      );
      await expect(eventTime).toHaveAttribute("tabindex", "0");
    });

    test("a likely existing speaker requires review before direct-session creation", async ({
      page,
    }) => {
      const title = `Duplicate-aware direct session ${Date.now()}`;
      await page.goto("/admin/sessions/new?from=global");
      const directSessionForm = page.locator("form").filter({
        has: page.getByRole("button", {
          name: "Create unscheduled session",
          exact: true,
        }),
      });
      await directSessionForm.getByLabel("Session title").fill(title);
      await directSessionForm.getByLabel("Track").selectOption({ index: 1 });
      await directSessionForm.getByLabel("Speaker 1 name").fill("Priya Shah");
      await directSessionForm
        .getByLabel("Email")
        .fill("priya.speaker@example.com");
      await directSessionForm
        .getByRole("button", {
          name: "Create unscheduled session",
          exact: true,
        })
        .click();

      await expect(
        directSessionForm.getByRole("heading", {
          name: "Likely existing person",
        }),
      ).toBeVisible();
      await expect(
        directSessionForm.getByText("priya.speaker@example.com"),
      ).toBeVisible();
      await directSessionForm.getByLabel(/I reviewed these identities/).check();
      await directSessionForm
        .getByRole("button", {
          name: "Create unscheduled session",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Direct session created" }),
      ).toContainText("Speaker participation must still be confirmed");
    });

    test("manual speaker creation warns before linking an existing identity", async ({
      page,
    }) => {
      await page.goto("/admin/speakers");
      await page.locator("body[data-hydrated='true']").waitFor();
      const speakerRecordSummary = page
        .locator("summary")
        .filter({ hasText: "Add speaker record" });
      const speakerRecordDisclosure = speakerRecordSummary.locator("..");
      await speakerRecordSummary.click();
      await expect(speakerRecordDisclosure).toHaveAttribute("open", "");
      await page.locator("#manual-speaker-name").fill("Priya Shah");
      await page
        .locator('input[name="email"]')
        .filter({ visible: true })
        .fill("priya.speaker@example.com");
      await page
        .getByRole("button", { name: "Add speaker record", exact: true })
        .click();

      await expect(
        page.getByRole("heading", { name: "Likely existing person" }),
      ).toBeVisible();
      await page.getByLabel(/I reviewed these identities/).check();
      await page
        .getByRole("button", { name: "Add speaker record", exact: true })
        .click();
      await expect(
        page.getByText(
          "This identity is already on this event roster. Nothing was changed and no invitation email was sent.",
        ),
      ).toBeVisible();
    });
  });

import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import {
  clearDemoCommunicationUnsubscribe,
  readDemoCommunicationUnsubscribe,
  seedDemoCommunicationUnsubscribe,
  type DemoCommunicationUnsubscribeFixture,
} from "./support/demo-communication-unsubscribe";

test.describe
  .serial("optional email unsubscribe", () => {
    let fixture: DemoCommunicationUnsubscribeFixture;

    test.beforeAll(async ({ request }) => {
      fixture = await seedDemoCommunicationUnsubscribe(request);
    });

    test.afterAll(async ({ request }) => {
      await clearDemoCommunicationUnsubscribe(request);
    });

    test("requires a real confirmation POST and records one durable category opt-out", async ({
      page,
    }) => {
      const response = await page.goto(fixture.unsubscribePath);
      expect(response?.ok()).toBeTruthy();
      await page.locator("body[data-hydrated='true']").waitFor();
      await expect(
        page.getByRole("heading", { name: "Email preferences" }),
      ).toBeVisible();
      await expect(page.getByText(fixture.address)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Unsubscribe" }),
      ).toBeVisible();

      await expect
        .poll(
          async () =>
            (await readDemoCommunicationUnsubscribe(page.request, fixture))
              .count,
        )
        .toBe(0);

      await page.getByRole("button", { name: "Unsubscribe" }).click();
      await expect(page.getByRole("status")).toContainText(
        `${fixture.address} is unsubscribed from optional event updates`,
      );
      await expect(
        page.getByRole("button", { name: "Unsubscribe" }),
      ).toHaveCount(0);

      await expect
        .poll(
          async () =>
            await readDemoCommunicationUnsubscribe(page.request, fixture),
        )
        .toMatchObject({
          count: 1,
          address: fixture.address,
          category: "ad_hoc",
          reason: "recipient_unsubscribe",
          revokedAt: null,
        });

      const repeated = await page.request.post(fixture.unsubscribePath, {
        headers: { origin: e2eOrigin },
      });
      expect(repeated.ok(), await repeated.text()).toBeTruthy();
      expect(
        (await readDemoCommunicationUnsubscribe(page.request, fixture)).count,
      ).toBe(1);

      await page.reload();
      await expect(page.getByRole("status")).toContainText(
        `${fixture.address} is unsubscribed from optional event updates`,
      );
      await expect(
        page.getByRole("button", { name: "Unsubscribe" }),
      ).toHaveCount(0);
    });
  });

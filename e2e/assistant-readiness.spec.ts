import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { AiAssistantResult } from "../app/modules/ai/ai-types";
import { e2eOrigin } from "./support/e2e-origin";

const prompt =
  "What is the most important thing we need to resolve before this event is ready?";
const confirmation = "seed-assistant-approval-browser-fixture";

test.use({ video: "on", trace: "on" });
test.afterEach(async ({ page }, testInfo) => {
  const scenario = testInfo.title.match(/readiness workflow: (\w+)/u)?.[1];
  const video = page.video();
  if (scenario && video) {
    await mkdir(".artifacts/assistant-workflow", { recursive: true });
    await page.close();
    await video.saveAs(`.artifacts/assistant-workflow/${scenario}.webm`);
  }
});

for (const scenario of [
  "success",
  "insufficient_information",
  "no_blockers",
  "stale_before_approval",
  "provider_failure",
  "rejection",
  "conflicting_edit",
  "conflicting_rejection",
  "interrupted_settlement",
  "existing_work",
  "delivery_failures",
] as const) {
  test(`readiness workflow: ${scenario} with an explicitly simulated model`, async ({
    page,
    request,
    context,
  }) => {
    const fixtureScenario = [
      "rejection",
      "conflicting_edit",
      "conflicting_rejection",
      "interrupted_settlement",
      "existing_work",
    ].includes(scenario)
      ? "success"
      : scenario;
    const configure = async (enabled: boolean) => {
      const response = await request.post("/demo/fixtures/assistant-proposal", {
        form: {
          intent: "configure_stream_test",
          confirm: confirmation,
          enabled: enabled ? "yes" : "no",
        },
        headers: { origin: e2eOrigin },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    };
    await configure(true);
    try {
      const seeded = await request.post("/demo/fixtures/assistant-proposal", {
        form: {
          intent: "seed_readiness_event",
          confirm: confirmation,
          scenario: fixtureScenario,
          prompt,
        },
        headers: { origin: e2eOrigin },
      });
      const body = await seeded.text();
      expect(seeded.ok(), body).toBeTruthy();
      const fixture = JSON.parse(body) as {
        demonstrationOnly: true;
        providerCalled: false;
        eventId: string;
        result: AiAssistantResult | null;
        error: string | null;
      };
      expect(fixture).toMatchObject({
        demonstrationOnly: true,
        providerCalled: false,
      });
      await context.addCookies([
        {
          name: "program_cue_event",
          value: fixture.eventId,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/admin/assistant/stream", async (route) => {
        expect(route.request().postData()).toContain(prompt);
        const run = await request.post("/demo/fixtures/assistant-proposal", {
          form: {
            intent: "run_readiness_workflow",
            confirm: confirmation,
            eventId: fixture.eventId,
            scenario: fixtureScenario,
            prompt,
          },
          headers: { origin: e2eOrigin },
        });
        const runBody = await run.text();
        expect(run.ok(), runBody).toBeTruthy();
        const completed = JSON.parse(runBody) as typeof fixture;
        expect(completed.eventId).toBe(fixture.eventId);
        expect(completed).toMatchObject({
          demonstrationOnly: true,
          providerCalled: false,
        });
        fixture.result = completed.result;
        fixture.error = completed.error;
        const event = fixture.result ? "result" : "error";
        const payload = fixture.result ?? { message: fixture.error };
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
        });
      });
      await page.goto("/admin/assistant");
      await page.locator("body[data-hydrated='true']").waitFor();
      await expect(
        page.getByRole("heading", { name: "Previous requests" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Approve and create task" }),
      ).toHaveCount(0);
      await page
        .getByRole("textbox", { name: "Request", exact: true })
        .fill(prompt);
      await page
        .getByRole("button", { name: "Ask assistant", exact: true })
        .click();
      if (scenario === "provider_failure") {
        await expect(
          page
            .getByRole("alert")
            .filter({ hasText: "injected acceptance provider failure" }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("heading", { name: "Assistant answer" }),
        ).toBeVisible();
      }
      if (
        [
          "success",
          "stale_before_approval",
          "rejection",
          "conflicting_edit",
          "conflicting_rejection",
          "interrupted_settlement",
          "existing_work",
        ].includes(scenario)
      ) {
        let proposal = page.locator(
          `section[data-proposal-id="${fixture.result?.proposals[0].id}"]`,
        );
        const approvals = page.getByRole("region", {
          name: "Pending assistant approvals",
        });
        const history = page.getByRole("region", {
          name: "Previous assistant requests",
        });
        await expect(
          approvals.getByRole("heading", { name: "Needs your approval" }),
        ).toBeVisible();
        await expect(history).toBeVisible();
        expect(
          await approvals.evaluate((element) =>
            Boolean(
              element.compareDocumentPosition(
                document.querySelector(".pc-assist-history")!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        ).toBe(true);
        if (scenario === "success") {
          await mkdir(".artifacts/assistant-workflow", { recursive: true });
          await page.screenshot({
            path: ".artifacts/assistant-workflow/pending-approval.png",
            fullPage: true,
          });
          const desktop = page.viewportSize();
          await page.setViewportSize({ width: 390, height: 844 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(390);
          await page.screenshot({
            path: ".artifacts/assistant-workflow/pending-mobile.png",
            fullPage: true,
          });
          if (desktop) await page.setViewportSize(desktop);
        }
        await proposal.getByText(/Review all .* affected records/).click();
        await expect(
          proposal.getByRole("link").filter({ hasText: "room" }),
        ).toBeVisible();
        if (
          scenario === "conflicting_edit" ||
          scenario === "conflicting_rejection"
        ) {
          const original = fixture.result?.proposals[0];
          if (original?.toolName !== "propose_task" || !original.task)
            throw new Error("Expected a streamed task proposal");
          const replacementTitle = "Replacement prepared in another tab";
          const competingReview = await context.request.post(
            "/admin/assistant",
            {
              form:
                scenario === "conflicting_edit"
                  ? {
                      intent: "reject_task",
                      proposalId: original.id,
                      confirmed: "yes",
                    }
                  : {
                      intent: "edit_task",
                      proposalId: original.id,
                      title: replacementTitle,
                      description: original.task.description ?? "",
                      ownerPersonId: original.task.ownerPersonId ?? "",
                    },
              headers: { origin: e2eOrigin },
            },
          );
          expect(
            competingReview.ok(),
            await competingReview.text(),
          ).toBeTruthy();
          const conflict = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/admin/assistant.data" &&
              response.request().method() === "POST",
          );
          if (scenario === "conflicting_edit") {
            await proposal
              .getByText("Edit task preview", { exact: true })
              .click();
            await proposal
              .getByRole("textbox", { name: "Task title", exact: true })
              .fill("A stale edit from this tab");
            await proposal
              .getByRole("button", { name: "Save edited task preview" })
              .click();
          } else {
            await proposal
              .getByRole("button", { name: "Reject task proposal" })
              .click();
          }
          expect((await conflict).status()).toBe(409);
          await expect(proposal).toHaveCount(0);
          await expect(
            page.getByRole("heading", { name: "Assistant answer" }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Approve and create task" }),
          ).toHaveCount(scenario === "conflicting_edit" ? 0 : 1);
          if (scenario === "conflicting_rejection")
            await expect(
              approvals.getByRole("heading", {
                name: replacementTitle,
                exact: true,
              }),
            ).toBeVisible();
          else await expect(history).toContainText("Rejected");
        } else if (scenario === "rejection") {
          await proposal
            .getByRole("button", { name: "Reject task proposal" })
            .click();
          await expect(
            page.getByText(
              "The task proposal was rejected. No task was created.",
              { exact: true },
            ),
          ).toBeVisible();
          await page.reload();
          await expect(
            page.getByRole("button", { name: "Approve and create task" }),
          ).toHaveCount(0);
        } else {
          if (
            scenario === "success" ||
            scenario === "interrupted_settlement" ||
            scenario === "existing_work"
          ) {
            await proposal
              .getByText("Edit task preview", { exact: true })
              .click();
            await proposal
              .getByRole("textbox", { name: "Task title", exact: true })
              .fill("Agree a room change with the venue");
            await proposal
              .getByRole("button", { name: "Save edited task preview" })
              .click();
            await expect(
              page.getByText(
                "The edited task was saved as a new preview. Review it before approval.",
                { exact: true },
              ),
            ).toBeVisible();
            proposal = page.locator("section[data-proposal-id]").filter({
              has: page.getByRole("heading", {
                name: "Agree a room change with the venue",
                exact: true,
              }),
            });
          }
          if (scenario === "interrupted_settlement") {
            const interrupted = await request.post(
              "/demo/fixtures/assistant-proposal",
              {
                form: {
                  intent: "interrupt_task_settlement",
                  confirm: confirmation,
                  confirmed: "yes",
                  scenario: fixtureScenario,
                  eventId: fixture.eventId,
                  prompt,
                  proposalId:
                    (await proposal.getAttribute("data-proposal-id")) ?? "",
                },
                headers: { origin: e2eOrigin },
              },
            );
            expect(interrupted.status()).toBe(500);
            expect((await interrupted.json()).error).toContain(
              "interruption after task creation",
            );
            await page.reload();
            const report = page.getByRole("region", {
              name: "Previous assistant requests",
            });
            await report.locator("summary").first().click();
            await expect(report).toContainText("Task created");
            await expect(report).toContainText(
              "The task was created. Retry the approval to finish recording the assistant result",
            );
            await expect(
              report.getByRole("link", { name: "Open task", exact: true }),
            ).toBeVisible();
            await report.locator("summary").first().click();
          }
          await proposal.getByRole("checkbox").check();
          await proposal
            .getByRole("button", { name: "Approve and create task" })
            .click();
          if (scenario === "stale_before_approval") {
            await expect(
              page.getByRole("alert", {
                name: /readiness blocker, supporting records or eligible owners changed after inspection/,
              }),
            ).toBeVisible();
            await expect(
              proposal.getByRole("link", { name: "Open created task" }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("button", { name: "Approve and create task" }),
            ).toHaveCount(0);
          } else {
            await expect(
              proposal.getByText("Executed", { exact: true }),
            ).toBeVisible();
            await proposal
              .getByRole("link", { name: "Open created task" })
              .click();
            await expect(page).toHaveURL(/\/admin\/tasks\?task=/);
            await page.reload();
            await expect(
              page
                .getByText("Agree a room change with the venue", {
                  exact: true,
                })
                .first(),
            ).toBeVisible();
            await page.goto("/admin/assistant");
            await page.getByText(/Previous action previews \(/).click();
            await expect(
              page.getByRole("link", { name: "Open created task" }),
            ).toBeVisible();
            if (scenario === "existing_work") {
              await page
                .getByRole("textbox", { name: "Request", exact: true })
                .fill(prompt);
              await page
                .getByRole("button", { name: "Ask assistant", exact: true })
                .click();
              await expect(
                page
                  .locator("section.card")
                  .filter({
                    has: page.getByRole("heading", {
                      name: "Assistant answer",
                      exact: true,
                    }),
                  })
                  .getByText(
                    /Follow the existing coordination task in the inspected sources/,
                  ),
              ).toBeVisible();
              await expect(
                page.getByText(/Sources inspected \(/).first(),
              ).toBeVisible();
              await page
                .getByText(/Sources inspected \(/)
                .first()
                .click();
              await expect(
                page.getByRole("link", {
                  name: /Agree a room change with the venue/,
                }),
              ).toBeVisible();
              await expect(
                page.getByRole("button", { name: "Approve and create task" }),
              ).toHaveCount(0);
            }
          }
        }
      } else if (scenario === "delivery_failures") {
        const delivery = fixture.result?.evidence.find((record) =>
          record.href?.includes("deliveryCommunication="),
        );
        if (!delivery?.href)
          throw new Error("Expected the inspected failed delivery link");
        const communicationId = new URL(
          delivery.href,
          e2eOrigin,
        ).searchParams.get("deliveryCommunication");
        await page
          .getByText(/Sources inspected \(/)
          .first()
          .click();
        await page.getByRole("link", { name: /Venue contact/ }).click();
        await expect(page).toHaveURL(new URL(delivery.href, e2eOrigin).href);
        const health = page.getByRole("region", { name: "Delivery health" });
        await expect(health).toContainText(
          `Selected communication · ${communicationId}`,
        );
        await expect(
          health.getByRole("row", { name: /Venue contact/ }),
        ).toBeVisible();
        await expect(health).not.toContainText("Other communication recipient");
        await page.reload();
        await expect(
          health.getByRole("row", { name: /Venue contact/ }),
        ).toBeVisible();
        await page.goto("/admin/assistant");
      } else if (scenario !== "provider_failure") {
        await expect(
          page.getByRole("button", { name: "Approve and create task" }),
        ).toHaveCount(0);
        await expect(
          page
            .locator("section.card")
            .filter({
              has: page.getByRole("heading", {
                name: "Assistant answer",
                exact: true,
              }),
            })
            .getByText(
              scenario === "no_blockers"
                ? /No readiness blockers were detected.*setup is incomplete/
                : /supporting record lacks enough detail/,
            ),
        ).toBeVisible();
      }
      await page.reload();
      const reports = page.getByRole("region", {
        name: "Previous assistant requests",
      });
      const summary = reports.locator("summary").first();
      await expect(summary).toContainText(prompt);
      await expect(summary).not.toContainText(/model calls|fixture-readiness/);
      await expect(summary.locator("time")).toBeVisible();
      await summary.focus();
      await summary.press("Enter");
      if (scenario === "provider_failure") {
        await expect(
          reports
            .getByText("No accepted answer was retained for this request.")
            .first(),
        ).toBeVisible();
      } else {
        await expect(reports.locator(".pc-assist-answer").first()).toHaveText(
          fixture.result?.answer ?? "",
        );
      }
      const evidenceDisclosure = reports
        .getByText("AI details and audit trail", { exact: true })
        .first();
      await expect(reports.locator("pre").first()).not.toBeVisible();
      await evidenceDisclosure.click();
      await expect(reports).toContainText(
        scenario === "provider_failure" ? "2 model calls" : "model calls",
      );
      await expect(reports).toContainText("Estimated inference cost: unknown");
      const retained = JSON.parse(
        await reports.locator("pre").first().innerText(),
      );
      await evidenceDisclosure.click();
      expect(retained.status).toBe(
        scenario === "provider_failure" ? "failed" : "completed",
      );
      if (scenario === "interrupted_settlement")
        expect(retained.proposals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              execution: "completed",
              settlement: "completed",
            }),
          ]),
        );
      await mkdir(".artifacts/assistant-workflow", { recursive: true });
      await writeFile(
        `.artifacts/assistant-workflow/${scenario}.json`,
        JSON.stringify(
          {
            mode: "demonstration",
            realModelCalled: false,
            scenario,
            report: retained,
          },
          null,
          2,
        ),
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `.artifacts/assistant-workflow/${scenario}.png`,
        fullPage: true,
      });
    } finally {
      await configure(false);
    }
  });
}

import { expect, test, type Page } from "@playwright/test";

import { acceptConfirm } from "./support/confirm-dialog";
import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

const FIXTURE_CONFIRMATION = "seed-golden-path-browser-fixture";
const PART_SIZE_BYTES = 10 * 1_048_576;
const EVIDENCE_BYTES = Buffer.from(
  "%PDF-1.4\nProgram Cue deterministic local task evidence.\n%%EOF\n",
);
const LOCAL_PART_URL = `${e2eOrigin}/__e2e/r2/part-1`;

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function expectStatus(page: Page, text: string) {
  await expect(
    page.getByRole("status").filter({ hasText: text }).first(),
  ).toBeVisible();
}

async function switchDemoRole(page: Page, role: "administrator" | "speaker") {
  const response = await page.request.post("/demo/role", {
    form: { identity: role },
    headers: { origin: e2eOrigin },
  });
  expect(response.ok()).toBeTruthy();
}

test.describe
  .serial("canonical provider boundaries", () => {
    test.beforeAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test.afterAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test("attaches local private evidence, records exact resource acknowledgement and fails closed while scanning is pending", async ({
      page,
      request,
    }) => {
      const fixture = await request.post("/demo/fixtures/golden-path", {
        form: {
          intent: "seed_task_evidence",
          confirm: FIXTURE_CONFIRMATION,
        },
        headers: { origin: e2eOrigin },
      });
      const fixtureText = await fixture.text();
      expect(fixture.ok(), fixtureText).toBeTruthy();
      const evidence = JSON.parse(fixtureText) as {
        demonstrationOnly: boolean;
        providerCalled: boolean;
        providerBoundary: string;
        localObjectStored: boolean;
        assetId: string;
        versionId: string;
        taskId: string;
        filename: string;
        sizeBytes: number;
      };
      expect(evidence).toMatchObject({
        demonstrationOnly: true,
        providerCalled: true,
        providerBoundary: "local-r2-binding",
        localObjectStored: true,
        taskId: "task-demo-slides",
        filename: "golden-path-evidence.pdf",
        sizeBytes: EVIDENCE_BYTES.byteLength,
      });

      const multipartOperations: string[] = [];
      await page.route("**/files/multipart/**", async (route) => {
        const operation = new URL(route.request().url()).pathname
          .split("/")
          .at(-1)!;
        const body = route.request().postDataJSON() as Record<string, unknown>;
        multipartOperations.push(operation);
        if (operation === "resume") {
          expect(body).toMatchObject({
            filename: evidence.filename,
            contentType: "application/pdf",
            sizeBytes: evidence.sizeBytes,
            target: {
              targetType: "task",
              targetId: evidence.taskId,
              assetKind: "task_evidence",
            },
          });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, upload: null }),
          });
          return;
        }
        if (operation === "initiate") {
          expect(body).toMatchObject({
            target: { targetType: "task", targetId: evidence.taskId },
          });
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              upload: {
                assetId: evidence.assetId,
                versionId: evidence.versionId,
                partSizeBytes: PART_SIZE_BYTES,
                partCount: 1,
                expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
              },
            }),
          });
          return;
        }
        if (operation === "part-url") {
          expect(body).toMatchObject({
            versionId: evidence.versionId,
            partNumber: 1,
          });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              part: { url: LOCAL_PART_URL },
            }),
          });
          return;
        }
        if (operation === "complete") {
          expect(body).toMatchObject({
            versionId: evidence.versionId,
            parts: [{ partNumber: 1, etag: '"local-r2-fixture"' }],
          });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              upload: {
                assetId: evidence.assetId,
                versionId: evidence.versionId,
                scanStatus: "pending",
              },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: `Unexpected ${operation} operation.` }),
        });
      });
      await page.route("**/__e2e/r2/**", async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({
            status: 204,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "PUT, OPTIONS",
              "access-control-allow-headers": "content-type",
            },
          });
          return;
        }
        expect(route.request().method()).toBe("PUT");
        expect(route.request().postDataBuffer()).toEqual(EVIDENCE_BYTES);
        await route.fulfill({
          status: 200,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "ETag",
            etag: '"local-r2-fixture"',
          },
        });
      });
      let releaseAttachment: (() => void) | undefined;
      let markAttachmentRequested: (() => void) | undefined;
      const attachmentRequested = new Promise<void>((resolve) => {
        markAttachmentRequested = resolve;
      });
      const attachmentRelease = new Promise<void>((resolve) => {
        releaseAttachment = resolve;
      });
      await page.route("**/files/task-evidence", async (route) => {
        markAttachmentRequested?.();
        await attachmentRelease;
        await route.continue();
      });

      await switchDemoRole(page, "speaker");
      await waitForInterface(page, "/participant/tasks");
      const uploadTask = page.locator("article.speaker-task").filter({
        hasText: "Upload presentation slides",
      });
      await uploadTask.locator('input[type="file"]').setInputFiles({
        name: evidence.filename,
        mimeType: "application/pdf",
        buffer: EVIDENCE_BYTES,
      });
      await uploadTask.getByRole("button", { name: "Upload file" }).click();
      await attachmentRequested;
      await expect(uploadTask.getByRole("status")).toContainText(
        "Transfer complete. Finalizing",
      );
      await expect(
        uploadTask.getByRole("button", { name: "Pause upload" }),
      ).toBeHidden();
      await expect(
        uploadTask.getByRole("button", { name: "Cancel upload" }),
      ).toBeHidden();
      releaseAttachment?.();
      await expect(
        uploadTask.getByText("Submitted", { exact: true }),
      ).toBeVisible();
      await expect(uploadTask).toContainText(
        "Stored for administrator review. You can upload a newer version while review is pending.",
      );
      expect(multipartOperations).toEqual([
        "resume",
        "initiate",
        "part-url",
        "complete",
      ]);

      await waitForInterface(
        page,
        "/participant/resources?resource=speaker-handbook",
      );
      await page
        .getByLabel("I have read and understood this published resource")
        .check();
      await page.getByRole("button", { name: "Acknowledge version" }).click();
      await expectStatus(
        page,
        "Acknowledgement recorded for this exact published version",
      );
      await expect(
        page.getByText("You acknowledged this exact published version."),
      ).toBeVisible();
      await waitForInterface(page, "/participant/tasks");
      const handbookTask = page.locator("article.speaker-task").filter({
        hasText: "Read the speaker handbook",
      });
      await expect(
        handbookTask.getByText("Complete", { exact: true }),
      ).toBeVisible();

      await switchDemoRole(page, "administrator");
      await waitForInterface(page, "/admin/tasks");
      const evidenceRow = page.getByRole("row", {
        name: /Upload presentation slides.*Priya Shah/i,
      });
      await expect(evidenceRow).toContainText(
        "Latest evidence: submitted · private file",
      );
      await expect(evidenceRow).toContainText(
        "Download remains unavailable until the exact submitted version passes scanning.",
      );
      await evidenceRow.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByRole("alert")).toContainText(
        "File evidence is still quarantined or failed scanning; it cannot be approved.",
      );
      await expect(
        evidenceRow.getByText("Submitted", { exact: true }),
      ).toBeVisible();
      await expect(evidenceRow).toContainText(
        "Latest evidence: submitted · private file",
      );
    });

    test("records an Accelevents dry run and retries one explicit no-write failure without claiming provider success", async ({
      page,
      request,
    }) => {
      const fixture = await request.post("/demo/fixtures/golden-path", {
        form: {
          intent: "seed_accelevents_no_write",
          confirm: FIXTURE_CONFIRMATION,
        },
        headers: { origin: e2eOrigin },
      });
      const fixtureText = await fixture.text();
      expect(fixture.ok(), fixtureText).toBeTruthy();
      const integration = JSON.parse(fixtureText) as {
        demonstrationOnly: boolean;
        providerCalled: boolean;
        providerBoundary: string;
        connectionId: string;
        operationId: string;
      };
      expect(integration).toMatchObject({
        demonstrationOnly: true,
        providerCalled: false,
        providerBoundary: "accelevents",
      });

      await switchDemoRole(page, "administrator");
      await waitForInterface(
        page,
        `/admin/integrations?connection=${encodeURIComponent(integration.connectionId)}`,
      );
      await expect(
        page.getByText(
          "Demonstration only · no credentials or provider validation",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByText("Demonstration only", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Demonstration only · provider not called", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(/no Accelevents success is simulated/i),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Live export unavailable in demo" }),
      ).toBeDisabled();
      const preview = page.locator('[aria-label="Accelevents export preview"]');
      await expect(preview).toContainText("AI in Event Operations");
      expect(await preview.getByRole("row").count()).toBeGreaterThan(1);

      await page.getByRole("button", { name: "Record this preview" }).click();
      await expect(page.locator(".pc-status-notice")).toContainText(
        "Preview recorded. Nothing was written to Accelevents.",
      );
      const dryRun = page.getByRole("row", {
        name: /accelevents.*Preview only/i,
      });
      await expect(dryRun).toContainText("Succeeded");

      await waitForInterface(
        page,
        `/admin/operations?operation=${encodeURIComponent(integration.operationId)}`,
      );
      const results = page.locator(
        'section[aria-labelledby="operation-items-heading"]',
      );
      let failedItem = results.getByRole("row", { name: /demo-session-2/i });
      await expect(failedItem).toContainText(/failed/i);
      await expect(failedItem).toContainText(
        "Demo no-write fixture: no Accelevents request was made.",
      );
      await failedItem
        .getByRole("button", { name: "Retry demo-session-2", exact: true })
        .click();
      await acceptConfirm(page);
      await expect(
        page.getByRole("status").filter({
          hasText:
            "Only the selected failed Accelevents record was queued for retry.",
        }),
      ).toBeVisible();

      await expect
        .poll(
          async () => {
            await page.reload();
            await page.locator("body[data-hydrated='true']").waitFor();
            failedItem = page
              .locator('section[aria-labelledby="operation-items-heading"]')
              .getByRole("row", { name: /demo-session-2/i });
            return (await failedItem.textContent())?.replace(/\s+/g, " ") ?? "";
          },
          {
            message: "the explicit no-write provider retry to fail durably",
            timeout: 30_000,
          },
        )
        .toMatch(
          /failed.*2.*Demo no-write fixture: no Accelevents request was made/i,
        );
    });
  });

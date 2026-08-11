import { expect, test } from "@playwright/test";

test("form drafts restore explicitly and stale browser payloads are pruned", async ({
  page,
}) => {
  await page.goto("/admin/submissions/form");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("program-cue-draft-recovery");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Draft database is blocked"));
    });
  });
  await page.reload();

  const introduction = page.getByLabel("Introduction");
  const serverValue = await introduction.inputValue();
  const recoveredValue = `Unsubmitted browser recovery ${Date.now()}`;
  await introduction.fill(recoveredValue);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  await page.reload();
  await expect(introduction).toHaveValue(serverValue);
  await expect(
    page.getByRole("button", { name: "Restore local edits" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore local edits" }).click();
  await expect(introduction).toHaveValue(recoveredValue);
  await expect(page.getByText("Restored draft", { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Discard recovery copy" }).click();
  await expect(introduction).toHaveValue(serverValue);

  const expiredKey = JSON.stringify([
    1,
    "expired-event",
    "expired-person",
    "review",
    "expired-record",
  ]);
  await page.evaluate(async (key) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("program-cue-draft-recovery", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("snapshots", "readwrite");
        transaction.objectStore("snapshots").put({
          key,
          eventId: "expired-event",
          personId: "expired-person",
          recordType: "review",
          recordId: "expired-record",
          schemaVersion: 1,
          serverRevision: "1",
          payload: { privateNotes: "expired private data" },
          savedAt: Date.now() - 10_000,
          expiresAt: Date.now() - 1,
          writerId: "expired-writer",
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, expiredKey);

  await page.reload();
  await expect(page.getByText("Checking recovery…", { exact: true })).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(async (key) => {
        return new Promise<boolean>((resolve, reject) => {
          const request = indexedDB.open("program-cue-draft-recovery", 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction("snapshots", "readonly");
            const get = transaction.objectStore("snapshots").get(key);
            get.onsuccess = () => resolve(get.result === undefined);
            get.onerror = () => reject(get.error);
            transaction.oncomplete = () => database.close();
          };
        });
      }, expiredKey),
    )
    .toBe(true);
});

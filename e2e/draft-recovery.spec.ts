import { expect, test, type Page } from "@playwright/test";

async function clearDraftRecovery(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("program-cue-draft-recovery", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("snapshots", "readwrite");
        transaction.objectStore("snapshots").clear();
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  });
}

test("form drafts restore explicitly and stale browser payloads are pruned", async ({
  page,
}) => {
  await page.goto("/admin/submissions/form");
  await page.locator("body[data-hydrated='true']").waitFor();
  await clearDraftRecovery(page);
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
  await expect(
    page.getByText("Checking recovery…", { exact: true }),
  ).toBeHidden();
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

test("restored review notes restore their character count", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/review/workbench");
  await page.locator("body[data-hydrated='true']").waitFor();
  await clearDraftRecovery(page);
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();

  const feedback = page.getByLabel("Applicant feedback");
  const count = page.locator("#review-note-submitterFeedback-count");
  const recoveredValue = `Recovered reviewer note ${Date.now()}`;
  await expect(
    page.getByText("Checking recovery…", { exact: true }),
  ).toBeHidden();
  await page.evaluate(async (recoveredFeedback) => {
    const form = document.querySelector<HTMLFormElement>("#review-score-form");
    if (!form) throw new Error("Review form was not rendered.");
    const values = new FormData(form);
    const assignmentId = String(values.get("assignmentId") ?? "");
    const serverRevision = String(values.get("revision") ?? "");
    const scores = Object.fromEntries(
      Array.from(values.entries())
        .filter(([name]) => name.startsWith("score:"))
        .map(([name, value]) => [name.slice("score:".length), String(value)]),
    );
    const key = JSON.stringify([
      1,
      "evt-foe-2025",
      "person-demo-evaluator",
      "review",
      assignmentId,
    ]);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("program-cue-draft-recovery", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("snapshots", "readwrite");
        transaction.objectStore("snapshots").put({
          key,
          eventId: "evt-foe-2025",
          personId: "person-demo-evaluator",
          recordType: "review",
          recordId: assignmentId,
          schemaVersion: 1,
          serverRevision,
          payload: {
            scores,
            recommendation: String(values.get("recommendation") ?? ""),
            confidence: String(values.get("confidence") ?? ""),
            submitterFeedback: recoveredFeedback,
            privateNotes: String(values.get("privateNotes") ?? ""),
            aiSuggestionId: null,
            aiImportedCriterionIds: [],
            conflictAffirmed: String(values.get("conflictAffirmed") ?? ""),
          },
          savedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          writerId: "review-count-regression",
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, recoveredValue);

  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("button", { name: "Restore local edits" }),
  ).toBeVisible();
  await page.clock.install();
  await page.getByRole("button", { name: "Restore local edits" }).click();

  await expect(feedback).toHaveValue(recoveredValue);
  await expect(count).toContainText(`${recoveredValue.length} / 8,000`);
});

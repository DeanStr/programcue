import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { origin, aek, root, run } from "./runtime.mjs";

export async function prepareLocal() {
  // Only the coordinator starts this isolated loopback target. This helper never
  // accepts a remote URL or reads production credentials.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/demo`);
    await page.locator("body[data-hydrated='true']").waitFor();
    await Promise.all([
      page.waitForURL(`${origin}/admin/command`),
      page.getByRole("button", { name: "Continue as Jordan Alvarez", exact: true }).click(),
    ]);
    await page.goto(`${origin}/demo`);
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.locator('input[name="confirmation"]').fill("Future of Events 2027");
    await page.getByRole("button", { name: "Reset complete demo event", exact: true }).click();
    await page.getByRole("button", { name: "Reset demo event", exact: true }).click();
    await page
      .getByText(
        "The D1 event and private demo file prefix were restored to the judged baseline. Refresh other open views before continuing.",
        { exact: true },
      )
      .waitFor({ timeout: 60000 });
  } finally {
    await browser.close();
  }
  const sessions = {};
  for (const [persona, name] of [
    ["organizer", "Jordan Alvarez"],
    ["speaker", "Priya Raman"],
    ["reviewer", "Sam Whitfield"],
    ["showcase_speaker", "Priya Shah"],
  ]) {
    const output = await run(
      process.execPath,
      [
        aek,
        "auth",
        "--json",
        "--config",
        "evalkit.local.yaml",
        "--persona",
        persona,
        "--at",
        "/demo",
        "--click",
        `Continue as ${name}`,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
    );
    const result = JSON.parse(output);
    if (result.persona !== persona || typeof result.storageStatePath !== "string")
      throw new Error("Invalid aek auth JSON result");
    sessions[persona] = result.storageStatePath;
  }
  fs.writeFileSync(path.join(root, ".agent-eval/local-sessions.json"), JSON.stringify(sessions), {
    mode: 0o600,
  });
  console.log(
    "Reset the isolated local fixture and captured four fresh role states. Fixture access is not signup or email-delivery evidence.",
  );
}

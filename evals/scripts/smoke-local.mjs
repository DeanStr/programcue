import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createMailpitMailbox } from "agent-eval-kit/email";
import { origin, root } from "./runtime.mjs";

const sessions = JSON.parse(
  fs.readFileSync(path.join(root, ".agent-eval/local-sessions.json"), "utf8"),
);
const browser = await chromium.launch({ headless: true });
const evidence = path.join(root, ".agent-eval/local-smoke");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const checks = [];
try {
  for (const [persona, identity] of [
    ["organizer", "administrator"],
    ["speaker", "sbek_speaker"],
    ["reviewer", "sbek_reviewer"],
  ]) {
    const state = JSON.parse(fs.readFileSync(sessions[persona], "utf8"));
    assert.equal(
      state.cookies.find((cookie) => cookie.name === "program_cue_demo_identity")?.value,
      identity,
    );
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/demo`);
    assert.equal(response.status(), 200);
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.screenshot({ path: path.join(evidence, `${persona}.png`) });
    checks.push({ persona, identity, status: response.status() });
    await context.close();
  }
  const anonymous = await browser.newContext();
  const page = await anonymous.newPage();
  const response = await page.goto(`${origin}/public/programme/future-of-events-2027`);
  assert.equal(response.status(), 200);
  await page.locator("body[data-hydrated='true']").waitFor();
  assert.equal(
    (await anonymous.cookies()).some((cookie) => cookie.name === "program_cue_demo_identity"),
    false,
  );
  await page.screenshot({ path: path.join(evidence, "anonymous-programme.png") });
  await anonymous.close();
  const mailbox = createMailpitMailbox({
    baseUrl: "http://127.0.0.1:8025",
    address: "sbek-speaker@example.com",
  });
  await mailbox.list();
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        kind: "local-fixture-smoke",
        checks,
        publicProgramme: "anonymous HTTP 200",
        mailpit: "list healthy",
        limitations: ["No LLM judging", "No external-provider acceptance"],
      },
      null,
      2,
    ),
  );
  console.log(`Local preparation smoke passed; screenshots and result: ${evidence}`);
} finally {
  await browser.close();
}

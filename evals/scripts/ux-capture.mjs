import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { project, root, run, stopGroup, waitForWorker } from "./runtime.mjs";
import { surfaces, viewports, sha256 } from "./ux-contract.mjs";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    checkout: { type: "string", default: project },
    variant: { type: "string", default: "normal" },
  },
});
if (!values.output || !["normal", "unreadable"].includes(values.variant))
  throw new Error(
    "Usage: npm run ux:capture -- --output NEW_DIRECTORY [--checkout PATH] [--variant unreadable]",
  );
const checkout = fs.realpathSync(values.checkout);
const output = path.resolve(values.output);
if (fs.existsSync(output)) throw new Error("Capture output must be a new directory");
function source() {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      // A UI revision can include many binary Playwright baselines.
      maxBuffer: 64 * 1024 * 1024,
    });
  return {
    revision: git("rev-parse", "HEAD").toString().trim(),
    diffSha256: sha256(git("diff", "HEAD", "--binary")),
    untracked: git("ls-files", "--others", "--exclude-standard", "-z")
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((file) => ({
        file,
        sha256: sha256(fs.readFileSync(path.join(checkout, file))),
      })),
  };
}
const provenance = source();
const port = 5196;
const origin = `http://127.0.0.1:${port}`;
for (const candidatePort of [port, 15196]) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(candidatePort, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
fs.mkdirSync(output, { recursive: true });
const state = `.wrangler/e2e-state-ux-${randomUUID()}`;
const env = {
  ...process.env,
  PROGRAM_CUE_E2E_PORT: String(port),
  PROGRAM_CUE_E2E_INSPECTOR_PORT: "15196",
  PROGRAM_CUE_E2E_STATE: state,
  PROGRAM_CUE_E2E_SKIP_BUILD: "0",
};
let worker;
let browser;
let interrupted;
const startup = new AbortController();
const interrupt = () => {
  interrupted = true;
  startup.abort(new Error("UX capture interrupted"));
  void stopGroup(worker);
};
try {
  await run(process.execPath, ["scripts/prepare-e2e.mjs"], { cwd: checkout, env });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const log = fs.openSync(path.join(output, "worker.log"), "w", 0o600);
  worker = spawn(process.execPath, ["scripts/serve-e2e-worker.mjs"], {
    cwd: checkout,
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  await waitForWorker(`${origin}/demo`, { worker, signal: startup.signal });
  browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: origin,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  await context.addCookies([
    { name: "program_cue_demo_identity", value: "administrator", domain: "127.0.0.1", path: "/" },
    { name: "program_cue_event", value: "evt-foe-2025", domain: "127.0.0.1", path: "/" },
  ]);
  const reset = await context.request.post("/demo.data", {
    form: { intent: "reset", confirmation: "Future of Events 2027" },
    headers: { origin },
  });
  if (!reset.ok()) throw new Error(`Isolated fixture reset failed: ${reset.status()}`);
  const bytes = await reset.body();
  const decoded = await UNSAFE_decodeViaTurboStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    globalThis,
  );
  await decoded.done;
  if (decoded.value.data?.committed !== true)
    throw new Error("Isolated fixture reset did not commit");
  for (const route of [
    "/admin/command",
    "/admin/review",
    "/admin/resources",
    "/admin/tasks",
    "/admin/schedule",
    "/admin/submissions/form",
    "/embed/future-of-events-2027",
  ]) {
    const response = await context.request.get(route);
    if (!response.ok())
      throw new Error(`Fixture initialisation failed: ${route} (${response.status()})`);
  }
  const views = [];
  for (const surface of surfaces)
    for (const [device, viewport] of Object.entries(viewports)) {
      await context.addCookies([
        {
          name: "program_cue_demo_identity",
          value: surface.role ?? "administrator",
          domain: "127.0.0.1",
          path: "/",
        },
      ]);
      const page = await context.newPage();
      const failures = [];
      page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
      await page.setViewportSize(viewport);
      const response = await page.goto(surface.route);
      if (!response.ok()) throw new Error(`Page failed: ${surface.route} (${response.status()})`);
      try {
        await page.locator('body[data-hydrated="true"]').waitFor();
      } catch (error) {
        fs.writeFileSync(
          path.join(output, "capture-error.json"),
          `${JSON.stringify(
            {
              surface: surface.id,
              device,
              route: surface.route,
              responseStatus: response.status(),
              pageErrors: failures,
              workerExitCode: worker.exitCode,
              workerSignal: worker.signalCode,
              message: error.message,
            },
            null,
            2,
          )}\n`,
        );
        await page.screenshot({ path: path.join(output, "capture-error.png") }).catch(() => {});
        throw new Error(
          `Hydration failed for ${surface.id}-${device}; see capture-error.json and worker.log`,
          { cause: error },
        );
      }
      await page.evaluate(() => document.fonts.ready);
      await expect(
        page
          .getByRole("heading", {
            level: 1,
            ...(surface.heading ? { name: surface.heading, exact: true } : {}),
          })
          .first(),
      ).toBeVisible();
      if (surface.id === "form-builder")
        await expect(page.locator(".fb-canvas-page")).toBeVisible();
      if (surface.id === "schedule") await expect(page.locator(".schedule-canvas")).toBeVisible();
      const checks = [];
      async function check(name, action) {
        try {
          await action();
          checks.push(name);
        } catch (error) {
          failures.push(`${name}: ${error.message}`);
        }
      }
      if (device === "mobile" && surface.route.startsWith("/admin/"))
        await check("keyboard navigation and focus return", async () => {
          const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
          await trigger.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toHaveCount(
            0,
          );
          // Dialog restores focus after Radix teardown, on the next frame.
          // Finish that work before another keyboard check moves focus.
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              }),
          );
          await expect(trigger).toBeFocused();
        });
      if (surface.id === "form-builder")
        await check("outline controls and help fit the pane", async () => {
          const layout = page.getByLabel("Applicant layout");
          if (!(await layout.isVisible())) return;
          const overflow = await layout.evaluate((element) => {
            const label = element.closest("label");
            if (!label) throw new Error("Applicant layout needs a label");
            return label.scrollWidth - label.clientWidth;
          });
          expect(overflow).toBeLessThanOrEqual(1);
        });
      if (surface.id === "applications")
        await check("keyboard row selection and clear", async () => {
          const row = page.locator("tbody").getByRole("checkbox").first();
          await row.focus();
          await expect(row).toBeFocused();
          await page.keyboard.press("Space");
          await expect(row).toBeChecked();
          const clear = page.getByRole("button", { name: "Clear selection", exact: true });
          await clear.focus();
          await page.keyboard.press("Enter");
          await expect(row).not.toBeChecked();
        });
      if (values.variant === "unreadable")
        await page.addStyleTag({
          content:
            "main * { color: #eeeeee !important; background-color: #ffffff !important; font-size: 5px !important; }",
        });
      await page.evaluate(() => {
        document.activeElement?.blur();
        window.scrollTo(0, 0);
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) failures.push(`Document horizontal overflow: ${overflow}px`);
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      for (const violation of axe.violations)
        failures.push(
          `axe ${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
        );
      const id = `${surface.id}-${device}`;
      const file = `${id}.png`;
      const heading = await page
        .getByRole("heading", { level: 1 })
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return {
            text: element.textContent,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          };
        });
      const headerControls = await page.locator(".page-actions .btn").evaluateAll((elements) =>
        elements
          .filter((element) => element.getBoundingClientRect().height > 0)
          .slice(0, 3)
          .map((element) => {
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return {
              text: element.textContent?.trim(),
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              borderRadius: style.borderRadius,
              bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            };
          }),
      );
      await page.screenshot({
        path: path.join(output, file),
        fullPage: false,
        animations: "disabled",
        scale: "css",
      });
      views.push({
        id,
        surface: surface.id,
        route: surface.route,
        device,
        viewport,
        file,
        sha256: sha256(fs.readFileSync(path.join(output, file))),
        heading,
        headerControls,
        checks,
        failures,
      });
      console.log(
        `${id}: ${failures.length ? `${failures.length} failures` : "browser checks passed"}`,
      );
      await page.close();
    }
  if (interrupted) throw new Error("UX capture interrupted");
  if (JSON.stringify(source()) !== JSON.stringify(provenance))
    throw new Error("Source changed during capture; discard this capture and repeat");
  fs.writeFileSync(
    path.join(output, "capture.json"),
    `${JSON.stringify(
      {
        version: 1,
        capturedAt: new Date().toISOString(),
        source: provenance,
        variant: values.variant,
        node: process.version,
        chromium: browser.version(),
        methodSha256: sha256(
          Buffer.concat([
            fs.readFileSync(new URL(import.meta.url)),
            fs.readFileSync(new URL("./ux-contract.mjs", import.meta.url)),
            fs.readFileSync(new URL("./runtime.mjs", import.meta.url)),
            fs.readFileSync(path.join(root, "package-lock.json")),
            fs.readFileSync(path.join(project, "package-lock.json")),
          ]),
        ),
        views,
        boundary:
          "Isolated local D1 fixture. Viewport screenshots and listed browser checks only; no provider calls, sends or production acceptance.",
      },
      null,
      2,
    )}\n`,
  );
  if (views.some((view) => view.failures.length)) process.exitCode = 2;
  console.log(`UX capture: ${output}`);
} finally {
  await browser?.close();
  await stopGroup(worker);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  fs.rmSync(path.join(checkout, state), { recursive: true, force: true });
}

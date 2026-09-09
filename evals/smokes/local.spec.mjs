import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";
import { deniesPrivateDownload } from "../scripts/file-access-checks.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { root, origin } from "../scripts/runtime.mjs";

async function open(page, url) {
  const response = await page.goto(url);
  expect(response.ok()).toBe(true);
  await page.locator("body[data-hydrated='true']").waitFor();
}
async function screenshot(page, info, name) {
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}

test("merged email preview renders inside its opaque sandbox on desktop and mobile", async ({
  page,
}, info) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await open(page, "/admin/communications/compose");
  await page.getByLabel("Published template").selectOption({ label: "Speaker welcome · v1" });
  await page.getByLabel("Audience").selectOption("manual");
  await page
    .getByRole("textbox", { name: /Manual addresses/ })
    .fill("Priya Shah <priya.speaker@example.com>");
  await page.getByRole("button", { name: "Create durable draft", exact: true }).click();
  await page.getByRole("button", { name: "Generate current preview", exact: true }).click();
  for (const mode of ["Desktop", "Mobile"]) {
    await page
      .getByRole("group", { name: "Email preview size" })
      .getByRole("button", { name: mode, exact: true })
      .click();
    const iframe = page.locator(
      `iframe[title="Representative merged email · ${mode.toLowerCase()} preview"]`,
    );
    await expect(iframe).toHaveAttribute("sandbox", "");
    await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(iframe.contentFrame().getByText("Hi Priya,", { exact: true })).toBeVisible();
    await expect(
      iframe
        .contentFrame()
        .getByText("Welcome to Future of Events 2027. Your speaker workspace is ready.", {
          exact: true,
        }),
    ).toBeVisible();
    if (mode === "Mobile") expect((await iframe.boundingBox()).width).toBeLessThanOrEqual(390);
    const file = info.outputPath(`email-${mode.toLowerCase()}.png`);
    await iframe.screenshot({ path: file });
    await info.attach(`email-${mode.toLowerCase()}`, { path: file, contentType: "image/png" });
  }
  // Playwright tracing attempts to instrument the opaque frame. The sandbox must reject it.
  expect(
    errors.filter(
      (message) =>
        message !==
        "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.",
    ),
  ).toEqual([]);
  await info.attach("browser-console", {
    body: JSON.stringify(errors),
    contentType: "application/json",
  });
  const directory = info.outputPath("aek-preview");
  fs.mkdirSync(directory, { recursive: true });
  const state = path.join(directory, "state.json");
  await page.context().storageState({ path: state });
  const config = YAML.parse(fs.readFileSync(path.join(root, "evalkit.local.yaml"), "utf8"));
  const contextFile = path.join(directory, "context.json");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({
      targetUrl: origin,
      allowedOrigins: [origin],
      evidenceDir: directory,
      storageStatePath: state,
      expectAuthenticated: true,
      fixtureFiles: {},
      requiredCheckpoints: [],
      headless: true,
      viewport: { width: 1440, height: 1000 },
      actionTimeoutMs: 10000,
      maxToolCalls: 10,
      readOnlyFrames: config.browser.readOnlyFrames,
    }),
  );
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules/.bin/aek-browser-mcp"),
    args: [contextFile],
    stderr: "pipe",
  });
  const client = new Client({ name: "programcue-preview-smoke", version: "1" });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  };
  try {
    await client.connect(transport);
    const initial = await call("navigate", { url: page.url() });
    const generate = initial.match(/\[(e\d+)\] <button[^>]*> Generate current preview/);
    expect(generate, initial).not.toBeNull();
    await call("click", { ref: generate[1] });
    await call("wait", { ms: 500 });
    const snapshot = await call("snapshot");
    expect(snapshot).toContain("Hi Priya,");
    expect(snapshot).toContain("approved read-only preview");
    expect(snapshot).toContain("Your speaker workspace is ready.");
    await call("scroll", { direction: "down" });
    await call("scroll", { direction: "down" });
    await call("screenshot", { label: "aek-merged-preview", fullPage: false });
    const shots = JSON.parse(fs.readFileSync(path.join(directory, "screenshots.json"), "utf8"));
    await info.attach("aek-merged-preview", {
      path: path.join(directory, shots.at(-1).path),
      contentType: "image/jpeg",
    });
  } finally {
    await client.close();
    await transport.close();
  }
  // Deliberately stop at preview: this smoke sends no notifications.
});

test("draft content stays private until approved and explicitly published", async ({
  page,
  browser,
}, info) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const publicPage = await anonymous.newPage();
    const publicUrl = `${origin}/public/programme/future-of-events-2027?session=demo-session-1`;
    await open(publicPage, publicUrl);
    await open(page, "/admin/schedule?session=demo-session-1");
    await page.getByRole("button", { name: "Create next draft", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Create the next schedule draft?" })
      .getByRole("button", { name: "Confirm new draft" })
      .click();
    const editor = page.getByTestId("session-content-editor");
    const oldTitle = await editor.getByLabel("Title", { exact: true }).inputValue();
    const title = `${oldTitle} PC-DRAFT-ONLY`;
    await expect(publicPage.locator(".programme-row h3").filter({ hasText: oldTitle })).toHaveCount(
      1,
    );
    await editor.getByLabel("Title", { exact: true }).fill(title);
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
    await open(page, "/admin/schedule?session=demo-session-1");
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(title);
    await open(publicPage, publicUrl);
    await expect(publicPage.locator(".programme-row h3").filter({ hasText: oldTitle })).toHaveCount(
      1,
    );
    await expect(publicPage.locator("body")).not.toContainText("PC-DRAFT-ONLY");
    await screenshot(publicPage, info, "draft-remains-private");
    await page.getByRole("button", { name: "Publish schedule", exact: true }).click();
    const publication = page.getByRole("dialog", { name: "Publish schedule", exact: true });
    await expect(publication.getByRole("button", { name: "Confirm publication" })).toBeDisabled();
    await expect(publication).toContainText(/approv/i);
    await screenshot(page, info, "unapproved-publication-blocked");
    await publication.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.getByRole("link", { name: "Review history" }).click();
    await page.getByLabel("Next status").selectOption("approved");
    await page.getByRole("checkbox", { name: /apply this exact status/i }).check();
    await page.getByRole("button", { name: "Change status" }).click();
    await expect(page.getByText("Content updated", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open schedule" }).click();
    await page.getByRole("button", { name: "Publish schedule", exact: true }).click();
    await expect(publication.getByRole("button", { name: "Confirm publication" })).toBeEnabled();
    await publication.getByRole("button", { name: "Confirm publication" }).click();
    await expect(publication).toBeHidden();
    await open(publicPage, publicUrl);
    await expect(publicPage.locator(".programme-row h3").filter({ hasText: title })).toHaveCount(1);
    expect(
      (await anonymous.cookies()).some((cookie) => cookie.name === "program_cue_demo_identity"),
    ).toBe(false);
    await screenshot(publicPage, info, "approved-content-published");
  } finally {
    await anonymous.close();
  }
});

test("real uploads export only the latest PDF bytes, or report unavailable capture prerequisites", async ({
  page,
  browser,
}, info) => {
  const speaker = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const eventsPath = path.join(root, ".agent-eval/file-services.jsonl");
  const readScans = () =>
    fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((event) => event.type === "scan");
  try {
    const participant = await speaker.newPage();
    await open(participant, `${origin}/demo`);
    await participant.getByRole("button", { name: "Continue as Priya Shah", exact: true }).click();
    await participant.waitForURL("**/participant/dashboard");
    await open(participant, `${origin}/participant/tasks`);
    const task = participant.locator("article").filter({
      has: participant.getByRole("heading", { name: "Upload presentation slides", exact: true }),
    });
    for (const version of [1, 2]) {
      await task.getByLabel("Choose file").setInputFiles({
        name: "AEK-slides.pdf",
        mimeType: "application/pdf",
        buffer: fs.readFileSync(path.join(root, `fixtures/deck-v${version}.pdf`)),
      });
      const pending = participant.waitForResponse((response) =>
        /\/files\/multipart\/(resume|initiate)$/.test(new URL(response.url()).pathname),
      );
      await task.getByRole("button", { name: "Upload file", exact: true }).click();
      const response = await pending;
      if (response.status() === 503 && process.env.PROGRAM_CUE_LOCAL_FILES !== "1") {
        expect(await response.json()).toEqual({
          error: "Uploads are unavailable right now. Try again later.",
        });
        await expect(
          task.getByText("Uploads are unavailable right now. Try again later.", { exact: true }),
        ).toBeVisible();
        await screenshot(participant, info, "upload-prerequisites-unavailable");
        info.annotations.push({
          type: "blocked",
          description:
            "Real upload-to-ZIP acceptance is blocked by the local R2/scanner configuration; no released files were fabricated.",
        });
        test.skip(true, "Local direct-upload/scanner configuration is unavailable (HTTP 503).");
      }
      expect(response.ok()).toBe(true);
      await expect(
        task
          .getByRole("region", { name: "Uploaded file versions" })
          .getByText(`AEK-slides.pdf · v${version}`, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    }
    await open(page, "/admin/content");
    const selected = page.getByRole("checkbox", { name: "Select AEK-slides.pdf", exact: true });
    // An uncompleted scan is missing coverage; a transport error or rejection is a failure.
    const row = page.getByRole("row").filter({ has: selected });
    if (process.env.PROGRAM_CUE_LOCAL_FILES === "1") {
      await expect.poll(() => readScans().length, { timeout: 60_000 }).toBe(2);
      expect(
        readScans().every((scan) => scan.verdict === "clean" && scan.callbackStatus === 200),
      ).toBe(true);
      await expect(async () => {
        await open(page, "/admin/content");
        await expect(selected).toBeEnabled();
      }).toPass({ timeout: 60_000 });
    }
    await expect(row).toBeVisible();
    if (await selected.isDisabled()) {
      await expect(row).toContainText(/pending|quarantin/i);
      await screenshot(page, info, "release-pending");
      info.annotations.push({
        type: "blocked",
        description:
          "Both uploads completed but the latest file has no clean release; no scan verdict was simulated.",
      });
      test.skip(true, "Latest uploaded file remains pending real scanner release.");
    }
    if (process.env.PROGRAM_CUE_LOCAL_FILES === "1") {
      await row.locator("summary").click();
      await expect(row.getByRole("listitem").filter({ hasText: "v2 · clean" })).toContainText(
        "current",
      );
      const retainedUrl = await row
        .getByRole("link", { name: "Download v1", exact: true })
        .getAttribute("href");
      const retained = await page.request.get(retainedUrl);
      expect(retained.ok()).toBe(true);
      expect(await retained.body()).toEqual(
        fs.readFileSync(path.join(root, "fixtures/deck-v1.pdf")),
      );
    }
    await selected.check();
    await page.getByRole("button", { name: "Preview ZIP export", exact: true }).click();
    await page
      .getByRole("checkbox", {
        name: "Download exactly these current released versions",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Generate ZIP", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download ZIP", exact: true }).click({ timeout: 60_000 });
    const file = info.outputPath("latest.zip");
    await (await download).saveAs(file);
    const entries = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          'import sys,zipfile,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([{"name":i.filename,"sha256":hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist() if not i.is_dir()]))',
          file,
        ],
        { encoding: "utf8" },
      ),
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(root, "fixtures/files-expected.json"), "utf8"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sha256).toBe(expected.latestSha256);
    await info.attach("latest-version-zip", { path: file, contentType: "application/zip" });
    if (process.env.PROGRAM_CUE_LOCAL_FILES === "1") {
      // EICAR is an inert antivirus test signature, delivered through the same
      // PDF upload path. Only the real engine decides the infected verdict.
      await open(participant, `${origin}/participant/tasks`);
      await task.getByLabel("Choose file").setInputFiles({
        name: "AEK-slides.pdf",
        mimeType: "application/pdf",
        buffer: fs.readFileSync(path.join(root, "fixtures/eicar-attachment.pdf")),
      });
      await task.getByRole("button", { name: "Upload file", exact: true }).click();
      await expect(
        task
          .getByRole("region", { name: "Uploaded file versions" })
          .getByText("AEK-slides.pdf · v3", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => readScans().length, { timeout: 60_000 }).toBe(3);
      expect(readScans()[2].verdict).toBe("infected");
      expect(readScans()[2].threats.length).toBeGreaterThan(0);
      await open(page, "/admin/content");
      await row.locator("summary").click();
      const infected = row.getByRole("listitem").filter({ hasText: "v3 · infected" });
      await expect(infected).toContainText("Download unavailable");
      await expect(infected.getByRole("link")).toHaveCount(0);
      await expect(row.getByRole("listitem").filter({ hasText: "v2 · clean" })).toContainText(
        "current",
      );
      const cleanUrl = await row
        .getByRole("link", { name: "Download v2", exact: true })
        .getAttribute("href");
      const infectedUrl = cleanUrl.replace(/[^/]+$/, readScans()[2].versionId);
      expect((await page.request.get(infectedUrl)).status()).toBe(404);
      const privateUrl = new URL(cleanUrl, origin).href;
      const expectedBytes = fs.readFileSync(path.join(root, "fixtures/deck-v2.pdf"));
      const control = await page.request.get(privateUrl, { maxRedirects: 0 });
      expect(control.status()).toBe(200);
      expect(await control.body()).toEqual(expectedBytes);
      const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const response = await anonymous.request.get(privateUrl, { maxRedirects: 0 });
        expect(await response.body()).not.toEqual(expectedBytes);
        expect(
          deniesPrivateDownload(
            {
              status: response.status(),
              location: response.headers().location ?? null,
            },
            privateUrl,
          ),
        ).toBe(true);
      } finally {
        await anonymous.close();
      }
      await screenshot(page, info, "infected-version-quarantined");
      await info.attach("real-clamav-receipts", {
        path: eventsPath,
        contentType: "application/x-ndjson",
      });
    }
  } finally {
    await speaker.close();
  }
});

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { readCapture, sha256 } from "./ux-contract.mjs";

const { values } = parseArgs({
  options: { capture: { type: "string" }, output: { type: "string" } },
});
if (!values.capture || !values.output)
  throw new Error("Usage: npm run ui:consistency -- --capture CAPTURE --output NEW_DIRECTORY");
const captureDir = path.resolve(values.capture);
const capture = readCapture(captureDir);
if (capture.variant !== "normal" || capture.views.some((view) => view.failures.length))
  throw new Error("Consistency review requires all browser views to pass");
const output = path.resolve(values.output);
if (fs.existsSync(output)) throw new Error("Consistency output must be a new directory");
const ordinary = [
  "applications",
  "communications",
  "event-settings",
  "branding",
  "evaluation",
  "event-speakers",
  "speaker-directory",
  "speaker-pipeline",
  "speaker-outreach",
  "programme",
  "tasks",
  "resources",
];
const groups = Object.fromEntries(
  ["desktop", "mobile"].map((device) => {
    const views = ordinary.map((surface) =>
      capture.views.find((view) => view.id === `${surface}-${device}`),
    );
    if (views.some((view) => !view.heading || !view.headerControls))
      throw new Error("Recapture with heading/control metrics before checking consistency");
    const signatures = new Set(
      views.map((view) =>
        JSON.stringify(
          Object.fromEntries(
            ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"].map((key) => [
              key,
              view.heading[key],
            ]),
          ),
        ),
      ),
    );
    return [device, { consistent: signatures.size === 1, signatures: signatures.size, views }];
  }),
);
fs.mkdirSync(output, { recursive: true });
let responsiveSha256;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [device, group] of Object.entries(groups)) {
    const inputs = group.views.map((view) => ({
      id: view.id,
      heading: view.heading,
      controls: view.headerControls.filter(
        (control) => control.bounds.y < Math.min(view.viewport.height, view.heading.bounds.y + 200),
      ),
      data: fs.readFileSync(path.join(captureDir, view.file)).toString("base64"),
    }));
    const dataUrl = await page.evaluate(
      async ({ inputs, device }) => {
        const width = device === "desktop" ? 560 : 390;
        const height = 320;
        const canvas = document.createElement("canvas");
        canvas.width = width * 3;
        canvas.height = height * Math.ceil(inputs.length / 3);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#f3f4f1";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const [index, input] of inputs.entries()) {
          const response = await fetch(`data:image/png;base64,${input.data}`);
          const image = await createImageBitmap(await response.blob());
          const x = (index % 3) * width;
          const y = Math.floor(index / 3) * height;
          ctx.fillStyle = "#24352e";
          ctx.font = "600 13px system-ui";
          ctx.fillText(input.id, x + 10, y + 20);
          ctx.font = "12px system-ui";
          ctx.fillText(
            `${input.heading.fontSize} / weight ${input.heading.fontWeight} / line ${input.heading.lineHeight}`,
            x + 10,
            y + 39,
          );
          const box = input.heading.bounds;
          const left = Math.max(0, Math.floor(box.x));
          const top = Math.max(0, Math.floor(box.y - 6));
          const cropWidth = Math.min(width - 20, image.width - left);
          const cropHeight = Math.min(120, image.height - top);
          ctx.drawImage(
            image,
            left,
            top,
            cropWidth,
            cropHeight,
            x + 10,
            y + 50,
            cropWidth,
            cropHeight,
          );
          const controls = input.controls;
          ctx.fillStyle = "#526057";
          ctx.font = "12px system-ui";
          ctx.fillText("Page actions (native size when space permits)", x + 10, y + 192);
          if (controls.length) {
            const left = Math.min(...controls.map((c) => c.bounds.x));
            const top = Math.min(...controls.map((c) => c.bounds.y));
            const right = Math.max(...controls.map((c) => c.bounds.x + c.bounds.width));
            const bottom = Math.max(...controls.map((c) => c.bounds.y + c.bounds.height));
            const scale = Math.min(1, (width - 20) / (right - left), 110 / (bottom - top));
            ctx.drawImage(
              image,
              left,
              top,
              right - left,
              bottom - top,
              x + 10,
              y + 200,
              (right - left) * scale,
              (bottom - top) * scale,
            );
          }
        }
        return canvas.toDataURL("image/png");
      },
      { inputs, device },
    );
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    fs.writeFileSync(path.join(output, `${device}.png`), bytes);
    group.atlasSha256 = sha256(bytes);
  }
  const responsiveInputs = Object.entries(groups).map(([device, group]) => ({
    device,
    views: group.views.map((view) => ({
      id: view.id,
      heading: view.heading,
      data: fs.readFileSync(path.join(captureDir, view.file)).toString("base64"),
    })),
  }));
  const responsiveUrl = await page.evaluate(async (groups) => {
    const rows = Math.ceil(groups[0].views.length / 3);
    const groupHeight = 32 + rows * 130;
    const canvas = document.createElement("canvas");
    canvas.width = 1680;
    canvas.height = groupHeight * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3f4f1";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const [groupIndex, group] of groups.entries()) {
      const tileWidth = group.device === "desktop" ? 560 : 390;
      const offset = (canvas.width - tileWidth * 3) / 2;
      ctx.fillStyle = "#24352e";
      ctx.font = "600 16px system-ui";
      ctx.fillText(
        `${group.device} — ordinary page-title role, native CSS pixels`,
        12,
        groupIndex * groupHeight + 23,
      );
      for (const [index, view] of group.views.entries()) {
        const response = await fetch(`data:image/png;base64,${view.data}`);
        const image = await createImageBitmap(await response.blob());
        const x = offset + (index % 3) * tileWidth;
        const y = groupIndex * groupHeight + 32 + Math.floor(index / 3) * 130;
        ctx.fillStyle = "#526057";
        ctx.font = "12px system-ui";
        ctx.fillText(
          `${view.id}: ${view.heading.fontSize}, weight ${view.heading.fontWeight}`,
          x + 10,
          y + 15,
        );
        const left = Math.max(0, Math.floor(view.heading.bounds.x));
        const top = Math.max(0, Math.floor(view.heading.bounds.y - 5));
        const width = Math.min(tileWidth - 20, image.width - left);
        const height = Math.min(98, image.height - top);
        ctx.drawImage(image, left, top, width, height, x + 10, y + 26, width, height);
        image.close();
      }
    }
    return canvas.toDataURL("image/png");
  }, responsiveInputs);
  const responsiveBytes = Buffer.from(responsiveUrl.split(",")[1], "base64");
  fs.writeFileSync(path.join(output, "responsive.png"), responsiveBytes);
  responsiveSha256 = sha256(responsiveBytes);
} finally {
  await browser.close();
}
const consistent = Object.values(groups).every((group) => group.consistent);
fs.writeFileSync(
  path.join(output, "consistency.json"),
  `${JSON.stringify(
    {
      method: "same-role-headers-v1",
      methodSha256: sha256(fs.readFileSync(new URL(import.meta.url))),
      captureSha256: sha256(JSON.stringify(capture)),
      responsiveSha256,
      captureDir,
      consistent,
      scope:
        "All twelve ordinary administration pages at each viewport. Display and compact workbench titles are separate roles. Control metrics and crops are retained for visual review; control geometry is not automatically scored.",
      groups,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    output,
    consistent,
    signatures: Object.fromEntries(
      Object.entries(groups).map(([key, group]) => [key, group.signatures]),
    ),
  }),
);
if (!consistent) process.exitCode = 2;

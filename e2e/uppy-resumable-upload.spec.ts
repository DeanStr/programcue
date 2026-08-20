import { createHash } from "node:crypto";

import { expect, type Route, test } from "@playwright/test";

const partSize = 10 * 1_048_576;
const fileSize = 12 * 1_048_576;

test("Uppy resumes an interrupted direct upload from R2's server-authoritative part list", async ({
  page,
}) => {
  const fileBuffer = Buffer.alloc(fileSize, 1);
  const providerEtags = [
    `"${createHash("md5").update(fileBuffer.subarray(0, partSize)).digest("hex")}"`,
    `"${createHash("md5").update(fileBuffer.subarray(partSize)).digest("hex")}"`,
  ] as const;
  let durableIdempotencyKey: string | null = null;
  let initiateCalls = 0;
  let listCalls = 0;
  let resuming = false;
  let heldSecondPart: { route: Route; release: () => void } | undefined;
  const completedProviderParts = new Set<number>();

  await page.route("**/files/multipart/**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const idempotencyKey = route.request().headers()["idempotency-key"];
    if (operation === "resume") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          upload:
            durableIdempotencyKey && idempotencyKey === durableIdempotencyKey
              ? {
                  assetId: "asset-browser-resume",
                  versionId: "version-browser-resume",
                  partSizeBytes: partSize,
                  partCount: 2,
                  expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
                  duplicate: true,
                  state: "initiated",
                }
              : null,
        }),
      });
      return;
    }
    if (operation === "initiate") {
      initiateCalls += 1;
      durableIdempotencyKey = idempotencyKey ?? null;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          upload: {
            assetId: "asset-browser-resume",
            versionId: "version-browser-resume",
            partSizeBytes: partSize,
            partCount: 2,
            expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
            duplicate: false,
          },
        }),
      });
      return;
    }
    if (operation === "list-parts") {
      listCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          versionId: "version-browser-resume",
          state: "initiated",
          parts: completedProviderParts.has(1)
            ? [{ PartNumber: 1, Size: partSize, ETag: providerEtags[0] }]
            : [],
        }),
      });
      return;
    }
    if (operation === "part-url") {
      const partNumber = Number(body.partNumber);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          part: {
            url: `https://browser-test.r2.cloudflarestorage.com/part-${partNumber}`,
          },
        }),
      });
      return;
    }
    if (operation === "complete") {
      expect(body).toMatchObject({
        versionId: "version-browser-resume",
        parts: [
          { partNumber: 1, etag: providerEtags[0] },
          { partNumber: 2, etag: providerEtags[1] },
        ],
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          upload: {
            assetId: "asset-browser-resume",
            versionId: "version-browser-resume",
            scanStatus: "pending",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, upload: { aborted: true } }),
    });
  });

  await page.route(
    "https://browser-test.r2.cloudflarestorage.com/**",
    async (route) => {
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
      const partNumber = Number(route.request().url().split("-").at(-1));
      if (!resuming && partNumber === 2) {
        await new Promise<void>((resolve) => {
          heldSecondPart = { route, release: resolve };
        });
        return;
      }
      completedProviderParts.add(partNumber);
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "ETag",
          etag: providerEtags[partNumber - 1]!,
        },
      });
    },
  );

  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/participant/files");
  await page.locator("body[data-hydrated='true']").waitFor();
  const profileUploader = () =>
    page.locator("form.speaker-upload-form").filter({
      has: page.locator('option[value="video"]'),
    });
  let uploader = profileUploader();
  await uploader.getByLabel("File purpose").selectOption("video");
  const file = {
    name: "resume-me.mp4",
    mimeType: "video/mp4",
    buffer: fileBuffer,
  };
  await uploader.locator('input[type="file"]').setInputFiles(file);
  await expect(
    uploader.getByText("Selected file: resume-me.mp4"),
  ).toBeVisible();
  await uploader.getByRole("button", { name: "Upload file" }).click();
  await expect
    .poll(async () =>
      Number(await uploader.locator("progress").getAttribute("value")),
    )
    .toBeGreaterThan(0);
  await uploader.getByRole("button", { name: "Pause upload" }).click();
  await expect(
    uploader.getByText("Upload paused", { exact: false }),
  ).toBeVisible();
  resuming = true;
  if (heldSecondPart) {
    await heldSecondPart.route.abort("aborted");
    heldSecondPart.release();
  }

  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  uploader = profileUploader();
  await uploader.getByLabel("File purpose").selectOption("video");
  await uploader.locator('input[type="file"]').setInputFiles(file);
  await uploader.getByRole("button", { name: "Upload file" }).click();
  await expect(uploader.getByRole("status")).toContainText("Upload complete");
  expect(initiateCalls).toBe(1);
  expect(listCalls).toBe(1);
  expect([...completedProviderParts].sort()).toEqual([1, 2]);
});

test("a failed direct transfer remains resumable and cancellable in place", async ({
  page,
}) => {
  const fileBuffer = Buffer.alloc(1_048_576, 2);
  const providerEtag = `"${createHash("md5").update(fileBuffer).digest("hex")}"`;
  let permitPartUrl = false;
  let completed = false;

  await page.route("**/files/multipart/**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    if (operation === "resume") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, upload: null }),
      });
      return;
    }
    if (operation === "initiate") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          upload: {
            assetId: "asset-in-page-resume",
            versionId: "version-in-page-resume",
            partSizeBytes: partSize,
            partCount: 1,
            expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
            duplicate: false,
          },
        }),
      });
      return;
    }
    if (operation === "list-parts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          versionId: "version-in-page-resume",
          state: "initiated",
          parts: [],
        }),
      });
      return;
    }
    if (operation === "part-url") {
      if (!permitPartUrl) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "Temporary signing failure",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          part: {
            url: "https://browser-test.r2.cloudflarestorage.com/in-page-part-1",
          },
        }),
      });
      return;
    }
    if (operation === "complete") {
      completed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          upload: {
            assetId: "asset-in-page-resume",
            versionId: "version-in-page-resume",
            scanStatus: "pending",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, upload: { aborted: true } }),
    });
  });
  await page.route(
    "https://browser-test.r2.cloudflarestorage.com/**",
    async (route) => {
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
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "ETag",
          etag: providerEtag,
        },
      });
    },
  );
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/participant/files");
  await page.locator("body[data-hydrated='true']").waitFor();
  const uploader = page.locator("form.speaker-upload-form").filter({
    has: page.locator('option[value="video"]'),
  });
  await uploader.getByLabel("File purpose").selectOption("video");
  await uploader.locator('input[type="file"]').setInputFiles({
    name: "retry-in-place.mp4",
    mimeType: "video/mp4",
    buffer: fileBuffer,
  });
  await uploader.getByRole("button", { name: "Upload file" }).click();

  await expect(
    uploader.getByRole("button", { name: "Resume upload" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    uploader.getByRole("button", { name: "Cancel upload" }),
  ).toBeVisible();
  permitPartUrl = true;
  await uploader.getByRole("button", { name: "Resume upload" }).click();
  await expect(uploader.getByRole("status")).toContainText("Upload complete");
  await expect(uploader.getByText("No file selected.")).toBeVisible();
  expect(completed).toBe(true);
});

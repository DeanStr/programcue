import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";

const enabled = process.env.PERFORMANCE_EVIDENCE === "1";
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const wranglerExecutable = resolve(
  repositoryRoot,
  "node_modules/.bin/wrangler",
);

type D1Result = {
  results: Array<Record<string, unknown>>;
  success: boolean;
};

async function executeLocalD1(arguments_: string[]) {
  return execFileAsync(
    wranglerExecutable,
    [
      "d1",
      "execute",
      "program-cue-db",
      "--local",
      "--persist-to",
      ".wrangler/e2e-state",
      "-c",
      "wrangler.demo.jsonc",
      ...arguments_,
    ],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
}

async function localD1Json(command: string) {
  const { stdout } = await executeLocalD1(["--command", command, "--json"]);
  const parsed = JSON.parse(String(stdout)) as D1Result[];
  if (!parsed.every((result) => result.success)) {
    throw new Error("The local D1 performance query did not succeed.");
  }
  return parsed.flatMap((result) => result.results);
}

async function applyScaleFixture() {
  await executeLocalD1([
    "--file",
    resolve(repositoryRoot, "e2e/fixtures/performance-scale.sql"),
  ]);
  const [counts] = await localD1Json(`
    SELECT
      (SELECT COUNT(*) FROM submissions WHERE id LIKE 'perf-scale-submission-%') AS submissions,
      (SELECT COUNT(*) FROM memberships WHERE id LIKE 'perf-scale-membership-%') AS speakers,
      (SELECT COUNT(*) FROM sessions WHERE id LIKE 'perf-scale-session-%') AS scheduleSessions,
      (SELECT COUNT(*) FROM schedule_entries WHERE id LIKE 'perf-scale-entry-%') AS scheduleEntries
  `);
  if (!counts)
    throw new Error("The local scale fixture could not be verified.");
  return {
    submissions: Number(counts.submissions),
    speakers: Number(counts.speakers),
    scheduleSessions: Number(counts.scheduleSessions),
    scheduleEntries: Number(counts.scheduleEntries),
  };
}

async function explain(command: string) {
  const rows = await localD1Json(`EXPLAIN QUERY PLAN ${command}`);
  return rows.map((row) => String(row.detail ?? ""));
}

async function measureUsefulPage(
  page: import("@playwright/test").Page,
  url: string,
  usefulRow: RegExp,
) {
  const startedAt = performance.now();
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByText(usefulRow).first().waitFor();
  return performance.now() - startedAt;
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

test.describe("explicit local performance evidence", () => {
  test.skip(
    !enabled,
    "Run npm run performance:local to execute timing budgets outside the non-flaky core gate.",
  );

  test("measures representative browser budgets with warmed multi-sample percentiles", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(90_000);
    await context.addInitScript(() => {
      const metrics = { cls: 0, lcp: 0 };
      Object.defineProperty(window, "__programCueVitals", {
        value: metrics,
        configurable: true,
      });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          if (!shift.hadRecentInput) metrics.cls += shift.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) metrics.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 80,
      downloadThroughput: 4_000_000 / 8,
      uploadThroughput: 1_000_000 / 8,
      connectionType: "cellular4g",
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    const lcpSamples: number[] = [];
    const clsSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await page.goto("about:blank");
      const response = await page.goto(
        "/public/programme/future-of-events-2027",
        {
          waitUntil: "domcontentloaded",
        },
      );
      expect(response?.ok()).toBeTruthy();
      await page.locator("body[data-hydrated='true']").waitFor();
      await page.waitForTimeout(350);
      const metrics = await page.evaluate(
        () =>
          (
            window as typeof window & {
              __programCueVitals: { cls: number; lcp: number };
            }
          ).__programCueVitals,
      );
      lcpSamples.push(metrics.lcp);
      clsSamples.push(metrics.cls);
    }

    const publicInteractionSamples: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const duration = await page.evaluate(
        async (useFilteredDay) => {
          const select = document.querySelector<HTMLSelectElement>(
            "select[aria-label='Filter by day']",
          );
          if (!select) throw new Error("Public day filter is unavailable.");
          const next = useFilteredDay ? select.options[1]?.value : "All days";
          if (!next) throw new Error("A published event day is unavailable.");
          const expected = useFilteredDay ? 3 : 5;
          const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            "value",
          )?.set;
          if (!valueSetter)
            throw new Error("The select value setter is unavailable.");
          const start = performance.now();
          valueSetter.call(select, next);
          select.dispatchEvent(new Event("change", { bubbles: true }));
          while (performance.now() - start < 1_000) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            if (
              document.querySelectorAll(".programme-row").length === expected
            ) {
              return performance.now() - start;
            }
          }
          throw new Error(
            "The public filter did not render within one second.",
          );
        },
        index % 2 === 0,
      );
      publicInteractionSamples.push(duration);
    }

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.goto("/admin/command");
    await page.locator("body[data-hydrated='true']").waitFor();

    const paletteSamples: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const duration = await page.evaluate(async () => {
        const trigger =
          document.querySelector<HTMLButtonElement>(".command-trigger");
        if (!trigger) throw new Error("The command trigger is unavailable.");
        const start = performance.now();
        trigger.click();
        while (performance.now() - start < 1_000) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          if (document.querySelector("[role='dialog']")) {
            return performance.now() - start;
          }
        }
        throw new Error("The command palette did not open within one second.");
      });
      paletteSamples.push(duration);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }

    const searchSamples = await page.evaluate(async () => {
      const durations: number[] = [];
      for (let index = 0; index < 7; index += 1) {
        const start = performance.now();
        const response = await fetch(
          `/admin/search?q=${encodeURIComponent(index % 2 ? "Priya" : "demo")}&scope=event`,
          { credentials: "same-origin" },
        );
        if (!response.ok)
          throw new Error(`Search returned ${response.status}.`);
        await response.json();
        durations.push(performance.now() - start);
      }
      return durations;
    });

    // Warm both route modules, then measure an in-browser navigation and the
    // arrival of its first useful heading. This is intentionally a local cached
    // route measurement, not a production network claim.
    await page.goto("/admin/event");
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.goto("/admin/command");
    await page.locator("body[data-hydrated='true']").waitFor();
    const navigationSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const target =
        index % 2 === 0
          ? { href: "/admin/event", heading: "Event Setup" }
          : { href: "/admin/command", heading: "Command Centre" };
      const duration = await page.evaluate(async ({ href, heading }) => {
        const link = document.querySelector<HTMLAnchorElement>(
          `a[href='${href}']`,
        );
        if (!link) throw new Error(`Navigation link ${href} is unavailable.`);
        const start = performance.now();
        link.click();
        while (performance.now() - start < 2_000) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          if (
            [...document.querySelectorAll("h1")].some(
              (node) => node.textContent?.trim() === heading,
            )
          ) {
            return performance.now() - start;
          }
        }
        throw new Error(
          `Navigation to ${href} did not render within two seconds.`,
        );
      }, target);
      navigationSamples.push(duration);
    }

    const report = {
      evidence:
        "local Chromium + Miniflare; external production p75/RUM remains required",
      profile: {
        publicNavigation: "4 Mbps down, 1 Mbps up, 80 ms latency, 4x CPU",
        samples: { publicNavigation: 5, interactions: 7, navigation: 5 },
      },
      results: {
        publicLcpP75Ms: rounded(percentile(lcpSamples, 0.75)),
        publicClsMax: rounded(Math.max(...clsSamples)),
        publicFilterP75Ms: rounded(percentile(publicInteractionSamples, 0.75)),
        paletteOpenP95Ms: rounded(percentile(paletteSamples, 0.95)),
        searchP95Ms: rounded(percentile(searchSamples, 0.95)),
        cachedNavigationP95Ms: rounded(percentile(navigationSamples, 0.95)),
      },
      budgets: {
        publicLcpP75Ms: 2_500,
        publicClsMax: 0.1,
        publicFilterP75Ms: 200,
        paletteOpenP95Ms: 100,
        searchP95Ms: 300,
        cachedNavigationP95Ms: 100,
      },
    };
    const outputPath = testInfo.outputPath("performance-local.json");
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await testInfo.attach("local-performance-report", {
      path: outputPath,
      contentType: "application/json",
    });
    console.log(`PROGRAM_CUE_PERFORMANCE ${JSON.stringify(report)}`);

    expect(Math.min(...lcpSamples)).toBeGreaterThan(0);
    expect(report.results.publicLcpP75Ms).toBeLessThanOrEqual(2_500);
    expect(report.results.publicClsMax).toBeLessThanOrEqual(0.1);
    expect(report.results.publicFilterP75Ms).toBeLessThanOrEqual(200);
    expect(report.results.paletteOpenP95Ms).toBeLessThanOrEqual(100);
    expect(report.results.searchP95Ms).toBeLessThanOrEqual(300);
    expect(report.results.cachedNavigationP95Ms).toBeLessThanOrEqual(100);
  });

  test("measures 10,000-record operational pages and local mutation feedback budgets", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);

    // Ensure the normal demo baseline exists before applying the fixture by
    // direct D1 command. Playwright's web server reset isolates this state from
    // development, demo evaluation and every subsequent run.
    await page.goto("/admin/event");
    await page.locator("body[data-hydrated='true']").waitFor();
    const fixture = await applyScaleFixture();
    expect(fixture).toEqual({
      submissions: 10_000,
      speakers: 10_000,
      scheduleSessions: 200,
      scheduleEntries: 199,
    });

    const [submissionPlan, speakerPlan] = await Promise.all([
      explain(`
        SELECT submission.id
          FROM submissions submission
          JOIN events event
            ON event.id = submission.event_id
           AND event.organisation_id = 'org-future-events'
         WHERE submission.event_id = 'evt-foe-2025'
           AND submission.category = 'Scale Track 00'
           AND submission.status = 'submitted'
         ORDER BY submission.updated_at DESC
         LIMIT 51
      `),
      explain(`
        SELECT person.id
          FROM memberships membership
          JOIN people person ON person.id = membership.person_id
         WHERE membership.event_id = 'evt-foe-2025'
           AND membership.role = 'speaker'
           AND membership.accepted_at IS NOT NULL
           AND membership.revoked_at IS NULL
           AND person.profile_status = 'published'
           AND EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.event_id = membership.event_id
                AND task.target_type = 'speaker'
                AND task.target_id = person.id
                AND task.status NOT IN ('completed','waived')
           )
         ORDER BY person.display_name
         LIMIT 51
      `),
    ]);
    expect(submissionPlan.join("\n")).toContain(
      "idx_submissions_event_category_status",
    );
    expect(speakerPlan.join("\n")).toContain(
      "idx_memberships_event_role_status",
    );
    expect(speakerPlan.join("\n")).toContain("idx_tasks_target");

    const submissionFirstUsefulPageMs = await measureUsefulPage(
      page,
      "/admin/submissions",
      /Representative scale submission 10000/u,
    );
    const submissionFilterSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const filters =
        index % 2 === 0
          ? "status=submitted&category=Scale+Track+00"
          : "status=assigned&category=Scale+Track+01";
      submissionFilterSamples.push(
        await measureUsefulPage(
          page,
          `/admin/submissions?${filters}`,
          /Representative scale submission/u,
        ),
      );
    }

    const speakerFirstUsefulPageMs = await measureUsefulPage(
      page,
      "/admin/speakers",
      /Scale Speaker 00001/u,
    );
    const speakerFilterSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const filters =
        index % 2 === 0
          ? "profileStatus=published&readiness=ready"
          : "profileStatus=draft&readiness=needs_attention";
      speakerFilterSamples.push(
        await measureUsefulPage(
          page,
          `/admin/speakers?${filters}`,
          /Scale Speaker/u,
        ),
      );
    }

    type RealtimeFrame = {
      type?: string;
      cursor?: number;
      entityType?: string;
      entityId?: string | null;
      committedAt?: number;
      receivedAtMs: number;
    };
    type RealtimeProbe = {
      state: "connecting" | "open" | "closed" | "error";
      messages: RealtimeFrame[];
      error: string | null;
    };
    type RealtimeGlobal = typeof globalThis & {
      __programCuePerformanceRealtime?: RealtimeProbe;
      __programCuePerformanceSocket?: WebSocket;
    };

    const observer = await context.newPage();
    await observer.goto("/admin/event");
    const socketSeen = observer.waitForEvent("websocket");
    await observer.evaluate((eventId) => {
      const realtimeGlobal = globalThis as RealtimeGlobal;
      const url = new URL(`/admin/events/${eventId}/changes`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const probe: RealtimeProbe = {
        state: "connecting",
        messages: [],
        error: null,
      };
      const socket = new WebSocket(url);
      realtimeGlobal.__programCuePerformanceRealtime = probe;
      realtimeGlobal.__programCuePerformanceSocket = socket;
      socket.addEventListener("open", () => {
        probe.state = "open";
      });
      socket.addEventListener("message", (message) => {
        try {
          probe.messages.push({
            ...(JSON.parse(String(message.data)) as object),
            receivedAtMs: Date.now(),
          });
        } catch (error) {
          probe.error = error instanceof Error ? error.message : String(error);
        }
      });
      socket.addEventListener("error", () => {
        probe.state = "error";
        probe.error = "The event WebSocket emitted an error.";
      });
      socket.addEventListener("close", () => {
        probe.state = "closed";
      });
    }, "evt-foe-2025");
    await socketSeen;
    await expect
      .poll(() =>
        observer.evaluate(() => {
          const probe = (globalThis as RealtimeGlobal)
            .__programCuePerformanceRealtime;
          return {
            state: probe?.state,
            ready: probe?.messages.some((message) => message.type === "ready"),
            error: probe?.error,
          };
        }),
      )
      .toEqual({ state: "open", ready: true, error: null });

    await page.goto("/admin/event");
    const venue = page.getByLabel("Venue");
    const revision = page.locator("input[name='revision']");
    const originalVenue = await venue.inputValue();
    const mutationSamples: number[] = [];
    const eventFreshnessSamples: number[] = [];
    let cursor = await observer.evaluate(() => {
      const frames = (globalThis as RealtimeGlobal)
        .__programCuePerformanceRealtime?.messages;
      return Math.max(0, ...(frames ?? []).map((frame) => frame.cursor ?? 0));
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        const previousRevision = await revision.inputValue();
        await venue.fill(`Local performance mutation ${index + 1}`);
        const startedAt = Date.now();
        const responsePromise = page.waitForResponse((response) => {
          const request = response.request();
          return (
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/admin/event.data"
          );
        });
        await page.getByRole("button", { name: "Save event" }).click();
        const response = await responsePromise;
        expect(await response.finished()).toBeNull();
        expect(response.ok()).toBeTruthy();
        mutationSamples.push(Date.now() - startedAt);
        await expect
          .poll(() => revision.inputValue())
          .not.toBe(previousRevision);
        const readFrame = () =>
          observer.evaluate((minimumCursor) => {
            const probe = (globalThis as RealtimeGlobal)
              .__programCuePerformanceRealtime;
            return (
              probe?.messages.find(
                (message) =>
                  message.type === "event-change" &&
                  message.entityType === "event" &&
                  message.entityId === "evt-foe-2025" &&
                  (message.cursor ?? 0) > minimumCursor,
              ) ?? null
            );
          }, cursor);
        await expect
          .poll(readFrame, { timeout: 2_000, intervals: [20, 50, 100] })
          .not.toBeNull();
        const received = await readFrame();
        if (!received) {
          throw new Error("The committed event invalidation was not received.");
        }
        cursor = received.cursor ?? cursor;
        if (typeof received.committedAt !== "number") {
          throw new Error("The event invalidation omitted its commit time.");
        }
        eventFreshnessSamples.push(
          Math.max(0, received.receivedAtMs - received.committedAt * 1_000),
        );
      }
    } finally {
      if (!page.isClosed() && (await venue.inputValue()) !== originalVenue) {
        await venue.fill(originalVenue);
        const restoredRevision = await revision.inputValue();
        await page.getByRole("button", { name: "Save event" }).click();
        await expect
          .poll(() => revision.inputValue())
          .not.toBe(restoredRevision);
      }
      await observer
        .evaluate(() => {
          (globalThis as RealtimeGlobal).__programCuePerformanceSocket?.close(
            1000,
            "Local performance evidence complete",
          );
        })
        .catch(() => undefined);
      await observer.close();
    }

    const scheduleValidationSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const [schedule] = await localD1Json(`
        SELECT revision FROM schedule_versions
         WHERE id = 'perf-scale-schedule-draft'
           AND event_id = 'evt-foe-2025'
      `);
      if (!schedule) throw new Error("The scale schedule draft disappeared.");
      const startsAt =
        Math.floor(Date.parse("2027-05-21T16:00:00Z") / 1_000) +
        (index % 2) * 3_600;
      const startedAt = performance.now();
      const response = await page.request.post("/admin/schedule", {
        headers: { origin: e2eOrigin },
        form: {
          intent: "place",
          scheduleVersionId: "perf-scale-schedule-draft",
          scheduleRevision: String(schedule.revision),
          sessionId: "perf-scale-session-200",
          roomId: "perf-scale-room",
          startsAt: String(startsAt),
          endsAt: String(startsAt + 1_800),
        },
      });
      await response.body();
      scheduleValidationSamples.push(performance.now() - startedAt);
      expect(response.ok()).toBeTruthy();
    }

    await page.goto("/admin/submissions/form");
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("program-cue-draft-recovery");
        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("blocked", () =>
          reject(new Error("The draft recovery database is blocked.")),
        );
      });
    });
    await page.reload();
    const introduction = page.getByLabel("Introduction");
    const autosaveStartedAt = performance.now();
    await introduction.fill(`Performance recovery feedback ${Date.now()}`);
    await page.getByText("Saved locally", { exact: true }).waitFor();
    const autosaveFeedbackMs = performance.now() - autosaveStartedAt;

    const report = {
      evidence:
        "isolated local Chromium + Miniflare + D1 scale fixture; not production p75/RUM",
      fixture,
      queryPlans: {
        submission: submissionPlan,
        speaker: speakerPlan,
      },
      samples: {
        indexedFilters: 5,
        ordinaryMutations: 5,
        eventChanges: 5,
        scheduleValidation: 5,
        autosaveFeedback: 1,
      },
      results: {
        submissionFirstUsefulPageMs: rounded(submissionFirstUsefulPageMs),
        submissionIndexedFilterP95Ms: rounded(
          percentile(submissionFilterSamples, 0.95),
        ),
        speakerFirstUsefulPageMs: rounded(speakerFirstUsefulPageMs),
        speakerIndexedFilterP95Ms: rounded(
          percentile(speakerFilterSamples, 0.95),
        ),
        ordinaryMutationP95Ms: rounded(percentile(mutationSamples, 0.95)),
        scheduleValidationP95Ms: rounded(
          percentile(scheduleValidationSamples, 0.95),
        ),
        eventChangeCommitToVisibleP95Ms: rounded(
          percentile(eventFreshnessSamples, 0.95),
        ),
        autosaveFeedbackMs: rounded(autosaveFeedbackMs),
      },
      budgets: {
        submissionFirstUsefulPageMs: 1_500,
        submissionIndexedFilterP95Ms: 500,
        speakerFirstUsefulPageMs: 1_500,
        speakerIndexedFilterP95Ms: 500,
        ordinaryMutationP95Ms: 750,
        scheduleValidationP95Ms: 500,
        eventChangeCommitToVisibleP95Ms: 2_000,
        autosaveFeedbackMs: 2_000,
      },
      externalOnly:
        "Production traffic p75 Web Vitals, production-like D1/DO geography, field INP, drag frame pacing, queue acknowledgement and transient-network autosave remain external acceptance evidence.",
    };
    const outputPath = testInfo.outputPath("performance-scale-local.json");
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await testInfo.attach("local-scale-performance-report", {
      path: outputPath,
      contentType: "application/json",
    });
    console.log(`PROGRAM_CUE_SCALE_PERFORMANCE ${JSON.stringify(report)}`);

    expect(report.results.submissionFirstUsefulPageMs).toBeLessThanOrEqual(
      1_500,
    );
    expect(report.results.submissionIndexedFilterP95Ms).toBeLessThanOrEqual(
      500,
    );
    expect(report.results.speakerFirstUsefulPageMs).toBeLessThanOrEqual(1_500);
    expect(report.results.speakerIndexedFilterP95Ms).toBeLessThanOrEqual(500);
    expect(report.results.ordinaryMutationP95Ms).toBeLessThanOrEqual(750);
    expect(report.results.scheduleValidationP95Ms).toBeLessThanOrEqual(500);
    expect(report.results.eventChangeCommitToVisibleP95Ms).toBeLessThanOrEqual(
      2_000,
    );
    expect(report.results.autosaveFeedbackMs).toBeLessThanOrEqual(2_000);
  });
});

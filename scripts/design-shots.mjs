// Design review harness: drives the local dev server and captures full-page
// screenshots of every surface that matters for visual work.
//
//   node scripts/design-shots.mjs before
//   node scripts/design-shots.mjs after
//
// Output: .artifacts/design/<label>/<viewport>/<surface>.png
import { mkdir, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

// One dev server and one demo database are shared by everyone capturing at
// once. Without a lock, concurrent runs reset the fixture underneath each
// other and the server 503s, so screenshots show an error card rather than
// the surface being reviewed.
const LOCK = path.resolve(".artifacts/design/.capture.lock");
const FIXTURE_STAMP = path.resolve(".artifacts/design/.fixture-stamp");
const FIXTURE_FRESH_MS = 120_000;

async function acquireLock() {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      const handle = await open(LOCK, "wx");
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Reclaim a lock left behind by a run that was killed.
      const age = await stat(LOCK).then(
        (s) => Date.now() - s.mtimeMs,
        () => Infinity,
      );
      if (age > 10 * 60_000) {
        await rm(LOCK, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("capture lock timed out");
      await new Promise((r) => setTimeout(r, 2000 + Math.floor(age % 1000)));
    }
  }
}

async function fixtureIsFresh() {
  return stat(FIXTURE_STAMP).then(
    (s) => Date.now() - s.mtimeMs < FIXTURE_FRESH_MS,
    () => false,
  );
}

const ORIGIN = process.env.DESIGN_SHOT_ORIGIN ?? "http://127.0.0.1:5173";
const LABEL = process.argv[2] ?? "before";
const ONLY = process.argv.slice(3);
const OUT = path.resolve(".artifacts/design", LABEL);

// 320 is the floor because a regression lived between 320 and 390 for a whole
// redesign: the participant header reached 258px at 320px wide while looking
// correct at every width this harness used to check.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 320, height: 720 },
];

/** role: undefined = organiser/owner demo identity. */
const SURFACES = [
  { name: "command-centre", path: "/admin/command" },
  { name: "event-setup", path: "/admin/event" },
  { name: "submissions", path: "/admin/submissions" },
  { name: "form-builder", path: "/admin/submissions/form" },
  { name: "review-admin", path: "/admin/review" },
  { name: "speakers", path: "/admin/speakers" },
  { name: "crm", path: "/admin/crm" },
  { name: "schedule", path: "/admin/schedule" },
  { name: "communications", path: "/admin/communications" },
  { name: "tasks", path: "/admin/tasks" },
  { name: "content", path: "/admin/content" },
  { name: "programme-admin", path: "/admin/programme" },
  { name: "integrations", path: "/admin/integrations" },
  { name: "operations", path: "/admin/operations" },
  { name: "settings", path: "/admin/settings" },
  { name: "review-workbench", path: "/review/workbench", role: "evaluator" },
  {
    name: "speaker-dashboard",
    path: "/participant/dashboard",
    role: "speaker",
  },
  { name: "speaker-tasks", path: "/participant/tasks", role: "speaker" },
  { name: "speaker-sessions", path: "/participant/sessions", role: "speaker" },
  { name: "speaker-profile", path: "/participant/profile", role: "speaker" },
  { name: "speaker-files", path: "/participant/files", role: "speaker" },
  {
    name: "speaker-resources",
    path: "/participant/resources",
    role: "speaker",
  },
  {
    name: "public-programme",
    path: "/public/programme/future-of-events-2027",
    public: true,
  },
  {
    name: "public-speakers",
    path: "/public/programme/future-of-events-2027/speakers",
    public: true,
  },
  {
    name: "public-agenda",
    path: "/public/programme/future-of-events-2027/agenda",
    public: true,
  },
  {
    name: "public-gallery",
    path: "/public/programme/future-of-events-2027/gallery",
    public: true,
  },
  { name: "public-application", path: "/apply/form", public: true },
  { name: "design-system", path: "/design/system", public: true },
];

const DEMO_EVENT = "evt-foe-2025";
const DEMO_CONFIRMATION = "Future of Events 2027";

function cookie(name, value) {
  return {
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  };
}

async function resetDemo(request) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await request.post(`${ORIGIN}/demo.data`, {
      form: { intent: "reset", confirmation: DEMO_CONFIRMATION },
      headers: { origin: ORIGIN },
    });
    if (response.status() >= 200 && response.status() < 300) {
      // A 202 means the reset was accepted and is still settling.
      if (response.status() === 202)
        await new Promise((r) => setTimeout(r, 3000));
      return;
    }
    if (response.status() !== 409 || Date.now() >= deadline) {
      throw new Error(`demo reset failed: ${response.status()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const wanted = ONLY.length
    ? SURFACES.filter((s) => ONLY.includes(s.name))
    : SURFACES;

  // Only wipe the surfaces this run is actually capturing, so parallel runs
  // targeting different surfaces do not delete each other's output.
  if (ONLY.length) {
    for (const v of VIEWPORTS) {
      for (const s of wanted) {
        await rm(path.join(OUT, v.name, `${s.name}.png`), { force: true });
      }
    }
  } else {
    await rm(OUT, { recursive: true, force: true });
  }

  await acquireLock();
  try {
    await capture(wanted);
  } finally {
    await rm(LOCK, { force: true });
  }
}

async function capture(wanted) {
  const browser = await chromium.launch();
  const setup = await browser.newContext({ baseURL: ORIGIN });
  await setup.addCookies([cookie("program_cue_event", DEMO_EVENT)]);
  if (await fixtureIsFresh()) {
    process.stdout.write("fixture is fresh; skipping demo reset\n");
  } else {
    await resetDemo(setup.request);
    // Warm every lazily-seeded domain so surfaces render populated, not empty.
    for (const p of [
      "/admin/command",
      "/admin/review",
      "/admin/resources",
      "/admin/tasks",
      "/admin/schedule",
      "/admin/submissions/form",
      "/embed/future-of-events-2027",
    ]) {
      await setup.request.get(`${ORIGIN}${p}`);
    }
    await writeFile(FIXTURE_STAMP, "");
    await utimes(FIXTURE_STAMP, new Date(), new Date());
  }
  await setup.close();

  const failures = [];
  for (const viewport of VIEWPORTS) {
    await mkdir(path.join(OUT, viewport.name), { recursive: true });
    for (const surface of wanted) {
      const context = await browser.newContext({
        baseURL: ORIGIN,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      // Public surfaces stay anonymous. Everything else needs an explicit demo
      // identity: the dev server assigns none by default, so an admin route
      // without this cookie redirects to the identity chooser.
      const cookies = [cookie("program_cue_event", DEMO_EVENT)];
      const identity = surface.public
        ? null
        : (surface.role ?? "administrator");
      if (identity) {
        cookies.push(cookie("program_cue_demo_identity", identity));
      }
      await context.addCookies(cookies);
      const page = await context.newPage();
      try {
        // A 5xx under load renders the "Temporarily unavailable" card, which
        // looks like a finished screenshot and silently misleads a review.
        let status = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await page.goto(surface.path, {
            waitUntil: "networkidle",
            timeout: 45_000,
          });
          status = response?.status() ?? 0;
          if (status < 500) break;
          await page.waitForTimeout(1500 * (attempt + 1));
        }
        if (status >= 400) {
          failures.push(`${surface.name} ${viewport.name} -> ${status}`);
        }
        await page.waitForTimeout(400);
        await page.screenshot({
          path: path.join(OUT, viewport.name, `${surface.name}.png`),
          fullPage: true,
        });
      } catch (error) {
        failures.push(`${surface.name} ${viewport.name} -> ${error.message}`);
      } finally {
        await context.close();
      }
    }
    process.stdout.write(`captured ${viewport.name}\n`);
  }
  await browser.close();

  if (failures.length) {
    process.stdout.write(`\nissues:\n${failures.join("\n")}\n`);
  }
  process.stdout.write(`\nwrote ${OUT}\n`);
}

await main();

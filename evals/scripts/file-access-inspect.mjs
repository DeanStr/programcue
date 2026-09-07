import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { request } from "playwright";
import { readEvidenceFile } from "agent-eval-kit/evidence/files";
import { privateDownloadUrl, validateAccessReceipt } from "./file-access-checks.mjs";

if (process.env.PROGRAM_CUE_LOCAL_FILES !== "1")
  throw new Error("Use npm run regression:files for isolated local access checks");
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const runDir = path.dirname(path.dirname(process.env.AEK_COLLECT_CONTEXT));
const filesDir = path.join(runDir, "PC-FILES");
const evidence = JSON.parse(fs.readFileSync(path.join(filesDir, "evidence.json"), "utf8"));
const current = evidence.files?.find((file) => file.label === "current-version");
if (!current) throw new Error("Missing retained current-version download for access probes");
readEvidenceFile(filesDir, current);
const cleanUrl = privateDownloadUrl(current.url);
const sessions = JSON.parse(
  fs.readFileSync(new URL("../.agent-eval/local-sessions.json", import.meta.url), "utf8"),
);
const authRoot = fs.realpathSync(new URL("../.agent-eval/auth/local", import.meta.url));
const storageState = fs.realpathSync(sessions.organizer);
if (!storageState.startsWith(`${authRoot}${path.sep}`))
  throw new Error("Access probes require the coordinator's local organizer session");
const organizer = await request.newContext({ storageState });
const anonymous = await request.newContext({ storageState: { cookies: [], origins: [] } });
const files = [];
try {
  const anonymousCookiesBefore = (await anonymous.storageState()).cookies.length;
  const capture = new URL("../.agent-eval/file-services.jsonl", import.meta.url);
  const deadline = Date.now() + 60_000;
  let scans;
  while (true) {
    const events = fs
      .readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const error = events.find((event) => event.type === "scan-error");
    if (error) throw new Error(`Local scanner failed: ${error.error}`);
    scans = events.filter((event) => event.type === "scan");
    if (scans.length >= 3 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const historyUrl = new URL(cleanUrl);
  historyUrl.pathname = historyUrl.pathname.replace(/\/[^/]+$/, "");
  historyUrl.search = "?page=1";
  const historyResponse = await organizer.get(historyUrl.href, {
    maxRedirects: 0,
    timeout: 15_000,
  });
  if (historyResponse.status() !== 200)
    throw new Error(`Authenticated history probe failed: HTTP ${historyResponse.status()}`);
  const history = await historyResponse.json();
  const infected = history.versions?.find((version) => version.versionNumber === 3);
  if (!infected || !/^[a-f0-9-]{36}$/.test(infected.id))
    throw new Error("Completed EICAR workflow has no third version in server history");
  const infectedUrl = new URL(cleanUrl);
  infectedUrl.pathname = infectedUrl.pathname.replace(/[^/]+$/, infected.id);
  async function probe(client, url, label) {
    const response = await client.get(url.href, { maxRedirects: 0, timeout: 15_000 });
    const body = await response.body();
    const filename = `${label}.bin`;
    fs.writeFileSync(path.join(context.outputDir, filename), body);
    files.push({ label, path: filename, filename, mediaType: "application/octet-stream" });
    return {
      path: url.pathname,
      status: response.status(),
      location: response.headers().location ?? null,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  const receipt = {
    version: 1,
    source: "isolated-local-file-access",
    cleanUrl: cleanUrl.href,
    anonymousCookiesBefore,
    history,
    scans,
    responses: {
      clean: await probe(organizer, cleanUrl, "clean"),
      infected: await probe(organizer, infectedUrl, "infected"),
      anonymous: await probe(anonymous, cleanUrl, "anonymous"),
    },
  };
  validateAccessReceipt(receipt);
  fs.writeFileSync(path.join(context.outputDir, "access.json"), JSON.stringify(receipt));
  files.push({
    label: "access",
    path: "access.json",
    filename: "access.json",
    mediaType: "application/json",
  });
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "completed",
      summary:
        "Retained actual scanner, version-history and authenticated/anonymous HTTP observations",
      observations: [
        "Isolated local R2 and real ClamAV only; no hosted service acceptance. No redirects followed or credentials retained in evidence.",
      ],
      files,
    }),
  );
} finally {
  await organizer.dispose();
  await anonymous.dispose();
}

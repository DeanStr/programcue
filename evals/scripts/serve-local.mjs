import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { project, root, origin } from "./runtime.mjs";
import { resolveE2eRuntime } from "../../scripts/e2e-runtime.mjs";
import { localMailSendUrl, sendLocalMail } from "./local-mail-transport.mjs";
import {
  createLocalFileServices,
  waitForClamav,
  s3Host,
  scannerUrl,
  callbackUrl,
} from "./local-file-services.mjs";

const execute = promisify(execFile);
const { port, statePath } = resolveE2eRuntime();
const directory = path.join(statePath, "file-runtime");
await fs.mkdir(directory, { mode: 0o700 });
if (!["0", "1"].includes(process.env.PROGRAM_CUE_LOCAL_FILES))
  throw new Error("Set PROGRAM_CUE_LOCAL_FILES explicitly to 0 or 1");
const fileServices = process.env.PROGRAM_CUE_LOCAL_FILES === "1";
const container = process.env.PROGRAM_CUE_LOCAL_FILE_CONTAINER;
if (fileServices && !/^programcue-eval-clamav-[a-f0-9-]{36}$/.test(container ?? ""))
  throw new Error("Missing isolated scanner container identity");
const eventsPath = path.join(root, ".agent-eval/file-services.jsonl");
let mf;
let services;
let containerStarted = false;
const shutdown = new AbortController();
let stopping = false;
let resolveStop;
const stopped = new Promise((resolve) => {
  resolveStop = resolve;
});
const stop = () => {
  stopping = true;
  shutdown.abort(new Error("Local Worker stopping"));
  resolveStop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// A normal shutdown must drain services before signalling Workerd descendants.
process.on("message", (message) => {
  if (message === "shutdown") stop();
});
try {
  if (fileServices) {
    await fs.writeFile(eventsPath, "", { mode: 0o600 });
    await execute("docker", [
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--name",
      container,
      "--env",
      "CLAMAV_NO_FRESHCLAMD=true",
      "--env",
      `EXPECTED_R2_HOST=${s3Host}`,
      "--env",
      "EXPECTED_R2_BUCKET=program-cue-files",
      "programcue-eval-clamav:local",
    ]);
    containerStarted = true;
    await waitForClamav(container, { signal: shutdown.signal });
    console.log("Real ClamAV ready with fresh signatures; container networking is disabled.");
  }
  shutdown.signal.throwIfAborted();
  const parsed = ts.parseConfigFileTextToJson(
    "wrangler.demo.jsonc",
    await fs.readFile(path.join(project, "wrangler.demo.jsonc"), "utf8"),
  );
  if (parsed.error) throw new Error("Invalid wrangler.demo.jsonc", { cause: parsed.error });
  const config = parsed.config;
  if (
    config.vars.EMAIL_PROVIDER !== "mailpit" ||
    config.vars.MAILPIT_SEND_API_URL !== localMailSendUrl
  )
    throw new Error("Isolated regression runtime requires the fixed local Mailpit provider");
  // Copy only the checked-in local profile to a private directory. Wrangler
  // therefore cannot discover the application's .dev.vars or provider secrets.
  const env = {
    ...config.vars,
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    ANONYMOUS_ITINERARY_SECRET: randomBytes(48).toString("base64url"),
    BETTER_AUTH_URL: fileServices ? new URL(callbackUrl).origin : origin,
    CORS_ALLOWED_ORIGINS: origin,
    PROGRAM_CUE_E2E_FIXTURES: "true",
    ...(fileServices
      ? {
          R2_ACCOUNT_ID: s3Host.split(".")[0],
          R2_BUCKET_NAME: "program-cue-files",
          R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
          R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
          FILE_SCANNER_API_URL: scannerUrl,
          FILE_SCANNER_DISPATCH_SECRET: randomBytes(48).toString("base64url"),
          FILE_SCANNER_WEBHOOK_SECRET: randomBytes(48).toString("base64url"),
        }
      : {}),
  };
  config.vars = env;
  config.main = path.join(project, "build/server/index.js");
  config.assets = { directory: path.join(project, "build/client") };
  config.d1_databases[0].migrations_dir = path.join(project, "migrations");
  const configPath = path.join(directory, "wrangler.json");
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const { workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(configPath);
  if (fileServices)
    services = createLocalFileServices({
      env,
      container,
      getBucket: () => mf.getR2Bucket("FILES", config.name),
      dispatchCallback: (url, init) => mf.dispatchFetch(url, init),
      record: (event) => {
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
        console.log(JSON.stringify(event));
      },
    });
  const outboundService = async (request) => {
    const url = new URL(request.url);
    let response;
    if (fileServices && url.host === s3Host) response = await services.s3(request);
    else if (fileServices && url.href === scannerUrl && request.method === "POST")
      response = await services.scanner(request);
    else if (url.href === localMailSendUrl) response = await sendLocalMail(request);
    else throw new Error(`Local regression rejected outbound network access to ${url.origin}`);
    return new MiniflareResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  };
  mf = new Miniflare({
    host: "127.0.0.1",
    port,
    resourcePersistencePath: path.join(statePath, "v3"),
    workers: [
      {
        ...workerOptions,
        bindings: env,
        name: config.name,
        serviceBindings: {
          ...workerOptions.serviceBindings,
          ...(fileServices ? { AEK_LOCAL_STORAGE: outboundService } : {}),
        },
        modules: [
          ...(fileServices
            ? [
                { type: "ESModule", path: path.join(root, "scripts/local-file-worker.mjs") },
                { type: "ESModule", path: path.join(root, "scripts/local-file-transport.mjs") },
              ]
            : []),
          { type: "ESModule", path: config.main },
          ...Array.from(await fs.readdir(path.join(project, "build/server/assets")))
            .filter((name) => /\.(js|wasm|css)$/.test(name))
            .map((name) => ({
              type: name.endsWith(".wasm")
                ? "CompiledWasm"
                : name.endsWith(".css")
                  ? "Text"
                  : "ESModule",
              path: path.join(project, "build/server/assets", name),
            })),
        ],
        modulesRoot: project,
        outboundService,
      },
      ...externalWorkers,
    ],
  });
  await mf.ready;
  console.log(`Local regression Worker ready at ${origin}`);
  if (!stopping) {
    const failure = services ? await Promise.race([stopped, services.failure]) : await stopped;
    if (failure) throw failure;
  }
} finally {
  try {
    await services?.drain();
  } finally {
    try {
      if (containerStarted) await execute("docker", ["stop", "--time", "2", container]);
    } finally {
      try {
        await mf?.dispose();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
        if (process.connected) process.disconnect();
      }
    }
  }
}

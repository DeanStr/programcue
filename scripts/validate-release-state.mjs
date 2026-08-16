import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_REVISION_PATTERN = /^[0-9a-f]{40,64}$/iu;

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `Git release-state inspection could not start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Git release-state inspection failed for ${args[0]}${result.stderr ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return result.stdout.trim();
}

export function validateReleaseStateEvidence({
  headRevision,
  workflowRevision,
  worktreeStatus,
}) {
  const issues = [];
  if (!GIT_REVISION_PATTERN.test(headRevision)) {
    issues.push("The release checkout HEAD is not a full Git revision.");
  }
  if (workflowRevision && workflowRevision !== headRevision) {
    issues.push("The release checkout does not match the workflow commit.");
  }
  if (worktreeStatus) {
    issues.push(
      "The release checkout contains uncommitted or untracked files.",
    );
  }
  return issues;
}

export function readReleaseRevision() {
  return git(["rev-parse", "HEAD"]);
}

export function readValidatedReleaseRevision() {
  const headRevision = readReleaseRevision();
  const workflowRevision = String(process.env.GITHUB_SHA ?? "").trim();
  const worktreeStatus = git(["status", "--porcelain"]);
  const issues = validateReleaseStateEvidence({
    headRevision,
    workflowRevision,
    worktreeStatus,
  });
  if (issues.length > 0) {
    throw new Error(
      `Release checkout is not immutable:\n- ${issues.join("\n- ")}`,
    );
  }
  return headRevision;
}

function run() {
  const headRevision = readValidatedReleaseRevision();
  console.log(`Release checkout is clean at ${headRevision}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

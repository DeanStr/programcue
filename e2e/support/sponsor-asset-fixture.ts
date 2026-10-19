import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit local upload states for browser testing; provider acceptance is tested separately. */
export function seedSponsorLogo(sponsorId: string, state: "clean" | "expired") {
  const clean = state === "clean";
  if (!/^[a-zA-Z0-9-]+$/.test(sponsorId))
    throw new Error("Invalid fixture sponsor ID");
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const statePath = resolve(
    repositoryRoot,
    process.env.PROGRAM_CUE_E2E_STATE?.trim() || ".wrangler/e2e-state",
  );
  if (
    dirname(statePath) !== join(repositoryRoot, ".wrangler") ||
    !/^e2e-state(?:-[A-Za-z0-9._-]+)?$/.test(basename(statePath))
  )
    throw new Error(
      "Sponsor fixtures require an isolated local E2E state directory",
    );
  const directory = mkdtempSync(join(tmpdir(), "programcue-sponsor-logo-"));
  const assetId = randomUUID(),
    versionId = randomUUID();
  const objectKey = `browser-fixtures/${versionId}.png`;
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=",
    "base64",
  );
  const etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
  const wrangler = (args: string[]) =>
    execFileSync(
      process.execPath,
      [
        join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"),
        ...args,
        "--local",
        "--persist-to",
        statePath,
        "-c",
        "wrangler.demo.jsonc",
      ],
      { cwd: repositoryRoot, stdio: "pipe", timeout: 30_000 },
    );
  try {
    const file = join(directory, "logo.png"),
      sql = join(directory, "fixture.sql");
    writeFileSync(file, bytes);
    if (clean)
      wrangler([
        "r2",
        "object",
        "put",
        `program-cue-files/${objectKey}`,
        "--file",
        file,
        "--content-type",
        "image/png",
      ]);
    writeFileSync(
      sql,
      `INSERT INTO file_assets(id,event_id,target_type,target_id,asset_kind,status,current_version_id)
      SELECT '${assetId}',event_id,'resource',id,'other','${clean ? "active" : "pending"}',${clean ? `'${versionId}'` : "NULL"} FROM sponsor_asset_requests WHERE sponsor_id='${sponsorId}' AND name='Event logo';
      INSERT INTO file_versions(id,event_id,asset_id,version_number,object_key,original_filename,declared_content_type,detected_content_type,size_bytes,object_etag,upload_status,signature_status,scan_status,released_at,created_by_person_id)
      SELECT '${versionId}',event_id,id,1,'${objectKey}','logo.png','image/png',${clean ? "'image/png'" : "NULL"},${bytes.length},${clean ? `'${etag}'` : "NULL"},'${clean ? "uploaded" : "uploading"}','${clean ? "valid" : "pending"}','${clean ? "clean" : "pending"}',${clean ? "unixepoch()" : "NULL"},'person-demo-speaker' FROM file_assets WHERE id='${assetId}';
      ${clean ? "" : `INSERT INTO file_multipart_uploads(version_id,event_id,asset_id,upload_id,idempotency_key,status,part_size_bytes,expires_at) SELECT '${versionId}',event_id,id,'expired-browser-fixture','${randomUUID()}','initiated',10485760,unixepoch()-1 FROM file_assets WHERE id='${assetId}';`}`,
    );
    wrangler(["d1", "execute", "program-cue-db", "--file", sql]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    bytes,
    versionId,
    // Only a synthetic intent was seeded; release it so the normal demo reset
    // is not blocked by work that has no corresponding provider upload.
    abortPendingUpload() {
      wrangler([
        "d1",
        "execute",
        "program-cue-db",
        "--command",
        `UPDATE file_multipart_uploads SET status='aborted' WHERE version_id='${versionId}' AND status IN ('requested','initiated');
         UPDATE file_versions SET upload_status='aborted',scan_status='failed' WHERE id='${versionId}' AND upload_status IN ('requested','uploading');`,
      ]);
    },
  };
}

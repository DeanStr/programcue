import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ContentManagementService } from "~/modules/content/content-management-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { action } from "./admin-content-zip";

const workerEnv = env as unknown as CloudflareEnvironment;
const viewer = {
  personId: DEMO_IDENTITIES.administrator.personId,
  name: DEMO_IDENTITIES.administrator.name,
  email: DEMO_IDENTITIES.administrator.email,
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  role: "administrator" as const,
  demo: true,
};

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

beforeEach(async () => {
  await ensureDemoSpeakerData(workerEnv);
});

describe("administrator content ZIP resource", () => {
  it("returns confirmed ZIP bytes from a resource route", async () => {
    const suffix = crypto.randomUUID();
    const assetId = `route-zip-asset-${suffix}`;
    const versionId = `route-zip-version-${suffix}`;
    const objectKey = `private/route-zip-tests/${versionId}`;
    const bytes = new TextEncoder().encode("route ZIP transport evidence");
    const stored = await workerEnv.FILES.put(objectKey, bytes);
    if (!stored) throw new Error("The route ZIP test object was not stored.");
    const session = await workerEnv.DB.prepare(
      `SELECT session.id, speaker.person_id AS speakerId
         FROM sessions session
         JOIN session_speakers speaker
           ON speaker.event_id = session.event_id
          AND speaker.session_id = session.id
        WHERE session.event_id = ?
        LIMIT 1`,
    )
      .bind(DEMO_EVENT_ID)
      .first<{ id: string; speakerId: string }>();
    if (!session) throw new Error("The demo session fixture is unavailable.");
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'session', ?, 'slides', 'active',
                   unixepoch(), unixepoch())`,
      ).bind(assetId, DEMO_EVENT_ID, session.speakerId, session.id),
      workerEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, created_at, uploaded_at,
           scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'route-evidence.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean', ?,
                   unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        versionId,
        DEMO_EVENT_ID,
        assetId,
        objectKey,
        bytes.byteLength,
        stored.httpEtag,
        session.speakerId,
      ),
      workerEnv.DB.prepare(
        `UPDATE file_assets
            SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(versionId, assetId, DEMO_EVENT_ID),
    ]);

    const preview = await new ContentManagementService(workerEnv).previewZip(
      viewer,
      { assetIds: [assetId], groupBy: "session" },
    );
    const eventCookie = currentEventCookie(DEMO_EVENT_ID, workerEnv).split(
      ";",
      1,
    )[0];
    const form = new FormData();
    form.set("intent", "download-zip");
    form.set("manifest", preview.manifest);
    form.set("groupBy", preview.groupBy);
    form.set("confirmed", "true");
    const response = await action({
      request: new Request("http://localhost/admin/content/export.zip", {
        method: "POST",
        headers: {
          cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
          origin: "http://localhost",
        },
        body: form,
      }),
      params: {},
      context: context(),
    } as never);

    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="',
    );
    const zip = new Uint8Array(await response.arrayBuffer());
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip)).toContain(
      "route ZIP transport evidence",
    );
  });
});

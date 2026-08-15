import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import {
  publishedHeadshotPath,
  PublicProgrammeService,
} from "~/modules/programme/public-programme-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader } from "./public-headshot";

const testEnv = env as unknown as CloudflareEnvironment;
const filePolicy =
  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}';

function context() {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

async function responseFor(slug: string, personId: string) {
  try {
    return await loader({
      request: new Request(
        `https://programcue.test/public/programme/${slug}/speakers/${personId}/headshot`,
      ),
      params: { slug, personId },
      context: context(),
    } as never);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

async function createCleanHeadshot(eventId: string, personId: string) {
  const suffix = crypto.randomUUID();
  const assetId = `headshot-asset-${suffix}`;
  const versionId = `headshot-version-${suffix}`;
  const objectKey = `private/events/${eventId}/person/${personId}/${assetId}/${versionId}`;
  const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const object = await env.FILES.put(objectKey, body, {
    httpMetadata: { contentType: "image/png" },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'active', unixepoch(), unixepoch())`,
    ).bind(assetId, eventId, personId, personId),
    env.DB.prepare(
      `INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key,
         original_filename, declared_content_type, detected_content_type,
         size_bytes, object_etag, upload_status, signature_status, scan_status,
         created_by_person_id, created_at, uploaded_at, scanned_at, released_at
       ) VALUES (?, ?, ?, 1, ?, 'headshot.png', 'image/png', 'image/png',
                 ?, ?, 'uploaded', 'valid', 'clean', ?, unixepoch(),
                 unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      versionId,
      eventId,
      assetId,
      objectKey,
      body.byteLength,
      object.httpEtag,
      personId,
    ),
    env.DB.prepare(
      `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    ).bind(versionId, assetId, eventId),
  ]);
  return { assetId, body, objectKey, versionId };
}

async function createSecondPublishedEvent(personId: string) {
  const suffix = crypto.randomUUID();
  const eventId = `headshot-other-event-${suffix}`;
  const slug = `headshot-other-${suffix}`;
  const sessionId = `headshot-other-session-${suffix}`;
  const versionId = `headshot-other-version-${suffix}`;
  const roomId = `headshot-other-room-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         file_policy_json, programme_published_at, created_at, updated_at
       ) VALUES (?, 'org-future-events', 'Other published event', ?, 'UTC',
                 4070908800, 4070995200, ?, unixepoch(), unixepoch(), unixepoch())`,
    ).bind(eventId, slug, filePolicy),
    env.DB.prepare(
      `INSERT INTO rooms (id, event_id, name, capacity, position)
       VALUES (?, ?, 'Other room', 100, 0)`,
    ).bind(roomId, eventId),
    env.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, format, duration_minutes, status,
         visibility, created_at, updated_at
       ) VALUES (?, ?, 'Other public session', ?, 'presentation', 30,
                 'published', 'public', unixepoch(), unixepoch())`,
    ).bind(sessionId, eventId, `other-session-${suffix}`),
    env.DB.prepare(
      `INSERT INTO schedule_versions (
         id, event_id, version_number, status, created_at, published_at
       ) VALUES (?, ?, 1, 'published', unixepoch(), unixepoch())`,
    ).bind(versionId, eventId),
    env.DB.prepare(
      `UPDATE schedule_session_contents
          SET content_status = 'approved', approved_by_person_id = NULL,
              approved_at = unixepoch(), approval_source = 'legacy_publication'
        WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
    ).bind(versionId, eventId, sessionId),
    env.DB.prepare(
      `INSERT INTO schedule_entries (
         id, event_id, schedule_version_id, session_id, room_id,
         starts_at, ends_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 4070912400, 4070914200, unixepoch(), unixepoch())`,
    ).bind(
      `headshot-other-entry-${suffix}`,
      eventId,
      versionId,
      sessionId,
      roomId,
    ),
    env.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
    ).bind(sessionId, eventId, personId),
  ]);
  return { eventId, slug };
}

describe("published programme headshots", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM file_assets WHERE asset_kind = 'headshot'"),
      env.DB.prepare(
        `UPDATE people SET profile_status = 'published', image_url = NULL
          WHERE id LIKE 'person-demo-%'`,
      ),
      env.DB.prepare(
        "DELETE FROM events WHERE id LIKE 'headshot-other-event-%'",
      ),
    ]);
  });

  it("derives a public URL only for the exact current clean and released headshot", async () => {
    const service = new PublicProgrammeService(testEnv);
    const initial = await service.getPublished("future-of-events-2027");
    const speaker = initial!.speakers[0];
    await env.DB.prepare("UPDATE people SET image_url = ? WHERE id = ?")
      .bind("https://private.example.test/not-a-public-headshot", speaker.id)
      .run();

    expect(
      (await service.getPublished("future-of-events-2027"))!.speakers.find(
        (candidate) => candidate.id === speaker.id,
      )?.imageUrl,
    ).toMatch(/^\/images\/demo-speakers\//u);

    const headshot = await createCleanHeadshot("evt-foe-2025", speaker.id);
    expect(
      (await service.getPublished("future-of-events-2027"))!.speakers.find(
        (candidate) => candidate.id === speaker.id,
      )?.imageUrl,
    ).toBe(publishedHeadshotPath("future-of-events-2027", speaker.id));
    await expect(
      service.getReleasedPublishedHeadshotPath(
        "future-of-events-2027",
        speaker.id,
      ),
    ).resolves.toBe(publishedHeadshotPath("future-of-events-2027", speaker.id));

    const response = await responseFor("future-of-events-2027", speaker.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(headshot.body);
    await env.FILES.delete(headshot.objectKey);
    await expect(
      service.getReleasedPublishedHeadshotPath(
        "future-of-events-2027",
        speaker.id,
      ),
    ).resolves.toBeNull();

    const pendingVersionId = `pending-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, size_bytes,
           upload_status, signature_status, scan_status,
           created_by_person_id, created_at
         ) VALUES (?, 'evt-foe-2025', ?, 2, ?, 'replacement.png',
                   'image/png', 8, 'uploading', 'pending', 'pending', ?, unixepoch())`,
      ).bind(
        pendingVersionId,
        headshot.assetId,
        `${headshot.objectKey}-pending`,
        speaker.id,
      ),
      env.DB.prepare(
        `UPDATE file_assets SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = 'evt-foe-2025'`,
      ).bind(pendingVersionId, headshot.assetId),
    ]);

    expect(
      (await service.getPublished("future-of-events-2027"))!.speakers.find(
        (candidate) => candidate.id === speaker.id,
      )?.imageUrl,
    ).toBeNull();
    expect(
      (await responseFor("future-of-events-2027", speaker.id)).status,
    ).toBe(404);
  });

  it("fails fast when a released headshot requires an unavailable FILES binding", async () => {
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2027",
    );
    const speaker = programme!.speakers[0];
    await createCleanHeadshot("evt-foe-2025", speaker.id);
    const service = new PublicProgrammeService({
      ...testEnv,
      FILES: undefined,
    } as unknown as CloudflareEnvironment);

    await expect(
      service.getReleasedPublishedHeadshotPath(
        "future-of-events-2027",
        speaker.id,
      ),
    ).rejects.toThrow("Required private R2 binding FILES is unavailable.");
  });

  it("does not expose a clean headshot after its speaker profile becomes private", async () => {
    const service = new PublicProgrammeService(testEnv);
    const programme = await service.getPublished("future-of-events-2027");
    const personId = programme!.speakers[0].id;
    await createCleanHeadshot("evt-foe-2025", personId);
    await env.DB.prepare(
      "UPDATE people SET profile_status = 'draft' WHERE id = ?",
    )
      .bind(personId)
      .run();

    expect(
      (await service.getPublished("future-of-events-2027"))!.speakers.some(
        (speaker) => speaker.id === personId,
      ),
    ).toBe(false);
    expect((await responseFor("future-of-events-2027", personId)).status).toBe(
      404,
    );
  });

  it("does not expose an infected or quarantined current headshot", async () => {
    const service = new PublicProgrammeService(testEnv);
    const programme = await service.getPublished("future-of-events-2027");
    const personId = programme!.speakers[0].id;
    const headshot = await createCleanHeadshot("evt-foe-2025", personId);
    await env.DB.prepare(
      `UPDATE file_versions
          SET scan_status = 'infected', scan_error = 'quarantined', released_at = NULL
        WHERE id = ? AND event_id = 'evt-foe-2025'`,
    )
      .bind(headshot.versionId)
      .run();

    expect(
      (await service.getPublished("future-of-events-2027"))!.speakers.find(
        (speaker) => speaker.id === personId,
      )?.imageUrl,
    ).toBeNull();
    expect((await responseFor("future-of-events-2027", personId)).status).toBe(
      404,
    );
  });

  it("does not expose a clean headshot for an inactive event", async () => {
    const service = new PublicProgrammeService(testEnv);
    const programme = await service.getPublished("future-of-events-2027");
    const personId = programme!.speakers[0].id;
    await createCleanHeadshot("evt-foe-2025", personId);
    await env.DB.prepare(
      `UPDATE events SET activation_status = 'provisioning_failed'
        WHERE id = 'evt-foe-2025'`,
    ).run();

    try {
      expect(
        (await responseFor("future-of-events-2027", personId)).status,
      ).toBe(404);
    } finally {
      await env.DB.prepare(
        `UPDATE events SET activation_status = 'active'
          WHERE id = 'evt-foe-2025'`,
      ).run();
    }
  });

  it("never resolves another event's private headshot through a public slug", async () => {
    const service = new PublicProgrammeService(testEnv);
    const primary = await service.getPublished("future-of-events-2027");
    const personId = primary!.speakers[0].id;
    await createCleanHeadshot("evt-foe-2025", personId);
    const other = await createSecondPublishedEvent(personId);

    const otherProgramme = await service.getPublished(other.slug);
    expect(otherProgramme?.speakers).toEqual([
      expect.objectContaining({ id: personId, imageUrl: null }),
    ]);
    expect((await responseFor(other.slug, personId)).status).toBe(404);
    expect((await responseFor("future-of-events-2027", personId)).status).toBe(
      200,
    );
  });
});

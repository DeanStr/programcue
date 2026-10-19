import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { FileService } from "~/modules/files/file-service.server";
import { MultipartUploadService } from "~/modules/files/multipart-upload.server";
import {
  MultipartUploadAccessRepository,
  multipartIdempotencyKey,
} from "~/modules/files/multipart-upload-access.server";
import { MultipartUploadAuthorizer } from "~/modules/files/multipart-upload-authorizer.server";
import { PublicSiteService } from "~/modules/public-site/public-site-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  requireAuthenticatedPerson,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { sponsorAssetState } from "./sponsor-assets";
import { SponsorAssetService } from "./sponsor-assets.server";
import { SponsorReadinessService } from "./sponsor-readiness.server";
import type { SponsorPerson } from "./sponsor-schema";
import { SponsorService } from "./sponsor-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const key = () => crypto.randomUUID();
const publicProfile = {
  name: "Website sponsor",
  tier: "Gold",
  description: "Public company details",
  websiteUrl: "https://sponsor.example.com",
};
let service: SponsorService,
  assets: SponsorAssetService,
  sponsorId: string,
  requestId: string,
  person: SponsorPerson;
beforeEach(async () => {
  await ensureDemoSpeakerData(env);
  service = new SponsorService(env);
  assets = new SponsorAssetService(env);
  person = {
    personId: "person-demo-speaker",
    email: (await env.DB.prepare("SELECT email FROM people WHERE id=?")
      .bind("person-demo-speaker")
      .first<{ email: string }>())!.email,
    restrictedOrganisationId: null,
  };
  sponsorId = await service.save(
    viewer,
    {
      name: `Asset company ${key()}`,
      tier: "Gold",
      sessionLimit: 0,
      closesAt: null,
    },
    key(),
  );
  await service.addContact(
    viewer,
    sponsorId,
    { name: "Priya", email: person.email },
    key(),
  );
  requestId = await assets.request(
    viewer,
    sponsorId,
    { name: "Company logo", kind: "logo", required: true },
    key(),
  );
});
async function upload(clean = true) {
  const assetId = key(),
    versionId = key(),
    objectKey = `sponsors/${key()}.png`;
  const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const object = await env.FILES.put(objectKey, body);
  if (!object) throw new Error("Test upload did not store bytes");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_assets(id,event_id,target_type,target_id,asset_kind,status,current_version_id) VALUES (?,?,'resource',?,'other',?,?)`,
    ).bind(
      assetId,
      viewer.eventId,
      requestId,
      clean ? "active" : "pending",
      clean ? versionId : null,
    ),
    env.DB.prepare(
      `INSERT INTO file_versions(id,event_id,asset_id,version_number,object_key,original_filename,declared_content_type,detected_content_type,size_bytes,object_etag,upload_status,signature_status,scan_status,released_at,created_by_person_id) VALUES (?,?,?,1,?,'logo.png','image/png','image/png',10,?,'uploaded','valid',?,?,?)`,
    ).bind(
      versionId,
      viewer.eventId,
      assetId,
      objectKey,
      object.httpEtag,
      clean ? "clean" : "pending",
      clean ? Math.floor(Date.now() / 1000) : null,
      person.personId,
    ),
  ]);
  return { assetId, versionId, body };
}
async function approve(versionId: string) {
  const a = (await assets.adminAssets(viewer, sponsorId))[0];
  await assets.review(
    viewer,
    sponsorId,
    {
      id: requestId,
      versionId,
      revision: a.revision,
      decision: "approved",
      note: "",
    },
    key(),
  );
}
it("requires accepted, current company access on every upload step and rejects other targets", async () => {
  await expect(
    assets.actor(person, viewer.eventId, sponsorId),
  ).rejects.toMatchObject({ status: 404 });
  await service.accept(person, viewer.eventId, sponsorId, key());
  const actor = await assets.actor(person, viewer.eventId, sponsorId);
  const auth = new MultipartUploadAuthorizer(env);
  const target = {
    targetType: "resource" as const,
    targetId: requestId,
    assetKind: "other" as const,
  };
  await expect(auth.assertTarget(actor, target)).resolves.toBeNull();
  await expect(
    auth.assertTarget(actor, { ...target, targetId: "another-company" }),
  ).rejects.toThrow("unavailable");
  await expect(
    auth.assertTarget(actor, { ...target, assetKind: "headshot" }),
  ).rejects.toThrow("file type");
  await expect(
    auth.assertTarget({ ...actor, organisationId: "other" }, target),
  ).rejects.toThrow("unavailable");
  await expect(
    new MultipartUploadService({
      ...env,
      DB: env.DB,
      FILES: env.FILES,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment).initiate(actor, {
      target,
      filename: "fake.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      idempotencyKey: key(),
    }),
  ).rejects.toThrow("extension");
  const contact = (await service.adminWorkspace(viewer, sponsorId)).contacts[0];
  await service.revokeContact(
    viewer,
    sponsorId,
    contact.id,
    contact.revision,
    key(),
  );
  await expect(auth.assertTarget(actor, target)).rejects.toThrow("unavailable");
  await expect(
    assets.portalAssets(person, viewer.eventId, sponsorId),
  ).rejects.toMatchObject({ status: 404 });
});
it("enforces editing deadlines without preventing organisers reviewing existing files", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const actor = await assets.actor(person, viewer.eventId, sponsorId);
  await env.DB.prepare(
    "UPDATE event_sponsorships SET closes_at=unixepoch()-1 WHERE id=?",
  )
    .bind(sponsorId)
    .run();
  await expect(
    new MultipartUploadAuthorizer(env).assertTarget(actor, {
      targetType: "resource",
      targetId: requestId,
      assetKind: "other",
    }),
  ).rejects.toThrow("deadline");
  const v = await upload();
  await approve(v.versionId);
  expect(
    sponsorAssetState((await assets.adminAssets(viewer, sponsorId))[0]),
  ).toBe("approved");
});
it("keeps quarantined files private, pins reviews and requires review of replacements", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const pending = await upload(false);
  await expect(
    assets.portalDownload(
      person,
      viewer.eventId,
      sponsorId,
      requestId,
      pending.versionId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(approve(pending.versionId)).rejects.toThrow("latest clean");
  const clean = await upload();
  await approve(clean.versionId);
  const response = await assets.portalDownload(
    person,
    viewer.eventId,
    sponsorId,
    requestId,
    clean.versionId,
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(clean.body);
  await expect(
    assets.portalDownload(
      { ...person, email: "stranger@example.com" },
      viewer.eventId,
      sponsorId,
      requestId,
      clean.versionId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await upload();
  expect(
    sponsorAssetState((await assets.adminAssets(viewer, sponsorId))[0]),
  ).toBe("review");
  await expect(approve(clean.versionId)).rejects.toThrow("latest clean");
});
it("stages one approved logo idempotently, exposes only published bytes and removes public access on withdrawal", async () => {
  const uploaded = await upload();
  await approve(uploaded.versionId);
  const site = new PublicSiteService(env);
  const initial = await site.getWorkspace(viewer);
  initial.draft.configuration.sectionVisibility.introduction = false;
  initial.draft.configuration.sectionVisibility.venue = false;
  await site.saveDraft(viewer, {
    commandId: key(),
    revision: initial.draft.revision,
    configurationJson: JSON.stringify(initial.draft.configuration),
  });
  const command = key();
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    publicProfile,
    command,
  );
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    publicProfile,
    command,
  );
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    publicProfile,
    key(),
  );
  const w = await site.getWorkspace(viewer);
  expect(
    w.sponsors.filter((s) => s.id === `sponsor-portal-${sponsorId}`),
  ).toHaveLength(1);
  await expect(
    assets.publicLogo(viewer.eventId, requestId, uploaded.versionId),
  ).rejects.toMatchObject({ status: 404 });
  await site.publish(viewer, {
    commandId: key(),
    revision: w.draft.revision,
    confirmed: "true",
  });
  expect(
    new Uint8Array(
      await (
        await assets.publicLogo(viewer.eventId, requestId, uploaded.versionId)
      ).arrayBuffer(),
    ),
  ).toEqual(uploaded.body);
  const saved = (await site.getWorkspace(viewer)).sponsors.find(
    (s) => s.id === `sponsor-portal-${sponsorId}`,
  )!;
  await site.deleteSponsor(viewer, {
    commandId: key(),
    id: saved.id,
    revision: saved.revision,
    confirmed: "true",
  });
  expect(
    (await assets.publicLogo(viewer.eventId, requestId, uploaded.versionId))
      .status,
  ).toBe(200);
  await site.publish(viewer, {
    commandId: key(),
    revision: (await site.getWorkspace(viewer)).draft.revision,
    confirmed: "true",
  });
  await expect(
    assets.publicLogo(viewer.eventId, requestId, uploaded.versionId),
  ).rejects.toMatchObject({ status: 404 });
});
it("filters readiness and excludes scan/review work from reminder recipients", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const readiness = new SponsorReadinessService(env);
  const name = (await service.adminWorkspace(viewer, sponsorId)).sponsor.name;
  let w = await readiness.workspace(viewer, { q: name, state: "assets" });
  expect(w.rows).toHaveLength(1);
  expect(w.recipients).toHaveLength(1);
  await upload(false);
  w = await readiness.workspace(viewer, { q: name });
  expect(w.recipients).toHaveLength(0);
  const v = await upload();
  w = await readiness.workspace(viewer, { q: name, state: "review" });
  expect(w.rows).toHaveLength(1);
  expect(w.recipients).toHaveLength(0);
  await approve(v.versionId);
  w = await readiness.workspace(viewer, { q: name, state: "ready" });
  expect(w.rows).toHaveLength(1);
});

it.each(["logo", "document"] as const)(
  "runs sponsor %s multipart completion through private R2 and scan release without granting event membership",
  async (kind) => {
    if (kind === "document")
      requestId = await assets.request(
        viewer,
        sponsorId,
        { name: "Supporting document", kind, required: true },
        key(),
      );
    await service.accept(person, viewer.eventId, sponsorId, key());
    const actor = await assets.actor(person, viewer.eventId, sponsorId);
    const { completeTestDirectUpload, acceptTestFileScanDispatch } =
      await import("~/modules/files/direct-upload.test-helper");
    const { FileService } = await import("~/modules/files/file-service.server");
    const bytes =
      kind === "logo"
        ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
        : new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
    const result = await completeTestDirectUpload(
      env,
      actor,
      {
        targetType: "resource",
        targetId: requestId,
        assetKind: kind === "logo" ? "other" : "supporting_document",
      },
      new File([bytes], kind === "logo" ? "brand.png" : "brief.pdf", {
        type: kind === "logo" ? "image/png" : "application/pdf",
      }),
    );
    expect(
      sponsorAssetState(
        (await assets.portalAssets(person, viewer.eventId, sponsorId)).find(
          (a) => a.id === requestId,
        )!,
      ),
    ).toBe("scanning");
    const identity = await acceptTestFileScanDispatch(
      env,
      viewer.eventId,
      result.versionId,
    );
    await new FileService(env).recordScanResult({
      ...identity,
      eventId: viewer.eventId,
      versionId: result.versionId,
      status: "clean",
      provider: "test-scanner",
      callbackId: key(),
      result: { fixture: true },
    });
    expect(
      sponsorAssetState(
        (await assets.portalAssets(person, viewer.eventId, sponsorId)).find(
          (a) => a.id === requestId,
        )!,
      ),
    ).toBe("review");
    expect(
      new Uint8Array(
        await (
          await assets.portalDownload(
            person,
            viewer.eventId,
            sponsorId,
            requestId,
            result.versionId,
          )
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
  },
);

it("rejects publication after replacement and rolls back a staged logo when its approval changes during the commit", async () => {
  const original = await upload();
  await approve(original.versionId);
  const site = new PublicSiteService(env);
  const initial = await site.getWorkspace(viewer);
  initial.draft.configuration.sectionVisibility.introduction = false;
  initial.draft.configuration.sectionVisibility.venue = false;
  await site.saveDraft(viewer, {
    commandId: key(),
    revision: initial.draft.revision,
    configurationJson: JSON.stringify(initial.draft.configuration),
  });
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    original.versionId,
    publicProfile,
    key(),
  );
  const draft = await site.getWorkspace(viewer);
  await upload(false);
  await expect(
    site.publish(viewer, {
      commandId: key(),
      revision: draft.draft.revision,
      confirmed: "true",
    }),
  ).rejects.toThrow("Selected sponsor logo");
  expect((await site.getWorkspace(viewer)).published).toEqual(draft.published);
  const replacement = await upload();
  await approve(replacement.versionId);
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi
    .spyOn(env.DB, "batch")
    .mockImplementationOnce(async (statements) => {
      await env.DB.prepare(
        "UPDATE sponsor_asset_requests SET review_status='changes_requested',revision=revision+1 WHERE id=?",
      )
        .bind(requestId)
        .run();
      return batch(statements);
    });
  try {
    await expect(
      assets.stageLogo(
        viewer,
        sponsorId,
        requestId,
        replacement.versionId,
        publicProfile,
        key(),
      ),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(
    (await site.getWorkspace(viewer)).sponsors.find(
      (s) => s.id === `sponsor-portal-${sponsorId}`,
    )?.logoUrl,
  ).toContain(original.versionId);
  const staged = (await site.getWorkspace(viewer)).sponsors.find(
    (s) => s.id === `sponsor-portal-${sponsorId}`,
  )!;
  await site.deleteSponsor(viewer, {
    commandId: key(),
    id: staged.id,
    revision: staged.revision,
    confirmed: "true",
  });
});

it("requires feedback, recomputes reminder recipients and excludes closed deadlines", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const v = await upload();
  const request = (await assets.adminAssets(viewer, sponsorId))[0];
  const review = {
    id: requestId,
    versionId: v.versionId,
    revision: request.revision,
    decision: "changes_requested",
    note: "",
  };
  await expect(assets.review(viewer, sponsorId, review, key())).rejects.toThrow(
    "Explain",
  );
  await expect(
    assets.review(
      { ...viewer, role: "speaker" },
      sponsorId,
      { ...review, note: "Use a transparent logo" },
      key(),
    ),
  ).rejects.toThrow();
  await assets.review(
    viewer,
    sponsorId,
    { ...review, note: "Use a transparent logo" },
    key(),
  );
  const readiness = new SponsorReadinessService(env);
  const q = (await service.adminWorkspace(viewer, sponsorId)).sponsor.name;
  const { CommunicationService } = await import(
    "~/modules/communications/communication-service.server"
  );
  const communications = new CommunicationService(env);
  const template = await communications.saveTemplate(viewer, {
    name: "Sponsor action reminder",
    category: "ad_hoc",
    subject: "Please complete your sponsor requirements",
    content: {
      body: "Hello {{recipient.name}}, please review your sponsor portal.",
      physicalAddress: "Toronto convention centre",
    },
  });
  await communications.publishTemplate(viewer, template.versionId);
  const w = await readiness.workspace(viewer, { q, state: "assets" });
  expect(w.recipients.map((r) => r.email)).toEqual([person.email]);
  expect(w.templates.length).toBeGreaterThan(0);
  const draft = await readiness.reminder(
    viewer,
    { q, state: "assets" },
    w.templates[0].id,
    key(),
  );
  expect(draft.id).toBeTruthy();
  await env.DB.prepare(
    "UPDATE event_sponsorships SET closes_at=unixepoch()-1 WHERE id=?",
  )
    .bind(sponsorId)
    .run();
  expect((await readiness.workspace(viewer, { q })).recipients).toEqual([]);
  await expect(
    readiness.reminder(viewer, { q }, w.templates[0].id, key()),
  ).rejects.toThrow("No matching sponsors");
});

it("rejects completion if the company revokes access between file validation and the durable commit", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const actor = await assets.actor(person, viewer.eventId, sponsorId);
  const { completeTestDirectUpload } = await import(
    "~/modules/files/direct-upload.test-helper"
  );
  const batch = env.DB.batch.bind(env.DB);
  let revoked = false;
  const spy = vi
    .spyOn(env.DB, "batch")
    .mockImplementation(async (statements) => {
      const completing = await env.DB.prepare(
        "SELECT u.version_id FROM file_multipart_uploads u JOIN file_assets a ON a.id=u.asset_id AND a.event_id=u.event_id WHERE a.target_id=? AND u.status='completing'",
      )
        .bind(requestId)
        .first();
      if (completing && !revoked) {
        revoked = true;
        await env.DB.prepare(
          "UPDATE sponsor_contacts SET revoked_at=unixepoch() WHERE sponsor_id=?",
        )
          .bind(sponsorId)
          .run();
      }
      return batch(statements);
    });
  try {
    await expect(
      completeTestDirectUpload(
        env,
        actor,
        { targetType: "resource", targetId: requestId, assetKind: "other" },
        new File(
          [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])],
          "logo.png",
          { type: "image/png" },
        ),
      ),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(revoked).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT v.id FROM file_versions v JOIN file_assets a ON a.id=v.asset_id AND a.event_id=v.event_id WHERE a.target_id=? AND v.upload_status='uploaded'",
    )
      .bind(requestId)
      .first(),
  ).toBeNull();
});

async function stageAndPublishLogo() {
  const uploaded = await upload();
  await approve(uploaded.versionId);
  const site = new PublicSiteService(env);
  const initial = await site.getWorkspace(viewer);
  initial.draft.configuration.sectionVisibility.introduction = false;
  initial.draft.configuration.sectionVisibility.venue = false;
  await site.saveDraft(viewer, {
    commandId: key(),
    revision: initial.draft.revision,
    configurationJson: JSON.stringify(initial.draft.configuration),
  });
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    publicProfile,
    key(),
  );
  await site.publish(viewer, {
    commandId: key(),
    revision: (await site.getWorkspace(viewer)).draft.revision,
    confirmed: "true",
  });
  return { uploaded, site };
}

it("stages editable public details without narrowing or rewriting the company profile", async () => {
  const company = {
    name: `${key()}${"x".repeat(124)}`,
    tier: "",
    description: "x".repeat(3000),
    websiteUrl: "https://company.example.com",
    sessionLimit: 0,
    closesAt: null,
  };
  await service.save(viewer, company, key(), { id: sponsorId, revision: 1 });
  const uploaded = await upload();
  await approve(uploaded.versionId);
  await expect(
    assets.stageLogo(
      viewer,
      sponsorId,
      requestId,
      uploaded.versionId,
      company,
      key(),
    ),
  ).rejects.toThrow("120 characters");
  await expect(
    assets.stageLogo(
      viewer,
      sponsorId,
      requestId,
      uploaded.versionId,
      { ...publicProfile, tier: "" },
      key(),
    ),
  ).rejects.toThrow("Enter a sponsor tier");
  await expect(
    assets.stageLogo(
      viewer,
      sponsorId,
      requestId,
      uploaded.versionId,
      { ...publicProfile, description: company.description },
      key(),
    ),
  ).rejects.toThrow("1,000 characters");
  const command = key();
  await assets.stageLogo(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    publicProfile,
    command,
  );
  const website = (
    await new PublicSiteService(env).getWorkspace(viewer)
  ).sponsors.find((s) => s.id === `sponsor-portal-${sponsorId}`);
  expect(website).toMatchObject(publicProfile);
  expect(
    (await service.adminWorkspace(viewer, sponsorId)).sponsor,
  ).toMatchObject(company);
  await expect(
    assets.stageLogo(
      viewer,
      sponsorId,
      requestId,
      uploaded.versionId,
      { ...publicProfile, name: "Changed public copy" },
      command,
    ),
  ).rejects.toThrow("different details");
});

it.each(["requested", "initiated"])(
  "counts an expired %s upload as actionable and allows a fresh upload",
  async (status) => {
    await service.accept(person, viewer.eventId, sponsorId, key());
    const actor = await assets.actor(person, viewer.eventId, sponsorId);
    const uploads = new MultipartUploadService({
      ...env,
      DB: env.DB,
      FILES: env.FILES,
      OPERATIONS_QUEUE: { send: async () => undefined },
    } as unknown as CloudflareEnvironment);
    const input = {
      target: {
        targetType: "resource",
        targetId: requestId,
        assetKind: "other",
      },
      filename: "logo.png",
      contentType: "image/png",
      sizeBytes: 10,
      idempotencyKey: key(),
    };
    const initiated = await uploads.initiate(actor, input);
    const readiness = new SponsorReadinessService(env);
    const q = (await service.adminWorkspace(viewer, sponsorId)).sponsor.name;
    expect((await readiness.workspace(viewer, { q })).recipients).toHaveLength(
      0,
    );
    await env.DB.prepare(
      "UPDATE file_multipart_uploads SET status=?,expires_at=unixepoch()-1 WHERE version_id=?",
    )
      .bind(status, initiated.versionId)
      .run();
    const expired = (await assets.adminAssets(viewer, sponsorId))[0];
    expect(sponsorAssetState(expired)).toBe("upload_expired");
    const w = await readiness.workspace(viewer, { q, state: "assets" });
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].readiness.actionableAssets).toBe(1);
    expect(w.recipients.map((c) => c.email)).toEqual([person.email]);
    // A completing upload remains recoverable beyond the initiation deadline.
    await env.DB.prepare(
      "UPDATE file_multipart_uploads SET status='completing' WHERE version_id=?",
    )
      .bind(initiated.versionId)
      .run();
    expect(
      sponsorAssetState((await assets.adminAssets(viewer, sponsorId))[0]),
    ).toBe("uploading");
    await env.DB.prepare(
      "UPDATE file_multipart_uploads SET status=? WHERE version_id=?",
    )
      .bind(status, initiated.versionId)
      .run();
    const fresh = await uploads.initiate(actor, {
      ...input,
      idempotencyKey: key(),
    });
    expect(fresh.versionId).not.toBe(initiated.versionId);
    expect(
      sponsorAssetState((await assets.adminAssets(viewer, sponsorId))[0]),
    ).toBe("uploading");
    expect(
      (await readiness.workspace(viewer, { q, state: "assets" })).rows,
    ).toHaveLength(0);
  },
);

it.each(["withdrawal", "file revocation"])(
  "denies public bytes if %s commits during the R2 read",
  async (change) => {
    const { uploaded, site } = await stageAndPublishLogo();
    const get = env.FILES.get.bind(env.FILES);
    let body: ReadableStream | null = null;
    const spy = vi
      .spyOn(env.FILES, "get")
      .mockImplementationOnce(async (objectKey: string) => {
        const object = await get(objectKey);
        body = object?.body ?? null;
        if (change === "withdrawal") {
          const sponsor = (await site.getWorkspace(viewer)).sponsors.find(
            (s) => s.id === `sponsor-portal-${sponsorId}`,
          )!;
          await site.deleteSponsor(viewer, {
            commandId: key(),
            id: sponsor.id,
            revision: sponsor.revision,
            confirmed: "true",
          });
          await site.publish(viewer, {
            commandId: key(),
            revision: (await site.getWorkspace(viewer)).draft.revision,
            confirmed: "true",
          });
        } else {
          await env.DB.prepare(
            "UPDATE file_versions SET released_at=NULL WHERE id=?",
          )
            .bind(uploaded.versionId)
            .run();
        }
        return object;
      });
    try {
      await expect(
        assets.publicLogo(viewer.eventId, requestId, uploaded.versionId),
      ).rejects.toMatchObject({ status: 404 });
      expect(body).not.toBeNull();
      const stream = body as ReadableStream | null;
      expect(await stream?.getReader().read()).toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      spy.mockRestore();
    }
    if (change === "file revocation") {
      const sponsor = (await site.getWorkspace(viewer)).sponsors.find(
        (s) => s.id === `sponsor-portal-${sponsorId}`,
      )!;
      await site.deleteSponsor(viewer, {
        commandId: key(),
        id: sponsor.id,
        revision: sponsor.revision,
        confirmed: "true",
      });
    }
  },
);

it("binds upload version and idempotency access to the acting company, including cancellation", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const actorA = await assets.actor(person, viewer.eventId, sponsorId);
  const uploads = new MultipartUploadService({
    ...env,
    DB: env.DB,
    FILES: env.FILES,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment);
  const idempotencyKey = key();
  const declaration = {
    target: { targetType: "resource", targetId: requestId, assetKind: "other" },
    filename: "logo.png",
    contentType: "image/png",
    sizeBytes: 10,
  };
  const first = await uploads.initiate(actorA, {
    ...declaration,
    idempotencyKey,
  });
  const second = await uploads.initiate(actorA, {
    ...declaration,
    idempotencyKey: key(),
  });
  const companyB = await service.save(
    viewer,
    { name: key(), sessionLimit: 0, closesAt: null },
    key(),
  );
  await service.addContact(
    viewer,
    companyB,
    { name: "Priya", email: person.email },
    key(),
  );
  await service.accept(person, viewer.eventId, companyB, key());
  const actorB = await assets.actor(person, viewer.eventId, companyB);
  const access = new MultipartUploadAccessRepository(env);
  await expect(
    access.loadByIdempotency(
      actorB,
      multipartIdempotencyKey(actorB, idempotencyKey),
    ),
  ).rejects.toThrow("another sponsor company");
  await expect(
    uploads.abort(actorB, { versionId: first.versionId }),
  ).rejects.toThrow("another sponsor company");
  expect((await access.loadByVersion(actorA, first.versionId)).status).toBe(
    "initiated",
  );
  // Current contacts must still be able to cancel their own uploads after editing closes.
  await env.DB.prepare(
    "UPDATE event_sponsorships SET closes_at=unixepoch()-1 WHERE id=?",
  )
    .bind(sponsorId)
    .run();
  await expect(
    uploads.abort(actorA, { versionId: first.versionId }),
  ).resolves.toMatchObject({ aborted: true });
  const contact = (await service.adminWorkspace(viewer, sponsorId)).contacts[0];
  await service.revokeContact(
    viewer,
    sponsorId,
    contact.id,
    contact.revision,
    key(),
  );
  await expect(
    assets.actor(person, viewer.eventId, sponsorId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    uploads.abort(actorB, { versionId: second.versionId }),
  ).rejects.toThrow("another sponsor company");
  expect((await access.loadByVersion(viewer, second.versionId)).status).toBe(
    "initiated",
  );
  expect(
    await env.DB.prepare("SELECT 1 FROM audit_events WHERE id=?")
      .bind(`file-multipart-abort:${second.versionId}`)
      .first(),
  ).toBeNull();
  await expect(
    uploads.abort(viewer, { versionId: second.versionId }),
  ).resolves.toMatchObject({ aborted: true });
});

it("downloads as an authenticated demo contact without inferring administrator authority from its role", async () => {
  await service.accept(person, viewer.eventId, sponsorId, key());
  const uploaded = await upload();
  const identity = await requireAuthenticatedPerson(
    new Request("http://localhost/sponsor", {
      headers: { cookie: "program_cue_demo_identity=speaker" },
    }),
    env,
  );
  const response = await assets.portalDownload(
    identity,
    viewer.eventId,
    sponsorId,
    requestId,
    uploaded.versionId,
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(uploaded.body);
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const preview = await assets.adminDownload(
    viewer,
    sponsorId,
    requestId,
    uploaded.versionId,
    true,
  );
  expect(preview.headers.get("content-disposition")).toContain("inline");
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(uploaded.body);
  await expect(
    assets.adminDownload(
      { ...viewer, role: "speaker" },
      sponsorId,
      requestId,
      uploaded.versionId,
    ),
  ).rejects.toMatchObject({ status: 403 });
  const contact = (await service.adminWorkspace(viewer, sponsorId)).contacts[0];
  await service.revokeContact(
    viewer,
    sponsorId,
    contact.id,
    contact.revision,
    key(),
  );
  await expect(
    assets.portalDownload(
      identity,
      viewer.eventId,
      sponsorId,
      requestId,
      uploaded.versionId,
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("reviews the displayed clean version while an erased replacement awaits storage cleanup", async () => {
  const previous = await upload();
  const replacement = await upload();
  expect((await assets.adminAssets(viewer, sponsorId))[0].versionId).toBe(
    replacement.versionId,
  );
  const deletion = vi
    .spyOn(env.FILES, "delete")
    .mockRejectedValueOnce(new Error("Storage cleanup unavailable"));
  try {
    await expect(
      new FileService(env).eraseAsset(viewer, {
        assetId: replacement.assetId,
        confirmed: true,
      }),
    ).rejects.toThrow("did not complete");
  } finally {
    deletion.mockRestore();
  }
  expect(
    await env.DB.prepare("SELECT 1 FROM audit_events WHERE id=?")
      .bind(`file-erasure:${replacement.assetId}`)
      .first(),
  ).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT deleted_at FROM file_versions WHERE id=?")
      .bind(replacement.versionId)
      .first(),
  ).toEqual({ deleted_at: null });
  await expect(
    assets.adminDownload(viewer, sponsorId, requestId, replacement.versionId),
  ).rejects.toMatchObject({ status: 404 });
  const displayed = (await assets.adminAssets(viewer, sponsorId))[0];
  expect(displayed.versionId).toBe(previous.versionId);
  await approve(displayed.versionId!);
  expect(
    sponsorAssetState((await assets.adminAssets(viewer, sponsorId))[0]),
  ).toBe("approved");
  await expect(
    assets.stageLogo(
      viewer,
      sponsorId,
      requestId,
      previous.versionId,
      publicProfile,
      key(),
    ),
  ).resolves.toBe(`sponsor-portal-${sponsorId}`);
});

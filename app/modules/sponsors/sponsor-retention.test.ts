import { describe, expect, it, vi } from "vitest";
import { ParticipantRetentionService } from "~/modules/privacy/participant-retention-service.server";
import { seedExpiredRetentionEvent } from "~/modules/privacy/participant-retention-test-fixture";
import { SponsorAssetService } from "./sponsor-assets.server";
import { SponsorService } from "./sponsor-service.server";

const key = () => crypto.randomUUID();

async function fixture() {
  const seeded = await seedExpiredRetentionEvent();
  const service = new SponsorService(seeded.testEnv);
  const sponsorId = await service.save(
    seeded.owner,
    {
      name: "Private sponsor profile",
      description: "Private contact biography",
      sessionLimit: 5,
      closesAt: null,
    },
    key(),
  );
  const person = {
    personId: seeded.exclusiveId,
    email: `${seeded.exclusiveId}@example.com`,
    restrictedOrganisationId: null,
  };
  await service.addContact(
    seeded.owner,
    sponsorId,
    { name: "Exclusive Person", email: person.email },
    key(),
  );
  await service.accept(person, seeded.eventId, sponsorId, key());
  const trackId = key();
  await seeded.testEnv.DB.prepare(
    "INSERT INTO tracks (id,event_id,name,slug) VALUES (?,?,'Industry','industry')",
  )
    .bind(trackId, seeded.eventId)
    .run();
  const workspace = await service.adminWorkspace(seeded.owner, sponsorId);
  const details = {
    title: "Private proposal",
    description: "Private session description",
    trackId,
    format: workspace.formats[0].key,
    speakers: [
      {
        name: "Exclusive Person",
        email: person.email,
        biography: "Private biography",
      },
      {
        name: "Unregistered Presenter",
        email: "unregistered@example.com",
        biography: "Unregistered private biography",
      },
    ],
  };
  const proposalId = await service.saveProposal(
    person,
    seeded.eventId,
    sponsorId,
    details,
    key(),
  );
  return { ...seeded, service, sponsorId, person, details, proposalId };
}

describe("sponsor participant retention", () => {
  it.each([false, true])(
    "anonymises sponsor-only upload attribution while preserving shared identities when needed: %s",
    async (shared) => {
      const f = await fixture();
      const db = f.testEnv.DB;
      const uploaderId = key();
      const uploader = {
        personId: uploaderId,
        email: `${uploaderId}@example.com`,
        restrictedOrganisationId: null,
      };
      await db
        .prepare(
          "INSERT INTO people(id,email,display_name) VALUES (?,?,'Sponsor-only contact')",
        )
        .bind(uploaderId, uploader.email)
        .run();
      await f.service.addContact(
        f.owner,
        f.sponsorId,
        { name: "Sponsor-only contact", email: uploader.email },
        key(),
      );
      await f.service.accept(uploader, f.eventId, f.sponsorId, key());
      if (shared) {
        const otherViewer = { ...f.owner, eventId: f.otherEventId };
        const otherSponsor = await f.service.save(
          otherViewer,
          { name: "Other event company", sessionLimit: 0, closesAt: null },
          key(),
        );
        await f.service.addContact(
          otherViewer,
          otherSponsor,
          { name: "Sponsor-only contact", email: uploader.email },
          key(),
        );
      }
      const requestId = await new SponsorAssetService(f.testEnv).request(
        f.owner,
        f.sponsorId,
        { name: "Private company document", kind: "document", required: true },
        key(),
      );
      // Resource uploads have no owner; their retained version identifies the uploader.
      await db.batch([
        db
          .prepare(
            "UPDATE file_assets SET owner_person_id=NULL,target_type='resource',target_id=? WHERE id=?",
          )
          .bind(requestId, f.fileAssetId),
        db
          .prepare("UPDATE file_versions SET created_by_person_id=? WHERE id=?")
          .bind(uploaderId, f.fileVersionId),
      ]);
      expect(
        await db
          .prepare("SELECT 1 FROM memberships WHERE person_id=?")
          .bind(uploaderId)
          .first(),
      ).toBeNull();
      const result = await new ParticipantRetentionService(
        f.testEnv,
      ).anonymiseExpiredParticipants(f.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      });
      expect(result).toMatchObject({
        complete: true,
        state: { integrityViolations: [] },
      });
      const attribution = await db
        .prepare(`SELECT person.id,person.email,version.original_filename AS filename
        FROM file_versions version JOIN people person ON person.id=version.created_by_person_id
        WHERE version.id=? AND version.event_id=?`)
        .bind(f.fileVersionId, f.eventId)
        .first<{ id: string; email: string; filename: string }>();
      expect(attribution).toMatchObject({ filename: "retained-file" });
      expect(attribution?.id).toMatch(/^retained-participant-/);
      expect(attribution?.email).not.toBe(uploader.email);
      const identity = await db
        .prepare("SELECT email FROM people WHERE id=?")
        .bind(uploaderId)
        .first<{ email: string }>();
      if (shared) expect(identity).toEqual({ email: uploader.email });
      else expect(identity?.email).not.toBe(uploader.email);
      if (shared) {
        expect(
          (await f.service.listPortal(uploader)).map(
            (company) => company.eventId,
          ),
        ).toEqual([f.otherEventId]);
      }
    },
  );

  it("preserves a participant identity needed by a sponsor contact in another event", async () => {
    const f = await fixture();
    const otherViewer = { ...f.owner, eventId: f.otherEventId };
    const otherSponsor = await f.service.save(
      otherViewer,
      { name: "Shared contact company", sessionLimit: 1, closesAt: null },
      key(),
    );
    await f.service.addContact(
      otherViewer,
      otherSponsor,
      { name: "Exclusive Person", email: f.person.email },
      key(),
    );
    await new ParticipantRetentionService(
      f.testEnv,
    ).anonymiseExpiredParticipants(f.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(
      await f.testEnv.DB.prepare("SELECT email FROM people WHERE id=?")
        .bind(f.exclusiveId)
        .first(),
    ).toEqual({ email: f.person.email });
    expect(
      (await f.service.listPortal(f.person)).map((company) => company.id),
    ).toEqual([otherSponsor]);
  });
  it("erases sponsor snapshots and contacts, preserves other events and programme sessions, and closes portal access", async () => {
    const f = await fixture();
    const db = f.testEnv.DB;
    const otherSponsorId = await f.service.save(
      { ...f.owner, eventId: f.otherEventId },
      {
        name: "Other event company",
        sessionLimit: 1,
        closesAt: null,
      },
      key(),
    );
    await f.service.addContact(
      { ...f.owner, eventId: f.otherEventId },
      otherSponsorId,
      {
        name: "Other event contact",
        email: "other@example.com",
      },
      key(),
    );
    // Include an accepted snapshot as well as a withdrawn snapshot.
    await db
      .prepare(
        "UPDATE sponsored_session_proposals SET status='accepted',session_id=? WHERE id=?",
      )
      .bind(f.sessionId, f.proposalId)
      .run();
    const withdrawn = await f.service.saveProposal(
      f.person,
      f.eventId,
      f.sponsorId,
      f.details,
      key(),
    );
    await f.service.changeProposal(
      f.person,
      f.eventId,
      f.sponsorId,
      withdrawn,
      1,
      "withdrawn",
      key(),
    );
    expect(
      (await f.service.portalWorkspace(f.person, f.eventId, f.sponsorId))
        .proposals,
    ).toHaveLength(2);
    const audits = await db
      .prepare(
        "SELECT metadata_json AS metadata FROM audit_events WHERE event_id=? AND action LIKE 'sponsor.%'",
      )
      .bind(f.eventId)
      .all<{ metadata: string }>();
    expect(audits.results.length).toBeGreaterThan(0);
    for (const audit of audits.results) {
      expect(Object.keys(JSON.parse(audit.metadata)).sort()).toEqual([
        "entityId",
        "version",
      ]);
      expect(audit.metadata).not.toContain(f.person.email);
    }
    const assets = new SponsorAssetService(f.testEnv);
    const requestId = await assets.request(
      f.owner,
      f.sponsorId,
      { name: "Private contact document", kind: "document", required: true },
      key(),
    );
    // Reuse the fixture's erased file to verify sponsor-target metadata scrubbing.
    await db
      .prepare(
        "UPDATE file_assets SET target_type='resource',target_id=? WHERE id=?",
      )
      .bind(requestId, f.fileAssetId)
      .run();
    const retention = new ParticipantRetentionService(f.testEnv);
    const result = await retention.anonymiseExpiredParticipants(f.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(result).toMatchObject({
      complete: true,
      state: { integrityViolations: [] },
    });
    await expect(
      assets.request(
        f.owner,
        f.sponsorId,
        { name: "Restored private document", kind: "document", required: true },
        key(),
      ),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO sponsor_asset_requests(id,event_id,sponsor_id,name,kind) VALUES (?,?,?,'Private document','document')",
        )
        .bind(`sponsor-asset-${key()}`, f.eventId, f.sponsorId)
        .run(),
    ).rejects.toThrow("participant retention is complete");
    await expect(
      db
        .prepare(
          "INSERT INTO file_assets(id,event_id,target_type,target_id,asset_kind,status) VALUES (?,?,'resource',?,'supporting_document','pending')",
        )
        .bind(key(), f.eventId, requestId)
        .run(),
    ).rejects.toThrow("participant retention is complete");
    expect(
      await db
        .prepare(
          "SELECT original_filename,object_key FROM file_versions WHERE asset_id=?",
        )
        .bind(f.fileAssetId)
        .first(),
    ).toMatchObject({
      original_filename: "retained-file",
      object_key: `retained/${f.fileVersionId}`,
    });
    for (const table of [
      "event_sponsorships",
      "sponsor_asset_requests",
      "sponsor_contacts",
      "sponsored_session_proposals",
    ]) {
      expect(
        await db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE event_id=?`)
          .bind(f.eventId)
          .first(),
      ).toEqual({ n: 0 });
    }
    expect(
      await db
        .prepare("SELECT id FROM sessions WHERE id=?")
        .bind(f.sessionId)
        .first(),
    ).toEqual({ id: f.sessionId });
    expect(
      (
        await f.service.adminWorkspace(
          { ...f.owner, eventId: f.otherEventId },
          otherSponsorId,
        )
      ).contacts[0].email,
    ).toBe("other@example.com");
    expect(await f.service.listPortal(f.person)).toEqual([]);
    await expect(
      f.service.portalWorkspace(f.person, f.eventId, f.sponsorId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.service.saveProposal(
        f.person,
        f.eventId,
        f.sponsorId,
        f.details,
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.service.save(
        f.owner,
        { name: "Recreated company", sessionLimit: 1, closesAt: null },
        key(),
      ),
    ).rejects.toThrow("Participant retention is complete");
    await expect(
      db
        .prepare(
          "INSERT INTO event_sponsorships (id,organisation_id,event_id,name,session_limit) VALUES (?,?,?,'Forbidden',1)",
        )
        .bind(key(), f.owner.organisationId, f.eventId)
        .run(),
    ).rejects.toThrow("participant retention is complete");
  });

  it("blocks direct inserts, updates and moving sponsor data into or out of a retention-locked event", async () => {
    const f = await fixture();
    const db = f.testEnv.DB;
    // Simulates rows left by the old implementation; guards must cover OLD and NEW scope.
    await db
      .prepare(
        "UPDATE events SET participant_retention_completed_at=unixepoch() WHERE id=?",
      )
      .bind(f.eventId)
      .run();
    const statements = [
      db
        .prepare(
          "INSERT INTO sponsor_contacts (id,sponsor_id,event_id,name,email) VALUES (?,?,?,'New person','new@example.com')",
        )
        .bind(key(), f.sponsorId, f.eventId),
      db
        .prepare(
          "INSERT INTO sponsored_session_proposals (id,sponsor_id,event_id,details_json,created_by_person_id) VALUES (?,?,?,?,?)",
        )
        .bind(
          key(),
          f.sponsorId,
          f.eventId,
          JSON.stringify(f.details),
          f.exclusiveId,
        ),
      db
        .prepare(
          "UPDATE sponsor_contacts SET name='Restored person' WHERE sponsor_id=?",
        )
        .bind(f.sponsorId),
      db
        .prepare(
          "UPDATE sponsored_session_proposals SET details_json=? WHERE id=?",
        )
        .bind(JSON.stringify(f.details), f.proposalId),
      db
        .prepare(
          "UPDATE event_sponsorships SET description='Restored biography' WHERE id=?",
        )
        .bind(f.sponsorId),
      ...[
        "event_sponsorships",
        "sponsor_contacts",
        "sponsored_session_proposals",
      ].map((table) =>
        db
          .prepare(`UPDATE ${table} SET event_id=? WHERE event_id=?`)
          .bind(f.otherEventId, f.eventId),
      ),
    ];
    for (const statement of statements)
      await expect(statement.run()).rejects.toThrow(
        "participant retention is complete",
      );
    const otherSponsor = await f.service.save(
      { ...f.owner, eventId: f.otherEventId },
      { name: "Other company", sessionLimit: 1, closesAt: null },
      key(),
    );
    await expect(
      db
        .prepare("UPDATE event_sponsorships SET event_id=? WHERE id=?")
        .bind(f.eventId, otherSponsor)
        .run(),
    ).rejects.toThrow("participant retention is complete");
    expect(await f.service.listPortal(f.person)).toEqual([]);
    await expect(
      f.service.portalWorkspace(f.person, f.eventId, f.sponsorId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await new ParticipantRetentionService(f.testEnv).preview(f.owner)
      ).integrityViolations.join(" "),
    ).toContain("sponsor profile, contact, or proposal");
  });

  it("rolls back a proposal write if retention completes after the service preflight", async () => {
    const f = await fixture();
    const db = f.testEnv.DB;
    const batch = db.batch.bind(db);
    const spy = vi
      .spyOn(db, "batch")
      .mockImplementationOnce(async (statements) => {
        await db
          .prepare(
            "UPDATE events SET participant_retention_completed_at=unixepoch() WHERE id=?",
          )
          .bind(f.eventId)
          .run();
        return batch(statements);
      });
    const nonce = key();
    try {
      await expect(
        f.service.saveProposal(
          f.person,
          f.eventId,
          f.sponsorId,
          f.details,
          nonce,
        ),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM sponsored_session_proposals WHERE event_id=?",
        )
        .bind(f.eventId)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await db
        .prepare("SELECT id FROM idempotency_records WHERE idempotency_key=?")
        .bind(nonce)
        .first(),
    ).toBeNull();
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { type SponsorPerson, SponsorStateError } from "./sponsor-schema";
import { SponsorService } from "./sponsor-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const key = () => crypto.randomUUID();
let service: SponsorService;
let person: SponsorPerson;
let sponsorId: string;
let contactId: string;
let testEnv: CloudflareEnvironment;
let queue: unknown[];
async function session(title = "Sponsored session") {
  const workspace = await service.adminWorkspace(viewer, sponsorId);
  return {
    title,
    description: "An invited industry session",
    trackId: workspace.tracks[0].id,
    format: workspace.formats[0].key,
    speakers: [
      {
        name: "Invited presenter",
        email: `presenter-${key()}@programcue.com`,
        biography: "Presenter biography",
      },
    ],
  };
}
async function accepted() {
  await service.accept(person, viewer.eventId, sponsorId, key());
}
beforeEach(async () => {
  vi.restoreAllMocks();
  queue = [];
  testEnv = {
    ...env,
    DB: env.DB,
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queue.push(message);
      },
    },
    EVENT_CHANNEL: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ accepted: true }) }),
    },
  } as unknown as CloudflareEnvironment;
  await ensureDemoSpeakerData(testEnv);
  service = new SponsorService(testEnv);
  const row = await env.DB.prepare(
    "SELECT email FROM people WHERE id='person-demo-speaker'",
  ).first<{ email: string }>();
  person = {
    personId: "person-demo-speaker",
    email: row!.email,
    restrictedOrganisationId: null,
  };
  sponsorId = await service.save(
    viewer,
    { name: `Company ${key()}`, tier: "Gold", sessionLimit: 1, closesAt: null },
    key(),
  );
  contactId = await service.addContact(
    viewer,
    sponsorId,
    { name: "Priya Shah", email: person.email },
    key(),
  );
});

describe("company-scoped sponsor workflow", () => {
  it("requires explicit acceptance and isolates companies, events, organisations and roles", async () => {
    expect(
      (await service.listPortal(person)).some((s) => s.id === sponsorId),
    ).toBe(true);
    expect(
      (await service.portalWorkspace(person, viewer.eventId, sponsorId))
        .proposals,
    ).toEqual([]);
    await expect(
      service.saveProposal(
        person,
        viewer.eventId,
        sponsorId,
        await session(),
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.portalWorkspace(
        { ...person, email: "outsider@example.com" },
        viewer.eventId,
        sponsorId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.portalWorkspace(person, "other-event", sponsorId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.portalWorkspace(
        { ...person, restrictedOrganisationId: "other-org" },
        viewer.eventId,
        sponsorId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.listAdmin({ ...viewer, organisationId: "other-org" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.listAdmin({ ...viewer, role: "speaker" }),
    ).rejects.toMatchObject({ status: 403 });
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM memberships WHERE person_id=?",
    )
      .bind(person.personId)
      .first<{ n: number }>();
    await accepted();
    expect(
      (await service.portalWorkspace(person, viewer.eventId, sponsorId))
        .ownContact.acceptedAt,
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM memberships WHERE person_id=?",
      )
        .bind(person.personId)
        .first(),
    ).toEqual(before);
  });
  it("enforces an atomic quota, idempotent draft saves and withdrawal releasing the slot", async () => {
    await accepted();
    const details = await session();
    const nonce = key();
    const result = await Promise.allSettled([
      service.saveProposal(person, viewer.eventId, sponsorId, details, nonce),
      service.saveProposal(
        person,
        viewer.eventId,
        sponsorId,
        await session("Second competing session"),
        key(),
      ),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const w = await service.adminWorkspace(viewer, sponsorId);
    expect(w.sponsor.sessionsUsed).toBe(1);
    expect(w.proposals).toHaveLength(1);
    if (result[0].status === "fulfilled") {
      expect(
        await service.saveProposal(
          person,
          viewer.eventId,
          sponsorId,
          details,
          nonce,
        ),
      ).toBe(result[0].value);
      await expect(
        service.saveProposal(
          person,
          viewer.eventId,
          sponsorId,
          { ...details, title: "Different payload" },
          nonce,
        ),
      ).rejects.toBeInstanceOf(SponsorStateError);
    }
    await service.changeProposal(
      person,
      viewer.eventId,
      sponsorId,
      w.proposals[0].id,
      1,
      "withdrawn",
      key(),
    );
    await service.saveProposal(
      person,
      viewer.eventId,
      sponsorId,
      await session("Replacement proposal"),
      key(),
    );
    expect(
      (await service.adminWorkspace(viewer, sponsorId)).sponsor.sessionsUsed,
    ).toBe(1);
  });
  it("revokes access immediately and requires acceptance again after restoration", async () => {
    await accepted();
    const w = await service.adminWorkspace(viewer, sponsorId);
    await service.revokeContact(
      viewer,
      sponsorId,
      contactId,
      w.contacts[0].revision,
      key(),
    );
    await expect(
      service.saveProfile(
        person,
        viewer.eventId,
        sponsorId,
        { name: "Attempted write" },
        1,
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await service.listPortal(person)).some((s) => s.id === sponsorId),
    ).toBe(false);
    const revoked = await service.adminWorkspace(viewer, sponsorId);
    await service.restoreContact(
      viewer,
      sponsorId,
      contactId,
      revoked.contacts[0].revision,
      key(),
    );
    await expect(
      service.saveProposal(
        person,
        viewer.eventId,
        sponsorId,
        await session(),
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("enforces deadlines, stale revisions and current event tracks server-side", async () => {
    await accepted();
    await expect(
      service.saveProposal(
        person,
        viewer.eventId,
        sponsorId,
        { ...(await session()), trackId: "foreign-track" },
        key(),
      ),
    ).rejects.toBeInstanceOf(SponsorStateError);
    const details = await session();
    const proposal = await service.saveProposal(
      person,
      viewer.eventId,
      sponsorId,
      details,
      key(),
    );
    await service.saveProposal(
      person,
      viewer.eventId,
      sponsorId,
      { ...details, title: "Edited proposal" },
      key(),
      { id: proposal, revision: 1 },
    );
    await expect(
      service.changeProposal(
        person,
        viewer.eventId,
        sponsorId,
        proposal,
        1,
        "submitted",
        key(),
      ),
    ).rejects.toBeInstanceOf(SponsorStateError);
    await env.DB.prepare(
      "UPDATE event_sponsorships SET closes_at=unixepoch()-1 WHERE id=?",
    )
      .bind(sponsorId)
      .run();
    await expect(
      service.saveProfile(
        person,
        viewer.eventId,
        sponsorId,
        { name: "Closed edit" },
        1,
        key(),
      ),
    ).rejects.toBeInstanceOf(SponsorStateError);
    await expect(
      service.changeProposal(
        person,
        viewer.eventId,
        sponsorId,
        proposal,
        2,
        "submitted",
        key(),
      ),
    ).rejects.toBeInstanceOf(SponsorStateError);
  });
  it("accepts a reviewed proposal exactly once with ordinary consent and durable invitations", async () => {
    await accepted();
    const details = await session();
    const proposal = await service.saveProposal(
      person,
      viewer.eventId,
      sponsorId,
      details,
      key(),
    );
    await expect(
      service.approve(viewer, sponsorId, proposal, 1),
    ).rejects.toBeInstanceOf(SponsorStateError);
    await service.changeProposal(
      person,
      viewer.eventId,
      sponsorId,
      proposal,
      1,
      "submitted",
      key(),
    );
    await env.DB.prepare(
      `INSERT INTO sender_profiles (id,event_id,name,from_name,from_email,reply_to_email,provider,status,created_at,updated_at) VALUES (?,?,'Sponsor test','Program Cue','speakers@example.com','speakers@example.com','resend','verified',unixepoch(),unixepoch())`,
    )
      .bind(key(), viewer.eventId)
      .run();
    service = new SponsorService({
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      BETTER_AUTH_URL: "https://programcue.test",
      RESEND_API_KEY: "test-provider-key",
    } as unknown as CloudflareEnvironment);
    const result = await service.approve(viewer, sponsorId, proposal, 2);
    const w = await service.adminWorkspace(viewer, sponsorId);
    expect(w.proposals[0]).toMatchObject({
      status: "accepted",
      sessionId: result.sessionId,
      revision: 3,
    });
    expect(w.sponsor.sessionsUsed).toBe(1);
    expect(
      await env.DB.prepare("SELECT status FROM sessions WHERE id=?")
        .bind(result.sessionId)
        .first(),
    ).toEqual({ status: "unscheduled" });
    expect(
      await env.DB.prepare(
        "SELECT participation_status AS status,participation_confirmed_at AS confirmed FROM session_speakers WHERE session_id=?",
      )
        .bind(result.sessionId)
        .first(),
    ).toEqual({ status: "pending", confirmed: null });
    expect(result.invitationDeliveries).toEqual(["queued"]);
    expect(queue).toHaveLength(1);
    await expect(
      service.approve(viewer, sponsorId, proposal, 2),
    ).rejects.toBeInstanceOf(SponsorStateError);
    await expect(
      service.saveProposal(person, viewer.eventId, sponsorId, details, key(), {
        id: proposal,
        revision: 3,
      }),
    ).rejects.toBeInstanceOf(SponsorStateError);
  });
  it("rolls back session and invitation intent if the proposal changes at the approval boundary", async () => {
    await accepted();
    const details = await session();
    const proposal = await service.saveProposal(
      person,
      viewer.eventId,
      sponsorId,
      details,
      key(),
    );
    await service.changeProposal(
      person,
      viewer.eventId,
      sponsorId,
      proposal,
      1,
      "submitted",
      key(),
    );
    const original = env.DB.batch.bind(env.DB);
    let intercepted = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!intercepted) {
        intercepted = true;
        await env.DB.prepare(
          "UPDATE sponsored_session_proposals SET revision=revision+1 WHERE id=?",
        )
          .bind(proposal)
          .run();
      }
      return original(statements);
    });
    await expect(
      service.approve(viewer, sponsorId, proposal, 2),
    ).rejects.toThrow("changed before approval");
    expect(
      await env.DB.prepare("SELECT id FROM people WHERE email=?")
        .bind(details.speakers[0].email)
        .first(),
    ).toBeNull();
    expect(queue).toHaveLength(0);
    expect(
      (await service.adminWorkspace(viewer, sponsorId)).proposals[0].sessionId,
    ).toBeNull();
  });
  it("prepares a reviewable invitation without sending email", async () => {
    const draft = await service.prepareInvitation(viewer, sponsorId, key());
    expect(draft.id).toBeTruthy();
    expect(queue).toHaveLength(0);
    const record = await env.DB.prepare(
      "SELECT audience_json AS recipients,status FROM communications WHERE id=?",
    )
      .bind(draft.id)
      .first<{ audience: string; recipients: string; status: string }>();
    expect(record).toMatchObject({ status: "draft" });
    expect(record!.recipients).toContain(person.email);
  });
});

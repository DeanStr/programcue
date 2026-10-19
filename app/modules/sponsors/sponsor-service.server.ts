import { z } from "zod";
import { CommunicationDraftService } from "~/modules/communications/communication-draft-service.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { namedRecipient } from "~/modules/communications/manual-recipients";
import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type SponsorPerson,
  SponsorStateError,
  sponsorContactSchema,
  sponsorProfileSchema,
  sponsorSessionSchema,
  sponsorshipSchema,
} from "./sponsor-schema";
import { SponsorStore } from "./sponsor-store.server";

type Sponsorship = {
  id: string;
  name: string;
  tier: string;
  description: string;
  websiteUrl: string;
  logoUrl: string;
  sessionLimit: number;
  closesAt: number | null;
  revision: number;
  status: "active" | "archived";
  invitationTemplateVersionId: string | null;
  sessionsUsed: number;
};
type Proposal = {
  id: string;
  sponsorId: string;
  detailsJson: string;
  revision: number;
  status: "draft" | "submitted" | "accepted" | "withdrawn";
  sessionId: string | null;
};

const sponsorSelect = `SELECT s.id,s.name,s.tier,s.description,s.website_url AS websiteUrl,s.logo_url AS logoUrl,
  s.session_limit AS sessionLimit,s.closes_at AS closesAt,s.revision,s.status,
  s.invitation_template_version_id AS invitationTemplateVersionId,
  (SELECT count(*) FROM sponsored_session_proposals p WHERE p.sponsor_id=s.id AND p.event_id=s.event_id AND p.status<>'withdrawn') AS sessionsUsed
  FROM event_sponsorships s`;

export class SponsorService extends SponsorStore {
  async listAdmin(viewer: Viewer) {
    await this.admin(viewer);
    return (
      await this.env.DB.prepare(
        `${sponsorSelect} WHERE s.event_id=? AND s.organisation_id=? ORDER BY s.status,s.name`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<Sponsorship>()
    ).results;
  }

  async listPortal(person: SponsorPerson) {
    return (
      await this.env.DB.prepare(`SELECT s.id,s.event_id AS eventId,s.name,s.tier,e.name AS eventName,c.accepted_at AS acceptedAt
      FROM event_sponsorships s JOIN events e ON e.id=s.event_id AND e.organisation_id=s.organisation_id
      JOIN sponsor_contacts c ON c.sponsor_id=s.id AND c.event_id=s.event_id
      WHERE lower(c.email)=lower(?) AND c.revoked_at IS NULL AND s.status='active' AND e.activation_status='active'
        AND (? IS NULL OR s.organisation_id=?) ORDER BY e.starts_at DESC,s.name`)
        .bind(
          person.email,
          person.restrictedOrganisationId,
          person.restrictedOrganisationId,
        )
        .all<{
          id: string;
          eventId: string;
          name: string;
          tier: string;
          eventName: string;
          acceptedAt: number | null;
        }>()
    ).results;
  }

  private async workspace(
    eventId: string,
    organisationId: string,
    sponsorId: string,
  ) {
    const [sponsor, contacts, proposals, event, tracks] = await Promise.all([
      this.env.DB.prepare(
        `${sponsorSelect} WHERE s.id=? AND s.event_id=? AND s.organisation_id=?`,
      )
        .bind(sponsorId, eventId, organisationId)
        .first<Sponsorship>(),
      this.env.DB.prepare(
        `SELECT id,name,email,accepted_at AS acceptedAt,revoked_at AS revokedAt,revision FROM sponsor_contacts WHERE sponsor_id=? AND event_id=? ORDER BY name,id`,
      )
        .bind(sponsorId, eventId)
        .all<{
          id: string;
          name: string;
          email: string;
          acceptedAt: number | null;
          revokedAt: number | null;
          revision: number;
        }>(),
      this.env.DB.prepare(
        `SELECT id,sponsor_id AS sponsorId,details_json AS detailsJson,revision,status,session_id AS sessionId FROM sponsored_session_proposals WHERE sponsor_id=? AND event_id=? ORDER BY created_at,id`,
      )
        .bind(sponsorId, eventId)
        .all<Proposal>(),
      this.env.DB.prepare(
        `SELECT name,timezone,session_formats_json AS formats,venue_name AS venue,city FROM events WHERE id=? AND organisation_id=?`,
      )
        .bind(eventId, organisationId)
        .first<{
          name: string;
          timezone: string;
          formats: string;
          venue: string | null;
          city: string | null;
        }>(),
      this.env.DB.prepare(
        `SELECT id,name FROM tracks WHERE event_id=? ORDER BY name,id`,
      )
        .bind(eventId)
        .all<{ id: string; name: string }>(),
    ]);
    if (!sponsor || !event)
      throw new Response("Sponsor not found", { status: 404 });
    return {
      sponsor,
      contacts: contacts.results,
      proposals: proposals.results.map((proposal) => ({
        ...proposal,
        details: sponsorSessionSchema.parse(JSON.parse(proposal.detailsJson)),
      })),
      event,
      tracks: tracks.results,
      formats: parseSessionFormatsConfiguration(event.formats),
    };
  }

  async adminWorkspace(viewer: Viewer, sponsorId: string) {
    await this.admin(viewer);
    return this.workspace(viewer.eventId, viewer.organisationId, sponsorId);
  }

  async portalWorkspace(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
  ) {
    const authority = await this.contact(person, eventId, sponsorId, true);
    const workspace = await this.workspace(
      eventId,
      authority.organisationId,
      sponsorId,
    );
    const ownContact = workspace.contacts.find(
      (contact) =>
        contact.email.toLowerCase() === person.email.toLowerCase() &&
        contact.revokedAt === null,
    );
    if (!ownContact)
      throw new Response("Sponsor access not found", { status: 404 });
    // Pending invitees can inspect the company invitation, but not shared contacts or proposals.
    return {
      ...workspace,
      ownContact,
      contacts: ownContact.acceptedAt
        ? workspace.contacts.filter((contact) => contact.revokedAt === null)
        : [],
      proposals: ownContact.acceptedAt ? workspace.proposals : [],
    };
  }

  async save(
    viewer: Viewer,
    input: unknown,
    key: string,
    existing?: { id: string; revision: number },
  ) {
    const authority = await this.admin(viewer);
    const details = sponsorshipSchema.parse(input);
    const id = existing?.id ?? crypto.randomUUID();
    const statement = existing
      ? this.env.DB.prepare(`UPDATE event_sponsorships SET name=?,tier=?,description=?,website_url=?,logo_url=?,session_limit=?,closes_at=?,revision=revision+1,updated_at=unixepoch()
          WHERE id=? AND event_id=? AND organisation_id=? AND revision=? AND status='active'
            AND ? >= (SELECT count(*) FROM sponsored_session_proposals WHERE sponsor_id=? AND status<>'withdrawn')`).bind(
          details.name,
          details.tier,
          details.description,
          details.websiteUrl,
          details.logoUrl,
          details.sessionLimit,
          details.closesAt,
          id,
          viewer.eventId,
          viewer.organisationId,
          existing.revision,
          details.sessionLimit,
          id,
        )
      : this.env.DB.prepare(`INSERT INTO event_sponsorships (id,organisation_id,event_id,name,tier,description,website_url,logo_url,session_limit,closes_at)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM event_sponsorships WHERE event_id=?) < 100`).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          details.name,
          details.tier,
          details.description,
          details.websiteUrl,
          details.logoUrl,
          details.sessionLimit,
          details.closesAt,
          viewer.eventId,
        );
    return this.commit(
      authority,
      key,
      "sponsor.saved",
      { details, existing },
      id,
      [statement],
    );
  }

  async addContact(
    viewer: Viewer,
    sponsorId: string,
    input: unknown,
    key: string,
  ) {
    const authority = await this.admin(viewer);
    const contact = sponsorContactSchema.parse(input);
    const id = crypto.randomUUID();
    return this.commit(
      authority,
      key,
      "sponsor.contact.added",
      { sponsorId, contact },
      id,
      [
        this.env.DB.prepare(`INSERT INTO sponsor_contacts (id,sponsor_id,event_id,email,name)
      SELECT ?,s.id,s.event_id,?,? FROM event_sponsorships s WHERE s.id=? AND s.event_id=? AND s.organisation_id=? AND s.status='active'
        AND (SELECT count(*) FROM sponsor_contacts WHERE sponsor_id=s.id) < 50`).bind(
          id,
          contact.email,
          contact.name,
          sponsorId,
          viewer.eventId,
          viewer.organisationId,
        ),
      ],
    );
  }

  async revokeContact(
    viewer: Viewer,
    sponsorId: string,
    contactId: string,
    revision: number,
    key: string,
  ) {
    const authority = await this.admin(viewer);
    return this.commit(
      authority,
      key,
      "sponsor.contact.revoked",
      { sponsorId, contactId, revision },
      contactId,
      [
        this.env.DB.prepare(`UPDATE sponsor_contacts SET revoked_at=unixepoch(),revision=revision+1 WHERE id=? AND sponsor_id=? AND event_id=? AND revision=? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM event_sponsorships WHERE id=? AND organisation_id=?)`).bind(
          contactId,
          sponsorId,
          viewer.eventId,
          revision,
          sponsorId,
          viewer.organisationId,
        ),
      ],
    );
  }

  async restoreContact(
    viewer: Viewer,
    sponsorId: string,
    contactId: string,
    revision: number,
    key: string,
  ) {
    const authority = await this.admin(viewer);
    return this.commit(
      authority,
      key,
      "sponsor.contact.restored",
      { sponsorId, contactId, revision },
      contactId,
      [
        this.env.DB.prepare(`UPDATE sponsor_contacts SET revoked_at=NULL,accepted_at=NULL,revision=revision+1 WHERE id=? AND sponsor_id=? AND event_id=? AND revision=? AND revoked_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM event_sponsorships WHERE id=? AND organisation_id=? AND status='active')`).bind(
          contactId,
          sponsorId,
          viewer.eventId,
          revision,
          sponsorId,
          viewer.organisationId,
        ),
      ],
    );
  }

  async accept(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    key: string,
  ) {
    const authority = await this.contact(person, eventId, sponsorId, true);
    return this.commit(
      authority,
      key,
      "sponsor.invitation.accepted",
      { sponsorId },
      sponsorId,
      [
        this.env.DB.prepare(
          `UPDATE sponsor_contacts SET accepted_at=COALESCE(accepted_at,unixepoch()),revision=revision+1 WHERE sponsor_id=? AND event_id=? AND lower(email)=lower(?) AND revoked_at IS NULL`,
        ).bind(sponsorId, eventId, person.email),
      ],
    );
  }

  async saveProfile(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    input: unknown,
    revision: number,
    key: string,
  ) {
    const authority = await this.contact(person, eventId, sponsorId);
    const profile = sponsorProfileSchema.parse(input);
    return this.commit(
      authority,
      key,
      "sponsor.profile.updated",
      { sponsorId, profile, revision },
      sponsorId,
      [
        this.env.DB.prepare(`UPDATE event_sponsorships SET name=?,description=?,website_url=?,logo_url=?,revision=revision+1,updated_at=unixepoch()
      WHERE id=? AND event_id=? AND revision=? AND status='active' AND (closes_at IS NULL OR closes_at>unixepoch())`).bind(
          profile.name,
          profile.description,
          profile.websiteUrl,
          profile.logoUrl,
          sponsorId,
          eventId,
          revision,
        ),
      ],
    );
  }

  async saveProposal(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    input: unknown,
    key: string,
    existing?: { id: string; revision: number },
  ) {
    const authority = await this.contact(person, eventId, sponsorId);
    const details = sponsorSessionSchema.parse(input);
    const workspace = await this.workspace(
      eventId,
      authority.organisationId,
      sponsorId,
    );
    if (
      !workspace.tracks.some((track) => track.id === details.trackId) ||
      !workspace.formats.some((format) => format.key === details.format)
    )
      throw new SponsorStateError(
        "Choose a current event track and session format.",
      );
    const id = existing?.id ?? crypto.randomUUID();
    const serialized = JSON.stringify(details);
    const eligible = `EXISTS (SELECT 1 FROM event_sponsorships s WHERE s.id=? AND s.event_id=? AND s.status='active' AND (s.closes_at IS NULL OR s.closes_at>unixepoch()))`;
    const statement = existing
      ? this.env.DB.prepare(`UPDATE sponsored_session_proposals SET details_json=?,revision=revision+1,updated_at=unixepoch()
        WHERE id=? AND sponsor_id=? AND event_id=? AND revision=? AND status IN ('draft','submitted') AND ${eligible}`).bind(
          serialized,
          id,
          sponsorId,
          eventId,
          existing.revision,
          sponsorId,
          eventId,
        )
      : this.env.DB.prepare(`INSERT INTO sponsored_session_proposals (id,sponsor_id,event_id,details_json,created_by_person_id)
        SELECT ?,s.id,s.event_id,?,? FROM event_sponsorships s WHERE s.id=? AND s.event_id=? AND s.status='active'
        AND (s.closes_at IS NULL OR s.closes_at>unixepoch())
        AND (SELECT count(*) FROM sponsored_session_proposals p WHERE p.sponsor_id=s.id AND p.status<>'withdrawn') < s.session_limit
        AND (SELECT count(*) FROM sponsored_session_proposals p WHERE p.sponsor_id=s.id) < 500`).bind(
          id,
          serialized,
          person.personId,
          sponsorId,
          eventId,
        );
    return this.commit(
      authority,
      key,
      "sponsor.session.saved",
      { sponsorId, details, existing },
      id,
      [statement],
    );
  }

  async changeProposal(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    proposalId: string,
    revision: number,
    status: "submitted" | "withdrawn",
    key: string,
  ) {
    const authority = await this.contact(person, eventId, sponsorId);
    return this.commit(
      authority,
      key,
      `sponsor.session.${status}`,
      { sponsorId, proposalId, revision, status },
      proposalId,
      [
        this.env.DB.prepare(`UPDATE sponsored_session_proposals SET status=?,revision=revision+1,updated_at=unixepoch()
      WHERE id=? AND sponsor_id=? AND event_id=? AND revision=? AND status IN ('draft','submitted')
      AND EXISTS (SELECT 1 FROM event_sponsorships WHERE id=? AND event_id=? AND status='active' AND (closes_at IS NULL OR closes_at>unixepoch()))`).bind(
          status,
          proposalId,
          sponsorId,
          eventId,
          revision,
          sponsorId,
          eventId,
        ),
      ],
    );
  }

  async approve(
    viewer: Viewer,
    sponsorId: string,
    proposalId: string,
    revision: number,
  ) {
    await this.admin(viewer);
    const workspace = await this.workspace(
      viewer.eventId,
      viewer.organisationId,
      sponsorId,
    );
    const proposal = workspace.proposals.find((item) => item.id === proposalId);
    if (!proposal)
      throw new Response("Sponsor session not found", { status: 404 });
    if (proposal.status === "accepted") {
      throw new SponsorStateError(
        "This proposal has already been accepted. Manage its session and invitation delivery in the organiser workspace.",
      );
    }
    if (
      proposal.status !== "submitted" ||
      proposal.revision !== revision ||
      workspace.sponsor.status !== "active"
    )
      throw new SponsorStateError(
        "The sponsor session changed. Refresh before approving.",
      );
    return new SubmissionService(this.env).createDirectSession(
      viewer,
      {
        ...proposal.details,
        idempotencyKey: `sponsor:${proposal.id}:${revision}`,
      },
      {
        id: proposal.id,
        sponsorId,
        revision,
        detailsJson: proposal.detailsJson,
      },
    );
  }

  async prepareInvitation(viewer: Viewer, sponsorId: string, draftId: string) {
    await this.admin(viewer);
    z.uuid().parse(draftId);
    const workspace = await this.workspace(
      viewer.eventId,
      viewer.organisationId,
      sponsorId,
    );
    const contacts = workspace.contacts.filter(
      (contact) => contact.revokedAt === null,
    );
    if (workspace.sponsor.status !== "active" || !contacts.length)
      throw new SponsorStateError(
        "Add an active sponsor contact before preparing an invitation.",
      );
    const url = new URL("/sponsor", this.env.BETTER_AUTH_URL);
    const address = [workspace.event.venue, workspace.event.city]
      .filter(Boolean)
      .join(", ");
    if (!address)
      throw new SponsorStateError(
        "Set the event venue or mailing address before preparing invitations.",
      );
    const service = new CommunicationService(this.env);
    let versionId = workspace.sponsor.invitationTemplateVersionId;
    if (!versionId) {
      const saved = await service.saveTemplate(viewer, {
        name: `Sponsor portal invitation · ${workspace.sponsor.name}`.slice(
          0,
          160,
        ),
        category: "ad_hoc",
        subject: "Sponsor portal access · {{event.name}}",
        content: {
          body: `Hello {{recipient.name}},\n\nYou have been invited to manage your company's sessions and profile for {{event.name}}. Sign in with this email address and accept your sponsor invitation:\n\n${url.toString()}\n\nYour sponsor portal shows your session allowance and editing deadline. Programme inclusion remains subject to organiser review.`,
          physicalAddress: address,
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      await this.env.DB.prepare(
        `UPDATE event_sponsorships SET invitation_template_version_id=? WHERE id=? AND event_id=? AND organisation_id=? AND invitation_template_version_id IS NULL`,
      )
        .bind(saved.versionId, sponsorId, viewer.eventId, viewer.organisationId)
        .run();
      versionId = (
        await this.workspace(viewer.eventId, viewer.organisationId, sponsorId)
      ).sponsor.invitationTemplateVersionId;
    }
    if (!versionId)
      throw new Error("Sponsor invitation template was not saved.");
    return new CommunicationDraftService(this.env).create(
      viewer,
      {
        templateVersionId: versionId,
        audienceType: "manual",
        manualRecipients: contacts
          .map((contact) => namedRecipient(contact.name, contact.email))
          .join("\n"),
        kind: "transactional",
        scheduledAt: null,
      },
      { draftId, idempotencyKey: `sponsor-invitation:${draftId}` },
    );
  }
}

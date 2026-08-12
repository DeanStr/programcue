import { z } from "zod";

import { CommunicationDraftService } from "~/modules/communications/communication-draft-service.server";
import { CommunicationTemplateService } from "~/modules/communications/communication-template-service.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";
import {
  contactScopeBindings,
  contactScopeCte,
} from "./crm-contact-scope.server";
import { CrmStateError } from "./crm-errors";
import { crmPersonIdSchema } from "./crm-schema";

type ContactSummary = {
  name: string;
  email: string;
  biography: string | null;
  organisationName: string | null;
  jobTitle: string | null;
};

function eventViewer(
  viewer: OrganisationAdministrator,
  eventId: string,
): Viewer {
  return {
    personId: viewer.personId,
    name: viewer.name,
    email: viewer.email,
    role: viewer.role,
    organisationId: viewer.organisationId,
    eventId,
    demo: viewer.demo,
  };
}

async function outreachOperationIds(
  organisationId: string,
  eventId: string,
  idempotencyKey: string,
) {
  const root = `crm.outreach:${organisationId}:${eventId}:${idempotencyKey}`;
  const deterministicUuid = async (label: string) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${root}:${label}`),
    );
    const bytes = new Uint8Array(digest).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const [operationId, templateId, versionId, auditId, draftId] =
    await Promise.all(
      ["operation", "template", "version", "audit", "draft"].map(
        deterministicUuid,
      ),
    );
  return {
    operationId: operationId!,
    templateId: templateId!,
    versionId: versionId!,
    auditId: auditId!,
    draftId: draftId!,
  };
}

export class CrmOutreachService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly getContact: (
      viewer: OrganisationAdministrator,
      personId: string,
    ) => Promise<ContactSummary>,
  ) {}

  async listEvents(viewer: OrganisationAdministrator) {
    const rows = await this.env.DB.prepare(
      `SELECT id, name, starts_at AS startsAt, ends_at AS endsAt
         FROM events
        WHERE organisation_id = ? AND activation_status = 'active'
        ORDER BY starts_at DESC, name COLLATE NOCASE`,
    )
      .bind(viewer.organisationId)
      .all<{ id: string; name: string; startsAt: number; endsAt: number }>();
    return rows.results;
  }

  async addContactToEvent(
    viewer: OrganisationAdministrator,
    rawPersonId: unknown,
    rawEventId: unknown,
    rawIdempotencyKey: unknown,
  ) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const targetEventId = z.string().trim().min(1).max(128).parse(rawEventId);
    const event = await this.env.DB.prepare(
      `SELECT id FROM events
        WHERE id = ? AND organisation_id = ?
          AND activation_status = 'active'`,
    )
      .bind(targetEventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Target event not found.", { status: 404 });
    const contact = await this.getContact(viewer, personId);
    const invitation = await new SpeakerService(this.env).createManualSpeaker(
      eventViewer(viewer, targetEventId),
      {
        idempotencyKey: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/)
          .parse(rawIdempotencyKey),
        name: contact.name,
        email: contact.email,
      },
    );
    return {
      eventId: targetEventId,
      personId: invitation.personId,
      accepted: invitation.accepted,
    };
  }

  async createDraft(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        personIds: z.array(crmPersonIdSchema).min(2).max(500),
        eventId: z.string().trim().min(1).max(128),
        idempotencyKey: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/),
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(100_000),
        physicalAddress: z.string().trim().min(1).max(500),
      })
      .parse(rawInput);
    const uniquePersonIds = [...new Set(input.personIds)];
    if (uniquePersonIds.length < 2) {
      throw new CrmStateError(
        "Choose at least two different contacts for speaker invitations.",
        422,
      );
    }
    const event = await this.env.DB.prepare(
      `SELECT name, venue_name AS venueName, city FROM events
        WHERE id = ? AND organisation_id = ?
          AND activation_status = 'active'`,
    )
      .bind(input.eventId, viewer.organisationId)
      .first<{ name: string; venueName: string | null; city: string | null }>();
    if (!event) throw new Response("Target event not found.", { status: 404 });
    const placeholders = uniquePersonIds.map(() => "?").join(",");
    const contacts = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id,
              COALESCE(profile.display_name, person.display_name) AS name,
              person.email
         FROM organisation_contact_ids scoped JOIN people person ON person.id = scoped.person_id
         LEFT JOIN scoped_contact_profiles profile ON profile.person_id = person.id
        WHERE person.id IN (${placeholders})
        ORDER BY COALESCE(profile.display_name, person.display_name) COLLATE NOCASE`,
    )
      .bind(...contactScopeBindings(viewer), ...uniquePersonIds)
      .all<{ id: string; name: string; email: string }>();
    if (contacts.results.length !== uniquePersonIds.length) {
      throw new CrmStateError(
        "One or more selected contacts are no longer in this organisation.",
        422,
      );
    }
    const targetViewer = eventViewer(viewer, input.eventId);
    const operation = await outreachOperationIds(
      viewer.organisationId,
      input.eventId,
      input.idempotencyKey,
    );
    const existingDraft = await this.env.DB.prepare(
      `SELECT communication.id
         FROM communications communication
         JOIN events event
           ON event.id = communication.event_id AND event.organisation_id = ?
        WHERE communication.id = ? AND communication.event_id = ?
          AND communication.idempotency_key = ?
          AND communication.status = 'draft'`,
    )
      .bind(
        viewer.organisationId,
        operation.draftId,
        input.eventId,
        `communication:draft:${operation.draftId}`,
      )
      .first<{ id: string }>();
    if (existingDraft) {
      return { eventId: input.eventId, draftId: existingDraft.id };
    }
    const templates = new CommunicationTemplateService(this.env);
    const existingVersion = await this.env.DB.prepare(
      `SELECT version.template_id AS templateId, version.id AS versionId
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND template.id = ?`,
    )
      .bind(
        viewer.organisationId,
        operation.versionId,
        input.eventId,
        operation.templateId,
      )
      .first<{ templateId: string; versionId: string }>();
    const saved =
      existingVersion ??
      (await templates.saveTemplate(
        targetViewer,
        {
          name: `Speaker invitation · ${input.subject}`.slice(0, 160),
          category: "ad_hoc",
          subject: input.subject,
          content: {
            body: input.body,
            physicalAddress: input.physicalAddress,
          },
        },
        {
          operationId: operation.operationId,
          templateId: operation.templateId,
          versionId: operation.versionId,
          auditId: operation.auditId,
        },
      ));
    await templates.publishTemplate(targetViewer, saved.versionId);
    const draft = await new CommunicationDraftService(this.env).create(
      targetViewer,
      {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: contacts.results
          .map((contact) => `${contact.name} <${contact.email}>`)
          .join("\n"),
        kind: "optional",
        scheduledAt: null,
      },
      {
        draftId: operation.draftId,
        idempotencyKey: `communication:draft:${operation.draftId}`,
      },
    );
    return { eventId: input.eventId, draftId: draft.id };
  }
}

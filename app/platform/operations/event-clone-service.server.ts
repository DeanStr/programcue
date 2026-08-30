import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  AIRTABLE_ROOMS_TABLE,
  airtableConnectionInputSchema,
} from "~/modules/airtable/airtable-schema";
import {
  emailProviderConfigurationIssue,
  requireEmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";
import { EventRepositoryProvisioningService } from "~/modules/events/event-repository-provisioning.server";
import { timezoneSchema } from "~/modules/events/event-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  buildEventClonePlan,
  cloneDate,
  cloneNameDefault,
  cloneSlugDefault,
  EventCloneConfigurationError,
  nextYearDate,
} from "./event-clone-plan.server";
import { readEventCloneSource } from "./event-clone-source.server";

const EVENT_NAME_MAX_LENGTH = 160;
const EVENT_SLUG_MAX_LENGTH = 120;

const cloneEventSchema = z
  .object({
    name: z.string().trim().min(1).max(EVENT_NAME_MAX_LENGTH),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(EVENT_SLUG_MAX_LENGTH)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    timezone: timezoneSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    repositoryProvider: z.enum(["d1", "airtable"]),
    personalAccessToken: z.string().trim().optional(),
    baseId: z.string().trim().optional(),
    tableName: z.string().trim().optional(),
    reusedSenderProfileId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endDate < value.startDate)
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot be before the start date.",
      });
    if (
      value.repositoryProvider !== "d1" &&
      value.reusedSenderProfileId !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["reusedSenderProfileId"],
        message:
          "An existing sender can only be reused when Program Cue holds the new event's data.",
      });
    if (value.repositoryProvider !== "airtable") return;
    const connection = airtableConnectionInputSchema.safeParse({
      personalAccessToken: value.personalAccessToken,
      baseId: value.baseId,
      tableName: value.tableName,
    });
    if (!connection.success)
      for (const issue of connection.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });

export class EventCloneSlugConflictError extends Error {
  constructor() {
    super("Another event already uses that public slug.");
    this.name = "EventCloneSlugConflictError";
  }
}

export { EventCloneConfigurationError } from "./event-clone-plan.server";

export type EventCloneSummary = {
  eventId: string;
  operationId: string;
  repositoryProvider: "d1" | "airtable";
  copied: {
    rooms: number;
    tracks: number;
    forms: number;
    formVersions: number;
    evaluationPlans: number;
    evaluationRounds: number;
    evaluationCriteria: number;
    taskTemplates: number;
    communicationTemplates: number;
    communicationTemplateVersions: number;
    participantFieldPolicies: number;
    fieldDefinitions: number;
    senders: number;
  };
};

export type EventCloneReusableSender = {
  id: string;
  sourceEventId: string;
  sourceEventName: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  provider: string;
  providerSenderId: string | null;
};

export type EventClonePreparation = {
  source: {
    name: string;
    slug: string;
    timezone: string;
    startsAt: number;
    endsAt: number;
  };
  defaults: {
    name: string;
    slug: string;
    timezone: string;
    startDate: string;
    endDate: string;
    airtableTableName: string;
  };
  reusableSenderProfiles: EventCloneReusableSender[];
  emailProviderIssue: string | null;
};

export class EventCloneService {
  private readonly airtable: AirtableProviderBoundary;
  private readonly provisioning: Pick<
    EventRepositoryProvisioningService,
    "provisionAirtable"
  >;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: {
      airtable?: AirtableProviderBoundary;
      provisioning?: Pick<
        EventRepositoryProvisioningService,
        "provisionAirtable"
      >;
    } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.provisioning =
      dependencies.provisioning ??
      new EventRepositoryProvisioningService(this.env);
  }

  private senderReuseChanged(
    expected: EventCloneReusableSender,
    current: EventCloneReusableSender,
  ) {
    return (
      current.sourceEventId !== expected.sourceEventId ||
      current.name !== expected.name ||
      current.fromName !== expected.fromName ||
      current.fromEmail !== expected.fromEmail ||
      current.replyToEmail !== expected.replyToEmail ||
      current.provider !== expected.provider ||
      current.providerSenderId !== expected.providerSenderId
    );
  }

  private async requireReusableSender(
    viewer: Viewer,
    profileId: string,
  ): Promise<EventCloneReusableSender> {
    const emailProviderIssue = emailProviderConfigurationIssue(this.env);
    if (emailProviderIssue) {
      throw new EventCloneConfigurationError(emailProviderIssue);
    }
    const emailProvider = requireEmailProviderConfiguration(this.env).provider;
    const profile = await this.env.DB.prepare(
      `SELECT sender.id, sender.event_id AS sourceEventId,
              event.name AS sourceEventName, sender.name,
              sender.from_name AS fromName, sender.from_email AS fromEmail,
              sender.reply_to_email AS replyToEmail, sender.provider,
              sender.provider_sender_id AS providerSenderId
         FROM sender_profiles sender
         JOIN events event ON event.id = sender.event_id
        WHERE sender.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND sender.provider = ? AND sender.status = 'verified'
          AND (sender.provider <> 'resend' OR sender.provider_sender_id IS NOT NULL)`,
    )
      .bind(profileId, viewer.organisationId, emailProvider)
      .first<EventCloneReusableSender>();
    if (!profile) {
      throw new EventCloneConfigurationError(
        "The selected verified sender is no longer available in this organisation. Refresh before cloning the event.",
      );
    }
    return profile;
  }

  private async assertOrganisationAuthority(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `SELECT 1
         FROM memberships
        WHERE organisation_id = ? AND person_id = ? AND event_id IS NULL
          AND role IN ('owner', 'administrator')
          AND accepted_at IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .first();
    if (!membership) {
      throw new Response(
        "Organisation owner or administrator access is required to create an event.",
        { status: 403 },
      );
    }
  }

  async prepare(viewer: Viewer): Promise<EventClonePreparation> {
    await this.assertOrganisationAuthority(viewer);
    await this.airtable.assertReadable(viewer);
    const source = await this.env.DB.prepare(
      `SELECT name, slug, timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventClonePreparation["source"]>();
    if (!source)
      throw new Response("This event could not be found.", { status: 404 });
    const existingSlugs = await this.env.DB.prepare(
      `SELECT slug FROM events`,
    ).all<{ slug: string }>();

    const emailProviderIssue = emailProviderConfigurationIssue(this.env);
    const emailProvider = emailProviderIssue
      ? null
      : requireEmailProviderConfiguration(this.env).provider;
    const reusableSenderProfiles = emailProvider
      ? (
          await this.env.DB.prepare(
            `SELECT sender.id, sender.event_id AS sourceEventId,
                    event.name AS sourceEventName, sender.name,
                    sender.from_name AS fromName, sender.from_email AS fromEmail,
                    sender.reply_to_email AS replyToEmail, sender.provider,
                    sender.provider_sender_id AS providerSenderId
               FROM sender_profiles sender
               JOIN events event ON event.id = sender.event_id
              WHERE event.organisation_id = ?
                AND event.activation_status = 'active'
                AND sender.provider = ? AND sender.status = 'verified'
                AND (sender.provider <> 'resend' OR sender.provider_sender_id IS NOT NULL)
              ORDER BY event.name COLLATE NOCASE, sender.name COLLATE NOCASE,
                       sender.id`,
          )
            .bind(viewer.organisationId, emailProvider)
            .all<EventCloneReusableSender>()
        ).results
      : [];

    return {
      source,
      defaults: {
        name: cloneNameDefault(source.name),
        slug: cloneSlugDefault(
          source.slug,
          existingSlugs.results.map((row) => row.slug),
        ),
        timezone: source.timezone,
        startDate: nextYearDate(cloneDate(source.startsAt)),
        endDate: nextYearDate(cloneDate(source.endsAt)),
        airtableTableName: AIRTABLE_ROOMS_TABLE,
      },
      reusableSenderProfiles,
      emailProviderIssue,
    };
  }

  async clone(viewer: Viewer, rawInput: unknown): Promise<EventCloneSummary> {
    await this.assertOrganisationAuthority(viewer);
    const input = cloneEventSchema.parse(rawInput);
    const airtableConnection =
      input.repositoryProvider === "airtable"
        ? airtableConnectionInputSchema.parse({
            personalAccessToken: input.personalAccessToken,
            baseId: input.baseId,
            tableName: input.tableName,
          })
        : null;
    const conflict = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE slug = ? LIMIT 1",
    )
      .bind(input.slug)
      .first();
    if (conflict) throw new EventCloneSlugConflictError();
    await this.airtable.assertReadable(viewer);

    const sourceData = await readEventCloneSource(this.env, viewer);
    if (!sourceData.source) {
      throw new Response("Source event not found", { status: 404 });
    }
    const pendingAirtable = airtableConnection !== null;
    const reusedSender = input.reusedSenderProfileId
      ? await this.requireReusableSender(viewer, input.reusedSenderProfileId)
      : null;
    const plan = buildEventClonePlan(
      this.env,
      viewer,
      { ...input, reusedSender },
      {
        ...sourceData,
        source: sourceData.source,
      },
    );
    try {
      await this.env.DB.batch(plan.statements);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/iu.test(error.message)
      ) {
        throw new EventCloneSlugConflictError();
      }
      if (reusedSender) {
        try {
          const current = await this.requireReusableSender(
            viewer,
            reusedSender.id,
          );
          if (this.senderReuseChanged(reusedSender, current)) {
            throw new EventCloneConfigurationError(
              "The selected verified sender changed while the event was being cloned. Refresh and confirm the sender identity again.",
            );
          }
        } catch (senderError) {
          if (senderError instanceof EventCloneConfigurationError) {
            throw senderError;
          }
        }
      }
      throw error;
    }
    if (pendingAirtable) {
      await this.provisioning.provisionAirtable(
        viewer,
        plan.eventId,
        plan.operationId,
        "event_clone",
        airtableConnection,
        plan.clonedRooms,
        { copied: plan.copied },
      );
    }
    return {
      eventId: plan.eventId,
      operationId: plan.operationId,
      copied: plan.copied,
      repositoryProvider: input.repositoryProvider,
    };
  }
}

import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  AIRTABLE_ROOMS_TABLE,
  airtableConnectionInputSchema,
} from "~/modules/airtable/airtable-schema";
import { EventRepositoryProvisioningService } from "~/modules/events/event-repository-provisioning.server";
import { timezoneSchema } from "~/modules/events/event-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  buildEventClonePlan,
  cloneDate,
  cloneNameDefault,
  cloneSlugDefault,
  nextYearDate,
} from "./event-clone-plan.server";
import { readEventCloneSource } from "./event-clone-source.server";

const EVENT_NAME_MAX_LENGTH = 160;
const EVENT_SLUG_MAX_LENGTH = 120;
const CLONE_NAME_SUFFIX = " Copy";
const CLONE_SLUG_SUFFIX = "-copy";

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
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endDate < value.startDate)
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot be before the start date.",
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
  };
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
    if (!source) throw new Response("Event not found", { status: 404 });

    return {
      source,
      defaults: {
        name: cloneNameDefault(source.name),
        slug: cloneSlugDefault(source.slug),
        timezone: source.timezone,
        startDate: nextYearDate(cloneDate(source.startsAt)),
        endDate: nextYearDate(cloneDate(source.endsAt)),
        airtableTableName: AIRTABLE_ROOMS_TABLE,
      },
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
    const plan = buildEventClonePlan(this.env, viewer, input, {
      ...sourceData,
      source: sourceData.source,
    });
    try {
      await this.env.DB.batch(plan.statements);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/iu.test(error.message)
      ) {
        throw new EventCloneSlugConflictError();
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

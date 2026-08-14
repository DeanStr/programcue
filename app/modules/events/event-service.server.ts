import {
  administratorInvitationSchema,
  administratorRevocationSchema,
  eventSetupInputSchema,
} from "./event-schema";
import { D1EventRepository } from "./event-repository.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { createAuth } from "~/platform/auth/auth.server";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import { AirtableRoomRepository } from "~/modules/airtable/airtable-room-repository.server";
import {
  AirtableEventDataRepository,
  type AirtableProjectionCommandToken,
} from "~/modules/airtable/airtable-event-data-repository.server";

export class EventNotFoundError extends Error {
  constructor() {
    super("Event not found");
    this.name = "EventNotFoundError";
  }
}

export class EventInvitationDeliveryError extends Error {
  readonly committed = true;

  constructor(
    readonly membershipId: string,
    cause: unknown,
  ) {
    super(
      `The administrator invitation was saved, but its sign-in email could not be delivered: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "EventInvitationDeliveryError";
  }
}

export class EventAdministratorPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventAdministratorPermissionError";
  }
}

export class EventInvitationAddressError extends Error {
  constructor(reason: string) {
    super(
      `The administrator invitation email address is not deliverable: ${reason.toLowerCase()}.`,
    );
    this.name = "EventInvitationAddressError";
  }
}

export class EventRepositoryMigrationRequiredError extends Error {
  constructor() {
    super(
      "Repository authority cannot be changed by saving Event Setup. Configure Airtable, inspect the migration diff, and explicitly confirm the provider migration.",
    );
    this.name = "EventRepositoryMigrationRequiredError";
  }
}

export class EventAirtableProjectionCommitError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super(
      `The Event Setup command committed only partially and Airtable is not reconciled: ${cause instanceof Error ? cause.message : String(cause)} Recover the recorded projection run before continuing.`,
    );
    this.name = "EventAirtableProjectionCommitError";
  }
}

type EventServiceDependencies = {
  airtableRooms?: AirtableRoomRepository;
  airtableEventData?: AirtableEventDataRepository;
};

export class EventService {
  private readonly repository;
  private readonly airtableRooms;
  private readonly airtableEventData;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: EventServiceDependencies = {},
  ) {
    this.repository = new D1EventRepository(env);
    this.airtableRooms =
      dependencies.airtableRooms ?? new AirtableRoomRepository(env);
    this.airtableEventData =
      dependencies.airtableEventData ??
      new AirtableEventDataRepository(env, { rooms: this.airtableRooms });
  }

  async getSetup(viewer: Viewer) {
    const event = await this.repository.getSetup(
      viewer.organisationId,
      viewer.eventId,
    );
    if (!event) throw new EventNotFoundError();
    event.repositoryConnection = await this.airtableRooms.getConnectionSummary(
      viewer.organisationId,
      viewer.eventId,
    );
    if (event.repositoryProvider === "airtable") {
      const [eventData, snapshot] = await Promise.all([
        this.airtableEventData.assertSynchronized(
          viewer.organisationId,
          viewer.eventId,
        ),
        this.airtableRooms.readRooms(viewer.organisationId, viewer.eventId),
      ]);
      event.rooms = snapshot.rooms
        .filter((room) => room.status === "active")
        .map(({ id, name, capacity, resources, position }) => ({
          id,
          name,
          capacity,
          resources,
          position,
        }));
      event.repositoryFreshness = {
        source: "airtable",
        scope: "event_data",
        fetchedAt: Math.min(
          snapshot.fetchedAt,
          eventData.airtable.freshness.fetchedAt,
        ),
        cacheExpiresAt: Math.min(
          snapshot.cacheExpiresAt,
          eventData.airtable.freshness.cacheExpiresAt ??
            snapshot.cacheExpiresAt,
        ),
        cached: snapshot.cached && eventData.airtable.freshness.cached,
      };
    }
    return event;
  }

  async saveSetup(viewer: Viewer, input: unknown) {
    const parsed = eventSetupInputSchema.parse(input);
    const current = await this.repository.getSetup(
      viewer.organisationId,
      viewer.eventId,
    );
    if (!current) throw new EventNotFoundError();
    if (current.repositoryProvider !== parsed.repositoryProvider)
      throw new EventRepositoryMigrationRequiredError();
    await this.repository.validateSetup(
      viewer.organisationId,
      viewer.eventId,
      parsed,
    );
    let projectionToken: AirtableProjectionCommandToken | null = null;
    if (current.repositoryProvider === "airtable") {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(parsed)),
      );
      const inputHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      projectionToken = await this.airtableEventData.beginCommand(viewer, {
        idempotencyKey: `event-setup:${viewer.eventId}:${viewer.personId}:${parsed.revision}:${inputHash}`,
        operation: "event_setup.save",
        requestHash: inputHash,
      });
    }
    try {
      await this.repository.saveSetup(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed,
      );
    } catch (error) {
      if (current.repositoryProvider !== "airtable") throw error;
      if (projectionToken)
        await this.airtableEventData.abortCommand(projectionToken, error);
      throw error;
    }
    if (projectionToken) {
      try {
        await this.airtableRooms.replaceRooms(
          viewer.organisationId,
          viewer.eventId,
          parsed.rooms,
          parsed.revision + 1,
        );
      } catch (error) {
        await this.airtableEventData.failCommandResult(projectionToken, error);
      }
      try {
        await this.airtableEventData.completeCommand(projectionToken);
      } catch (error) {
        throw new EventAirtableProjectionCommitError(error);
      }
    }
  }

  async inviteAdministrator(
    viewer: Viewer,
    input: unknown,
    command?: {
      operationId: string;
      personId: string;
      membershipId: string;
      auditId: string;
    },
  ) {
    const parsed = administratorInvitationSchema.parse(input);
    if (parsed.scope === "organisation" && viewer.role !== "owner")
      throw new EventAdministratorPermissionError(
        "Only an organisation owner can invite an organisation administrator.",
      );
    const deliveryIssue = emailDeliveryIssue(parsed.email, this.env.APP_ENV);
    if (deliveryIssue) throw new EventInvitationAddressError(deliveryIssue);
    const invitation = await this.repository.inviteAdministrator(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed,
      command,
    );
    const runtime = requireRuntimeMode(this.env);
    if (
      runtime.appEnvironment === "demo" ||
      runtime.appEnvironment === "test"
    ) {
      return {
        ...invitation,
        scope: parsed.scope,
        delivery: "demo_not_sent" as const,
      };
    }
    try {
      await createAuth(this.env).api.signInMagicLink({
        body: {
          email: parsed.email,
          callbackURL: "/events/select?returnTo=%2Fadmin%2Fevent",
        },
        headers: new Headers({ origin: this.env.BETTER_AUTH_URL }),
      });
    } catch (error) {
      throw new EventInvitationDeliveryError(invitation.membershipId, error);
    }
    return { ...invitation, scope: parsed.scope, delivery: "sent" as const };
  }

  async revokeAdministrator(
    viewer: Viewer,
    input: unknown,
    command?: { operationId: string; auditId: string },
  ) {
    if (viewer.role !== "owner")
      throw new EventAdministratorPermissionError(
        "Only an organisation owner can revoke an administrator.",
      );
    const parsed = administratorRevocationSchema.parse(input);
    return this.repository.revokeAdministrator(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.membershipId,
      command,
    );
  }
}

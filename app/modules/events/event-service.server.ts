import { administratorInvitationSchema, eventSetupInputSchema } from "./event-schema";
import { D1EventRepository } from "./event-repository.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { createAuth } from "~/platform/auth/auth.server";

export class EventNotFoundError extends Error {
  constructor() {
    super("Event not found");
    this.name = "EventNotFoundError";
  }
}

export class EventInvitationDeliveryError extends Error {
  readonly committed = true;

  constructor(readonly membershipId: string, cause: unknown) {
    super(`The administrator invitation was saved, but its sign-in email could not be delivered: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "EventInvitationDeliveryError";
  }
}

export class EventService {
  private readonly repository;

  constructor(private readonly env: CloudflareEnvironment) {
    this.repository = new D1EventRepository(env);
  }

  async getSetup(viewer: Viewer) {
    const event = await this.repository.getSetup(viewer.organisationId, viewer.eventId);
    if (!event) throw new EventNotFoundError();
    return event;
  }

  async saveSetup(viewer: Viewer, input: unknown) {
    const parsed = eventSetupInputSchema.parse(input);
    await this.repository.saveSetup(viewer.organisationId, viewer.eventId, viewer.personId, parsed);
  }

  async inviteAdministrator(viewer: Viewer, input: unknown) {
    const parsed = administratorInvitationSchema.parse(input);
    const invitation = await this.repository.inviteAdministrator(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed,
    );
    if (String(this.env.DEMO_MODE) === "true") {
      return { ...invitation, delivery: "demo_not_sent" as const };
    }
    try {
      await createAuth(this.env).api.signInMagicLink({
        body: { email: parsed.email, callbackURL: "/admin/event" },
        headers: new Headers({ origin: this.env.BETTER_AUTH_URL }),
      });
    } catch (error) {
      throw new EventInvitationDeliveryError(invitation.membershipId, error);
    }
    return { ...invitation, delivery: "sent" as const };
  }
}

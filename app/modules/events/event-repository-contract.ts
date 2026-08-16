import type { EventFilePolicy } from "~/modules/files/file-policy";
import type {
  AdministratorInvitationInput,
  EventSetupInput,
} from "./event-schema";

export type EventAdministrator = {
  id: string;
  name: string;
  email: string;
  scope: "event" | "organisation";
  status: "Active" | "Invited" | "Expired";
};

export type EventSetup = {
  id: string;
  organisationId: string;
  organisationName: string;
  name: string;
  timezone: string;
  startDate: string;
  endDate: string;
  venue: string;
  venueAddress: string;
  venueMapUrl: string;
  city: string;
  publicSlug: string;
  brandAccent: string;
  programmeHeroImageUrl: string;
  participantLogoUrl: string;
  participantWelcomeText: string;
  participantSupportUrl: string;
  description: string;
  repositoryProvider: "d1" | "airtable";
  repositoryLockedAt: number | null;
  repositoryConnection: {
    id: string;
    status: string;
    baseId: string;
    tableId: string;
    tableName: string;
    hasCredentials: boolean;
    updatedAt: number;
    authoritativeEntities: readonly [
      "rooms",
      "event_configuration",
      "forms",
      "submissions",
      "evaluations",
      "sessions",
      "tasks",
      "published_programme",
    ];
  } | null;
  repositoryFreshness: {
    source: "d1" | "airtable";
    scope: "rooms" | "event_data";
    fetchedAt: number;
    cacheExpiresAt: number | null;
    cached: boolean;
  };
  retentionMonths: 12 | 24 | 36;
  submissionAccessMode:
    | "email_verified"
    | "account_required"
    | "password_protected";
  allowAnonymousDrafts: boolean;
  duplicatePersonWarnings: boolean;
  filePolicy: EventFilePolicy;
  programmePublished: boolean;
  revision: number;
  sessionFormats: EventSetupInput["sessionFormats"];
  rooms: Array<{
    id: string;
    name: string;
    capacity: number;
    resources: string[];
    position: number;
  }>;
  tracks: EventSetupInput["tracks"];
  administrators: EventAdministrator[];
};

export class EventRevisionConflictError extends Error {
  constructor() {
    super(
      "This event changed after the page loaded. Refresh and review the latest values before saving.",
    );
    this.name = "EventRevisionConflictError";
  }
}

export class EventSlugConflictError extends Error {
  constructor() {
    super("That public event slug is already in use. Choose a different slug.");
    this.name = "EventSlugConflictError";
  }
}

export class EventRoomInUseError extends Error {
  constructor() {
    super("Move scheduled sessions before removing a room.");
    this.name = "EventRoomInUseError";
  }
}

export class EventRoomOwnershipError extends Error {
  constructor() {
    super("A room identifier belongs to another event. Refresh before saving.");
    this.name = "EventRoomOwnershipError";
  }
}

export class EventTrackInUseError extends Error {
  constructor() {
    super(
      "A track used by a published form, submission or session cannot be removed. Keep it configured and create a replacement track if needed.",
    );
    this.name = "EventTrackInUseError";
  }
}

export class EventTrackOwnershipError extends Error {
  constructor() {
    super(
      "A track identifier belongs to another event. Refresh before saving.",
    );
    this.name = "EventTrackOwnershipError";
  }
}

export class EventSessionFormatInUseError extends Error {
  constructor() {
    super("Reassign sessions before removing one of their configured formats.");
    this.name = "EventSessionFormatInUseError";
  }
}

export class EventResourceConfigurationError extends Error {
  constructor() {
    super(
      "Every required session resource must remain configured in its assigned room and in at least one active room.",
    );
    this.name = "EventResourceConfigurationError";
  }
}

export class EventConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConfigurationError";
  }
}

export class EventPublishedScheduleConflictError extends Error {
  constructor() {
    super(
      "Event dates, timezone, or room capacity cannot be changed in a way that invalidates the published schedule. Create a replacement schedule before changing this boundary.",
    );
    this.name = "EventPublishedScheduleConflictError";
  }
}

export class EventPublishedPublicUrlError extends Error {
  constructor() {
    super(
      "The public slug is locked after public-site or programme publication so existing public, page, social-card, embed, API and calendar URLs remain valid.",
    );
    this.name = "EventPublishedPublicUrlError";
  }
}

export class EventAdministratorAlreadyActiveError extends Error {
  constructor(scope: "event" | "organisation") {
    super(
      scope === "organisation"
        ? "That person already administers this organisation."
        : "That person already administers this event through an event or organisation role.",
    );
    this.name = "EventAdministratorAlreadyActiveError";
  }
}

export class EventAdministratorNotFoundError extends Error {
  constructor() {
    super("The administrator membership is no longer active in this scope.");
    this.name = "EventAdministratorNotFoundError";
  }
}

export interface EventRepository {
  getSetup(organisationId: string, eventId: string): Promise<EventSetup | null>;
  saveSetup(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: EventSetupInput,
  ): Promise<{ changeSequence: number }>;
  inviteAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: AdministratorInvitationInput,
    command?: {
      operationId: string;
      personId: string;
      membershipId: string;
      auditId: string;
    },
  ): Promise<{ membershipId: string }>;
  revokeAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    membershipId: string,
    command?: { operationId: string; auditId: string },
  ): Promise<{ membershipId: string; scope: "event" | "organisation" }>;
}

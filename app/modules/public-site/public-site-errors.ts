export class PublicSiteNotFoundError extends Error {
  constructor(message = "The public event site was not found in this event.") {
    super(message);
    this.name = "PublicSiteNotFoundError";
  }
}

export class PublicSiteRevisionConflictError extends Error {
  constructor() {
    super(
      "The public site changed after this page loaded. Refresh and review the latest draft before continuing.",
    );
    this.name = "PublicSiteRevisionConflictError";
  }
}

export class PublicSiteCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSiteCommandConflictError";
  }
}

export class PublicSiteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSiteValidationError";
  }
}

export class PublicSiteIntegrityError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The public-site action could not record its complete state and evidence.",
      options,
    );
    this.name = "PublicSiteIntegrityError";
  }
}

export class PublishedPublicSiteInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedPublicSiteInvariantError";
  }
}

export const PUBLIC_SITE_D1_PROGRAMME_AUTHORITY_REQUIRED =
  "Featured programme content and recordings are unavailable for this event's programme source.";

export const PUBLIC_SITE_SESSION_ELIGIBILITY_CONSTRAINT =
  "Withdraw public-site references and recordings before changing this published session eligibility";

export const PUBLIC_SITE_SPEAKER_PROFILE_CONSTRAINT =
  "Remove this featured speaker from published event sites before unpublishing their profile";

export const PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT =
  "Remove this featured speaker from published event sites before hiding, unconfirming, or removing their final public confirmed session relationship";

export function isPublicSiteDatabaseConstraint(
  error: unknown,
  constraint: string,
) {
  return error instanceof Error && error.message.includes(constraint);
}

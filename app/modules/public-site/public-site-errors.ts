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

export class PublishedPublicSiteInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedPublicSiteInvariantError";
  }
}

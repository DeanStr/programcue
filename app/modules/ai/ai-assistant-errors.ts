export class AiPermissionError extends Error {
  constructor(message = "You do not have permission to use this AI action.") {
    super(message);
    this.name = "AiPermissionError";
  }
}

export class AiContextTooLargeError extends Error {
  constructor() {
    super(
      "The authorised evidence is too large for this AI action. Narrow the requested record set before trying again.",
    );
    this.name = "AiContextTooLargeError";
  }
}

export class AiProposalNotFoundError extends Error {
  constructor() {
    super("The assistant proposal was not found in your current event.");
    this.name = "AiProposalNotFoundError";
  }
}

export class AiProposalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProposalStateError";
  }
}

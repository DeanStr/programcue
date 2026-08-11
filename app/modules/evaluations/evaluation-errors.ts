export class EvaluationRevisionConflictError extends Error {
  constructor(
    message = "This review changed after it was loaded. Refresh before saving again.",
  ) {
    super(message);
    this.name = "EvaluationRevisionConflictError";
  }
}

export class EvaluationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationStateError";
  }
}

export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

export class EvaluationInvitationDeliveryError extends Error {
  readonly committed = true;

  constructor(
    readonly membershipId: string,
    roleLabel: string,
    cause: unknown,
  ) {
    super(
      `The ${roleLabel} invitation was saved, but its sign-in email could not be delivered: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "EvaluationInvitationDeliveryError";
  }
}

export class EvaluationDecisionFinalError extends Error {
  constructor() {
    super(
      "This submission already has a released decision. Released decisions are final until an explicit reopen workflow is implemented.",
    );
    this.name = "EvaluationDecisionFinalError";
  }
}

export class EvaluationDecisionAuthorityError extends Error {
  constructor() {
    super(
      "Only an owner or administrator can release decisions unless the evaluation plan explicitly grants that authority to committee chairs.",
    );
    this.name = "EvaluationDecisionAuthorityError";
  }
}

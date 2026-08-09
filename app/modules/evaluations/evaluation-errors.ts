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
      "Only an administrator can release decisions unless the evaluation plan explicitly grants that authority to committee chairs.",
    );
    this.name = "EvaluationDecisionAuthorityError";
  }
}

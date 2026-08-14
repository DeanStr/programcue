export class AiReviewAssessmentConflictError extends Error {
  constructor(
    message = "This AI assessment changed after it was loaded. Refresh before saving the override.",
  ) {
    super(message);
    this.name = "AiReviewAssessmentConflictError";
  }
}

export class AiReviewAssessmentIntentConflictError extends AiReviewAssessmentConflictError {
  constructor() {
    super(
      "This AI-assessment intent is already bound to another request. Refresh before generating an assessment.",
    );
    this.name = "AiReviewAssessmentIntentConflictError";
  }
}

export class AiReviewAssessmentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiReviewAssessmentStateError";
  }
}

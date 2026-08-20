export class ReviewerAiSuggestionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerAiSuggestionStateError";
  }
}

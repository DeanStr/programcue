import type { CommunicationCategory } from "./communication-schema";

/**
 * Wording a new event starts with for the two emails every call for
 * proposals sends. Each event gets its own published copy, so the organiser
 * edits it like any other template. One decision template covers every
 * outcome; `{{decision.outcome}}` renders accepted, waitlisted or rejected.
 * The decision starter leaves out `{{decision.rationale}}`: organisers record
 * internal reasoning there, and nothing should send it unless they choose to.
 */
export const STARTER_TEMPLATES = [
  {
    category: "submission_confirmation",
    name: "Submission confirmation",
    subject: "We received {{submission.title}}",
    body: "Hi {{recipient.firstName}},\n\nThank you for submitting {{submission.title}} to {{event.name}}. The programme team reviews every proposal and will email you when a decision is made.",
  },
  {
    category: "decision",
    name: "Proposal decision",
    subject: "Decision on {{submission.title}} for {{event.name}}",
    body: "Hi {{recipient.firstName}},\n\nThank you for proposing {{submission.title}} for {{event.name}}. The programme team has completed its review, and your proposal has been {{decision.outcome}}.\n\n{{decision.feedback}}\n\nThank you for the time and care you put into your proposal.",
  },
] as const satisfies ReadonlyArray<{
  category: CommunicationCategory;
  name: string;
  subject: string;
  body: string;
}>;

/** True while a version still carries the starter wording for its category,
 *  so the organiser can tell text they have not reviewed. */
export function isStarterWording(template: {
  category: CommunicationCategory;
  subject: string;
  body: string;
}) {
  return STARTER_TEMPLATES.some(
    (starter) =>
      starter.category === template.category &&
      starter.subject === template.subject &&
      starter.body === template.body,
  );
}

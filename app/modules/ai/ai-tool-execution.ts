import type { AiEvidence, AiProposalPreview } from "./ai-types";

export class AiToolPermissionError extends Error {
  constructor(
    message = "This assistant tool is not authorised for your role.",
  ) {
    super(message);
    this.name = "AiToolPermissionError";
  }
}

export class AiToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiToolValidationError";
  }
}

export type AiToolExecution = {
  output: unknown;
  evidence: AiEvidence[];
  proposals: AiProposalPreview[];
  auditSummary: Record<string, unknown>;
};

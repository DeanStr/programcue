import {
  CommunicationNotFoundError,
  CommunicationStateError,
} from "~/modules/communications/communication-service-shared";
import {
  AiProposalNotFoundError,
  AiProposalStateError,
} from "./ai-assistant-errors";
import { AiToolValidationError } from "./ai-tool-execution";
import { AiProviderError } from "./openai-responses-provider.server";

export type SafeAiErrorMetadata = {
  errorType: string;
  message: string;
  status?: number | null;
  providerRequestId?: string | null;
};

export function safeAiErrorMetadata(error: unknown): SafeAiErrorMetadata {
  if (error instanceof Response) {
    return {
      errorType: "Response",
      status: error.status,
      message:
        error.statusText.trim() ||
        `The request was rejected with HTTP status ${error.status}.`,
    };
  }
  if (error instanceof AiProviderError) {
    return {
      errorType: error.name,
      status: error.status,
      providerRequestId: error.providerRequestId,
      message: error.message.slice(0, 500),
    };
  }
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500),
  };
}

export function isExpectedAiOperationCancellation(error: unknown) {
  return (
    (error instanceof Response && error.status >= 400 && error.status < 500) ||
    error instanceof AiProposalNotFoundError ||
    error instanceof AiProposalStateError ||
    error instanceof AiToolValidationError ||
    error instanceof CommunicationNotFoundError ||
    error instanceof CommunicationStateError
  );
}

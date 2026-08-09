import { ZodError } from "zod";

import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { ResendReconciliationService } from "./resend-reconciliation-service.server";

export {
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationStateError,
} from "./communication-service-shared";
export type {
  CommunicationPreview,
  CommunicationTemplateVersion,
} from "./communication-service-shared";

/** Stable facade over template, delivery, and provider-reconciliation workflows. */
export class CommunicationService {
  private readonly templates: CommunicationTemplateService;
  private readonly delivery: CommunicationDeliveryService;
  private readonly reconciliation: ResendReconciliationService;

  constructor(env: CloudflareEnvironment) {
    this.templates = new CommunicationTemplateService(env);
    this.delivery = new CommunicationDeliveryService(env);
    this.reconciliation = new ResendReconciliationService(env);
  }

  listCentre(...args: Parameters<CommunicationTemplateService["listCentre"]>) {
    return this.templates.listCentre(...args);
  }

  saveTemplate(
    ...args: Parameters<CommunicationTemplateService["saveTemplate"]>
  ) {
    return this.templates.saveTemplate(...args);
  }

  publishTemplate(
    ...args: Parameters<CommunicationTemplateService["publishTemplate"]>
  ) {
    return this.templates.publishTemplate(...args);
  }

  preview(...args: Parameters<CommunicationDeliveryService["preview"]>) {
    return this.delivery.preview(...args);
  }

  confirm(...args: Parameters<CommunicationDeliveryService["confirm"]>) {
    return this.delivery.confirm(...args);
  }

  cancel(...args: Parameters<CommunicationDeliveryService["cancel"]>) {
    return this.delivery.cancel(...args);
  }

  reconcileResendEvent(
    ...args: Parameters<ResendReconciliationService["reconcileResendEvent"]>
  ) {
    return this.reconciliation.reconcileResendEvent(...args);
  }
}
export function communicationErrorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Communication input is invalid.";
  return error instanceof Error
    ? error.message
    : "Communication operation failed.";
}

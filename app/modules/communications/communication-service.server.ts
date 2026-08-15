import { ZodError } from "zod";

import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { ResendReconciliationService } from "./resend-reconciliation-service.server";
import { SenderProfileService } from "./sender-profile-service.server";
import { CommunicationAutomationService } from "./communication-automation-service.server";
import { CommunicationDraftService } from "./communication-draft-service.server";

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
  private readonly senders: SenderProfileService;
  private readonly automation: CommunicationAutomationService;
  private readonly drafts: CommunicationDraftService;

  constructor(env: CloudflareEnvironment) {
    this.templates = new CommunicationTemplateService(env);
    this.delivery = new CommunicationDeliveryService(env);
    this.reconciliation = new ResendReconciliationService(env);
    this.senders = new SenderProfileService(env);
    this.automation = new CommunicationAutomationService(env);
    this.drafts = new CommunicationDraftService(env);
  }

  listCentre(...args: Parameters<CommunicationTemplateService["listCentre"]>) {
    return this.templates.listCentre(...args);
  }
  listDeliveryHealth(
    ...args: Parameters<CommunicationTemplateService["listDeliveryHealth"]>
  ) {
    return this.templates.listDeliveryHealth(...args);
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

  schedule(...args: Parameters<CommunicationDeliveryService["schedule"]>) {
    return this.delivery.schedule(...args);
  }

  createDraft(...args: Parameters<CommunicationDraftService["create"]>) {
    return this.drafts.create(...args);
  }

  getDraft(...args: Parameters<CommunicationDraftService["get"]>) {
    return this.drafts.get(...args);
  }

  updateDraft(...args: Parameters<CommunicationDraftService["update"]>) {
    return this.drafts.update(...args);
  }

  previewDraft(...args: Parameters<CommunicationDraftService["preview"]>) {
    return this.drafts.preview(...args);
  }

  confirmDraft(...args: Parameters<CommunicationDraftService["confirm"]>) {
    return this.drafts.confirm(...args);
  }

  discardDraft(...args: Parameters<CommunicationDraftService["discard"]>) {
    return this.drafts.discard(...args);
  }

  testSend(...args: Parameters<CommunicationDeliveryService["testSend"]>) {
    return this.delivery.testSend(...args);
  }

  cancel(...args: Parameters<CommunicationDeliveryService["cancel"]>) {
    return this.delivery.cancel(...args);
  }

  reconcileResendEvent(
    ...args: Parameters<ResendReconciliationService["reconcileResendEvent"]>
  ) {
    return this.reconciliation.reconcileResendEvent(...args);
  }

  listSenderProfiles(...args: Parameters<SenderProfileService["list"]>) {
    return this.senders.list(...args);
  }

  saveSenderProfile(...args: Parameters<SenderProfileService["save"]>) {
    return this.senders.save(...args);
  }

  provisionSenderProfile(
    ...args: Parameters<SenderProfileService["provision"]>
  ) {
    return this.senders.provision(...args);
  }

  setSenderProfileEnabled(
    ...args: Parameters<SenderProfileService["setEnabled"]>
  ) {
    return this.senders.setEnabled(...args);
  }

  listTriggers(
    ...args: Parameters<CommunicationAutomationService["listTriggers"]>
  ) {
    return this.automation.listTriggers(...args);
  }

  saveTrigger(
    ...args: Parameters<CommunicationAutomationService["saveTrigger"]>
  ) {
    return this.automation.saveTrigger(...args);
  }

  setTriggerEnabled(
    ...args: Parameters<CommunicationAutomationService["setTriggerEnabled"]>
  ) {
    return this.automation.setTriggerEnabled(...args);
  }
}
export function communicationErrorMessage(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Communication input is invalid.";
  return error instanceof Error
    ? error.message
    : "Communication operation failed.";
}

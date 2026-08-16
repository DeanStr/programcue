import type { Viewer } from "~/platform/auth/authorize.server";
import {
  CommunicationDeliveryFoundation,
  representativeSourceSnapshot,
} from "./communication-delivery-foundation.server";
import {
  previewCommunicationSchema,
  type PreviewCommunicationInput,
} from "./communication-schema";
import {
  assertMergeAudienceCompatible,
  CommunicationStateError,
  eventEmailLogoUrl,
  mergeValues,
  recipientFingerprint,
  snapshotSourceValues,
  sourceVariables,
  type CommunicationPreview,
} from "./communication-service-shared";
import { emailProviderConfigurationIssue } from "./email-provider.server";
import { renderProgramCueEmail } from "./email-templates/render-email.server";
import {
  renderMergeTemplate,
  type representativeMergeValues,
} from "./merge-template";

export abstract class CommunicationDeliveryPreview extends CommunicationDeliveryFoundation {
  async preview(
    viewer: Viewer,
    input: PreviewCommunicationInput,
  ): Promise<CommunicationPreview> {
    const parsed = previewCommunicationSchema.parse(input);
    return this.previewParsed(viewer, parsed, false);
  }

  protected async previewParsed(
    viewer: Viewer,
    parsed: PreviewCommunicationInput,
    representativeTest: boolean,
  ): Promise<CommunicationPreview> {
    if (!representativeTest && parsed.audienceType !== "manual")
      await this.airtable.assertReadable(viewer);
    const [template, event, sender] = await Promise.all([
      this.templates.getTemplateVersion(viewer, parsed.templateVersionId),
      this.getEvent(viewer),
      this.getVerifiedSender(viewer),
    ]);
    if (!representativeTest)
      assertMergeAudienceCompatible(template, parsed.audienceType);
    const recipients = await this.recipients.preview(viewer, {
      audienceType: parsed.audienceType,
      manualRecipients: parsed.manualRecipients,
      category: template.category,
      kind: parsed.kind,
    });
    const requiredSourceVariables = sourceVariables(template);
    const representativeSources = representativeSourceSnapshot(
      requiredSourceVariables,
    );
    const allValidRecipients = [
      ...recipients.deliverable,
      ...recipients.suppressed,
    ];
    if (
      !representativeTest &&
      requiredSourceVariables.length &&
      recipients.deliverable.some((recipient) => !recipient.sourceId)
    ) {
      throw new CommunicationStateError(
        "The selected audience contains a recipient without the source record required by this template.",
      );
    }
    const sourceSnapshots = representativeTest
      ? new Map<string, typeof representativeMergeValues>()
      : await snapshotSourceValues(
          this.env,
          viewer.eventId,
          requiredSourceVariables,
          allValidRecipients,
        );
    const representativeRecipient = recipients.deliverable[0];
    const values = {
      ...mergeValues(event, representativeRecipient),
      ...(representativeTest ? representativeSources : {}),
      ...(representativeRecipient?.sourceId
        ? sourceSnapshots.get(representativeRecipient.sourceId)
        : {}),
    };
    const subject = renderMergeTemplate(template.subject, values);
    const body = renderMergeTemplate(template.content.body, values);
    const rendered = await renderProgramCueEmail({
      preview: subject,
      heading: subject,
      body,
      eventName: event.eventName,
      accent: event.brandAccent,
      logoUrl: eventEmailLogoUrl(this.env, event),
      physicalAddress: template.content.physicalAddress,
      buttonText: template.content.buttonText,
      buttonUrl: template.content.buttonUrl,
    });
    const contentAuthority = {
      schemaVersion: 1,
      template: {
        id: template.id,
        subject: template.subject,
        content: template.content,
      },
      event,
      sender,
      sources: allValidRecipients
        .map((recipient) => ({
          address: recipient.address,
          personId: recipient.personId,
          sourceId: recipient.sourceId,
          values: recipient.sourceId
            ? (sourceSnapshots.get(recipient.sourceId) ?? {})
            : {},
        }))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right), "en"),
        ),
      invalid: recipients.invalid
        .map((recipient) => ({
          address: recipient.address,
          name: recipient.name,
          reason: recipient.reason,
        }))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right), "en"),
        ),
    };
    const confirmation = {
      recipientFingerprint: await recipientFingerprint(
        [...recipients.deliverable, ...recipients.suppressed],
        contentAuthority,
      ),
      deliverableFingerprint: await recipientFingerprint(
        recipients.deliverable,
      ),
      suppressedCount: recipients.suppressed.length,
    };
    return {
      template,
      recipients,
      confirmation,
      rendered: { subject, ...rendered },
      mergeSnapshot: {
        event,
        sourceValues: Object.fromEntries(sourceSnapshots),
      },
      provider: {
        configured: Boolean(
          !emailProviderConfigurationIssue(this.env) && sender,
        ),
        sender: sender ? `${sender.fromName} <${sender.fromEmail}>` : null,
        senderProfile: sender,
        queueConfigured: Boolean(this.env.OPERATIONS_QUEUE),
      },
    };
  }
}

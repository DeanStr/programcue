import type { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { decryptWebhookSecret } from "~/platform/operations/webhook-crypto.server";
import { ApiError, apiRequestHash } from "./api.server";
import type {
  apiAdministrationCommandSchema,
  apiAdministrationFamilySchema,
} from "./api-command-contract";
import { ApiPersonIdempotencyService } from "./api-person-idempotency.server";

export type Family = z.infer<typeof apiAdministrationFamilySchema>;
export type Command = z.infer<typeof apiAdministrationCommandSchema>;

type FormResult = {
  formId: string;
  revision: number;
  draftVersionId: string;
  draftRevision: number;
  publishedVersionId: string | null;
  status: string;
};

type ResourceResult = {
  pageId: string;
  revision: number;
  status: string;
  versionId: string;
  versionNumber: number;
};

export type StoredWebhookSecret = {
  endpointId: string;
  secretFingerprint: string;
};

export function assertNew(itemId: string) {
  if (itemId !== "new") {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "This create command requires the literal item identifier 'new'",
    );
  }
}

export function assertMatch(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new ApiError(
      422,
      "PATH_BODY_MISMATCH",
      `${label} in the request body must match the URL identifier`,
    );
  }
}

export abstract class ApiAdministrationCommandExecutor {
  protected readonly idempotency: ApiPersonIdempotencyService;

  constructor(protected readonly env: CloudflareEnvironment) {
    this.idempotency = new ApiPersonIdempotencyService(env);
  }

  protected async restoreCurrentWebhookSecret(
    viewer: Viewer,
    stored: StoredWebhookSecret,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT secret_ciphertext AS secretCiphertext
         FROM webhook_endpoints
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(stored.endpointId, viewer.eventId, viewer.organisationId)
      .first<{ secretCiphertext: string }>();
    if (
      !row ||
      (await apiRequestHash(row.secretCiphertext)) !== stored.secretFingerprint
    ) {
      throw new ApiError(
        409,
        "WEBHOOK_SECRET_SUPERSEDED",
        "This command's webhook secret has since been rotated and can no longer be replayed",
      );
    }
    return {
      endpointId: stored.endpointId,
      secret: await decryptWebhookSecret(
        row.secretCiphertext,
        stored.endpointId,
        this.env.WEBHOOK_CREDENTIALS_KEY,
      ),
      secretCiphertext: row.secretCiphertext,
    };
  }

  protected async formResult(
    viewer: Viewer,
    formId: string,
    operationId?: string,
  ): Promise<FormResult | null> {
    return this.env.DB.prepare(
      `SELECT form.id AS formId, form.revision, form.status,
              draft.id AS draftVersionId, draft.revision AS draftRevision,
              published.id AS publishedVersionId
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
         JOIN form_versions draft
           ON draft.form_id = form.id AND draft.event_id = form.event_id
          AND draft.status = 'draft'
         LEFT JOIN form_versions published
           ON published.form_id = form.id
          AND published.event_id = form.event_id
          AND published.status = 'published'
        WHERE form.id = ? AND form.event_id = ?
          ${operationId ? "AND form.last_operation_id = ?" : ""}
        ORDER BY draft.version_number DESC LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        formId,
        viewer.eventId,
        ...(operationId ? [operationId] : []),
      )
      .first<FormResult>();
  }

  protected async resourceResult(
    viewer: Viewer,
    pageId: string,
    operationId?: string,
  ): Promise<ResourceResult | null> {
    return this.env.DB.prepare(
      `SELECT page.id AS pageId, page.revision, page.status,
              version.id AS versionId, version.version_number AS versionNumber
         FROM resource_pages page
         JOIN events event
           ON event.id = page.event_id AND event.organisation_id = ?
         JOIN resource_page_versions version
           ON version.resource_page_id = page.id
          AND version.event_id = page.event_id
          AND version.status = CASE
                WHEN page.status = 'published' THEN 'published' ELSE 'draft' END
        WHERE page.id = ? AND page.event_id = ?
          ${operationId ? "AND page.last_operation_id = ?" : ""}
        ORDER BY version.version_number DESC LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        pageId,
        viewer.eventId,
        ...(operationId ? [operationId] : []),
      )
      .first<ResourceResult>();
  }

  protected async decisionResult(viewer: Viewer, commandId: string) {
    return this.env.DB.prepare(
      `SELECT decision.id AS decisionId, decision.status,
              decision.decision, decision.submission_id AS submissionId,
              session.id AS sessionId,
              operation.id AS notificationOperationId,
              operation.status AS notificationStatus
         FROM submission_decisions decision
         JOIN submissions submission
           ON submission.id = decision.submission_id
          AND submission.event_id = decision.event_id
         JOIN events event
           ON event.id = decision.event_id AND event.organisation_id = ?
         LEFT JOIN sessions session
           ON session.source_submission_id = decision.submission_id
          AND session.event_id = decision.event_id
         LEFT JOIN operation_jobs operation
           ON operation.id = decision.notification_operation_id
          AND operation.event_id = decision.event_id
          AND operation.type = 'decision.notification'
        WHERE decision.id = ? AND decision.event_id = ?`,
    )
      .bind(viewer.organisationId, commandId, viewer.eventId)
      .first<{
        decisionId: string;
        status: string;
        decision: string;
        submissionId: string;
        sessionId: string | null;
        notificationOperationId: string | null;
        notificationStatus: string | null;
      }>();
  }
}

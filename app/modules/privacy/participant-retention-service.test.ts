import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import {
  ParticipantRetentionAccessError,
  ParticipantRetentionConfirmationError,
  ParticipantRetentionService,
  ParticipantRetentionStateError,
} from "./participant-retention-service.server";

const organisationId = "org-future-events";

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function seedExpiredRetentionEvent() {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const eventId = id("privacy-event");
  const otherEventId = id("privacy-other-event");
  const exclusiveId = id("privacy-exclusive");
  const sharedId = id("privacy-shared");
  const formId = id("privacy-form");
  const exclusiveSubmissionId = id("privacy-submission-exclusive");
  const sharedSubmissionId = id("privacy-submission-shared");
  const sessionId = id("privacy-session");
  const scheduleVersionId = id("privacy-schedule-version");
  const operationalTaskId = id("privacy-operational-task");
  const operationalTaskCommentId = id("privacy-operational-comment");
  const operationalTaskEvidenceId = id("privacy-operational-evidence");
  const communicationId = id("privacy-communication");
  const deliveryId = id("privacy-delivery");
  const invitationId = id("privacy-invitation");
  const senderProfileId = id("privacy-sender");
  const templateId = id("privacy-template");
  const templateVersionId = id("privacy-template-version");
  const resourceId = id("privacy-resource");
  const resourceVersionId = id("privacy-resource-version");
  const fileAssetId = id("privacy-file");
  const fileVersionId = id("privacy-file-version");
  const providerUploadId = id("private-provider-upload");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, image_url, biography,
         pronunciation, organisation_name, job_title, profile_status
       ) VALUES (?, ?, 'Exclusive Person', 1, 'https://images.invalid/exclusive',
                 'Private biography', 'Private pronunciation', 'Private Org',
                 'Private role', 'published')`,
    ).bind(exclusiveId, `${exclusiveId}@example.com`),
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, biography, profile_status
       ) VALUES (?, ?, 'Shared Person', 1, 'Shared biography', 'published')`,
    ).bind(sharedId, `${sharedId}@example.com`),
    testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         retention_months, file_policy_json
       ) VALUES (?, ?, 'Expired privacy event', ?, 'UTC',
                 unixepoch('2020-01-01T00:00:00Z'),
                 unixepoch('2020-01-02T00:00:00Z'), 12, ?)`,
    ).bind(
      eventId,
      organisationId,
      id("privacy-slug"),
      CANONICAL_EVENT_FILE_POLICY_JSON,
    ),
    testEnv.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         retention_months, file_policy_json
       ) VALUES (?, ?, 'Other participant event', ?, 'UTC',
                 unixepoch('2021-01-01T00:00:00Z'),
                 unixepoch('2021-01-02T00:00:00Z'), 12, ?)`,
    ).bind(
      otherEventId,
      organisationId,
      id("privacy-other-slug"),
      CANONICAL_EVENT_FILE_POLICY_JSON,
    ),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at
       ) VALUES (?, ?, ?, ?, 'submitter', unixepoch())`,
    ).bind(id("membership-exclusive"), organisationId, eventId, exclusiveId),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
    ).bind(id("membership-shared"), organisationId, eventId, sharedId),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
    ).bind(
      id("membership-shared-other"),
      organisationId,
      otherEventId,
      sharedId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO form_definitions (
         id, event_id, name, kind, status, public_slug, created_by_person_id
       ) VALUES (?, ?, 'Expired form', 'submission', 'archived', ?, ?)`,
    ).bind(formId, eventId, id("privacy-public-form"), "person-demo-owner"),
    testEnv.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, submitter_person_id, submitter_email, public_reference,
         title, status, answers_json, submitted_snapshot_json, submitted_at
       ) VALUES (?, ?, ?, ?, ?, 'Retained programme fact', 'submitted', ?, ?, unixepoch())`,
    ).bind(
      exclusiveSubmissionId,
      eventId,
      exclusiveId,
      `${exclusiveId}@example.com`,
      id("PRIVACY-EXCLUSIVE"),
      JSON.stringify({ biography: "Private biography", phone: "+1 555" }),
      JSON.stringify({ email: `${exclusiveId}@example.com` }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, submitter_person_id, submitter_email, public_reference,
         title, status, answers_json, submitted_snapshot_json, submitted_at
       ) VALUES (?, ?, ?, ?, ?, 'Shared programme fact', 'submitted', ?, ?, unixepoch())`,
    ).bind(
      sharedSubmissionId,
      eventId,
      sharedId,
      `${sharedId}@example.com`,
      id("PRIVACY-SHARED"),
      JSON.stringify({ name: "Shared Person" }),
      JSON.stringify({ email: `${sharedId}@example.com` }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO submission_speakers (
         id, event_id, submission_id, person_id, email, display_name,
         position, invitation_status, is_primary, claim_token_hash
       ) VALUES (?, ?, ?, ?, ?, 'Exclusive Person', 0, 'claimed', 1, ?)`,
    ).bind(
      id("privacy-speaker"),
      eventId,
      exclusiveSubmissionId,
      exclusiveId,
      `${exclusiveId}@example.com`,
      id("private-claim"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, source_submission_id, title, slug, description,
         format, duration_minutes, status, visibility
       ) VALUES (?, ?, ?, 'Retained programme fact', ?, 'Private speaker description',
                 'presentation', 30, 'published', 'public')`,
    ).bind(
      sessionId,
      eventId,
      exclusiveSubmissionId,
      id("privacy-session-slug"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO schedule_versions (
         id, event_id, version_number, status, revision, created_at
       ) VALUES (?, ?, 1, 'draft', 1, unixepoch())`,
    ).bind(scheduleVersionId, eventId),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label, visibility
       ) VALUES (?, ?, ?, 0, 'Presenter', 'public')`,
    ).bind(sessionId, eventId, exclusiveId),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label, visibility
       ) VALUES (?, ?, 'person-demo-owner', 1, 'Host', 'public')`,
    ).bind(sessionId, eventId),
    testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         description, task_type, impact, status, readiness_state,
         readiness_percent
       ) VALUES (?, ?, 'event', ?, 'person-demo-owner', 'Operational task',
                 'Retained staff instruction', 'administrator_only', 'low',
                 'completed', 'on_track', 100)`,
    ).bind(operationalTaskId, eventId, eventId),
    testEnv.DB.prepare(
      `INSERT INTO task_comments (
         id, event_id, task_id, author_person_id, body, visibility
       ) VALUES (?, ?, ?, 'person-demo-owner', 'Retained staff note',
                 'administrator')`,
    ).bind(operationalTaskCommentId, eventId, operationalTaskId),
    testEnv.DB.prepare(
      `INSERT INTO task_evidence (
         id, event_id, task_id, submitted_by_person_id, evidence_json, status
       ) VALUES (?, ?, ?, 'person-demo-owner', '{"operational":true}',
                 'approved')`,
    ).bind(operationalTaskEvidenceId, eventId, operationalTaskId),
    testEnv.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status
       ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'deleted')`,
    ).bind(fileAssetId, eventId, exclusiveId, exclusiveId),
    testEnv.DB.prepare(
      `INSERT INTO file_versions (
         id, event_id, asset_id, version_number, object_key,
         multipart_upload_id, original_filename, declared_content_type,
         detected_content_type, size_bytes, checksum_sha256, object_etag,
         upload_status, signature_status, scan_status, scan_provider,
         scan_result_json, scan_error, created_by_person_id, deleted_at
       ) VALUES (?, ?, ?, 1, ?, ?, 'exclusive-person.png',
                 'image/png', 'image/png', 1234, 'private-checksum',
                 'private-etag', 'aborted', 'valid', 'failed', 'private-scanner',
                 ?, 'Private scan error', ?, unixepoch())`,
    ).bind(
      fileVersionId,
      eventId,
      fileAssetId,
      `private/events/${eventId}/exclusive-person.png`,
      providerUploadId,
      JSON.stringify({ filename: "exclusive-person.png" }),
      exclusiveId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO file_multipart_uploads (
         version_id, event_id, asset_id, upload_id, idempotency_key, status,
         part_size_bytes, manifest_json, manifest_hash, expires_at, last_error
       ) VALUES (?, ?, ?, ?, ?, 'aborted', 5242880,
                 ?, 'private-manifest-hash', unixepoch() + 3600,
                 'Private upload error')`,
    ).bind(
      fileVersionId,
      eventId,
      fileAssetId,
      providerUploadId,
      id("privacy-file-upload-key"),
      JSON.stringify({ private: "participant metadata" }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, ?, ?, 'person-demo-owner', 'file.erasure.completed',
                 'file_asset', ?, '{}')`,
    ).bind(
      `file-erasure-complete:${fileAssetId}`,
      organisationId,
      eventId,
      fileAssetId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO resource_pages (
         id, event_id, title, slug, category, status, audience_scope,
         acknowledgement_required, created_by_person_id
       ) VALUES (?, ?, 'Exclusive Person instructions', ?, 'Private category',
                 'published', 'accepted_speakers', 1, 'person-demo-owner')`,
    ).bind(resourceId, eventId, id("privacy-resource-slug")),
    testEnv.DB.prepare(
      `INSERT INTO resource_page_versions (
         id, event_id, resource_page_id, version_number, title, slug, category,
         audience_scope, acknowledgement_required, document_json,
         rendered_html, status, created_by_person_id, published_at
       ) VALUES (?, ?, ?, 1, 'Exclusive Person instructions', ?, 'Private category',
                 'accepted_speakers', 1, ?, '<p>Private participant content</p>',
                 'published', 'person-demo-owner', unixepoch())`,
    ).bind(
      resourceVersionId,
      eventId,
      resourceId,
      id("privacy-resource-version-slug"),
      JSON.stringify({ text: "Private participant content" }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO resource_acknowledgements (
         id, event_id, resource_page_id, resource_page_version_id, person_id,
         user_agent
       ) VALUES (?, ?, ?, ?, ?, 'Private browser fingerprint')`,
    ).bind(
      id("privacy-resource-ack"),
      eventId,
      resourceId,
      resourceVersionId,
      exclusiveId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, provider_sender_id, status
       ) VALUES (?, ?, 'Private sender', 'Exclusive Person', ?, ?,
                 'resend', 'private-provider-sender', 'verified')`,
    ).bind(
      senderProfileId,
      eventId,
      `${exclusiveId}@example.com`,
      `${sharedId}@example.com`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id
       ) VALUES (?, ?, 'Exclusive Person message', 'ad_hoc', 'active',
                 'person-demo-owner')`,
    ).bind(templateId, eventId),
    testEnv.DB.prepare(
      `INSERT INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, published_at
       ) VALUES (?, ?, ?, 1, 'Exclusive Person message', 'ad_hoc', 'email',
                 'Hello Exclusive Person', ?, '<p>Private template</p>',
                 'published', 'person-demo-owner', unixepoch())`,
    ).bind(
      templateVersionId,
      eventId,
      templateId,
      JSON.stringify({ text: "Private template content" }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO communication_triggers (
         id, event_id, template_id, trigger_type, configuration_json, enabled
       ) VALUES (?, ?, ?, 'manual', ?, 1)`,
    ).bind(
      id("privacy-trigger"),
      eventId,
      templateId,
      JSON.stringify({ recipient: `${exclusiveId}@example.com` }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO communications (
         id, event_id, template_version_id, sender_profile_id, idempotency_key,
         kind, channel, status, audience_json, content_snapshot_json,
         recipient_count, sent_at
       ) VALUES (?, ?, ?, ?, ?, 'transactional', 'email', 'sent', ?, ?, 1,
                 unixepoch())`,
    ).bind(
      communicationId,
      eventId,
      templateVersionId,
      senderProfileId,
      id("privacy-communication-key"),
      JSON.stringify({ email: `${exclusiveId}@example.com` }),
      JSON.stringify({ html: "Hello Exclusive Person" }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO communication_deliveries (
         id, event_id, communication_id, person_id, recipient_address,
         recipient_name, source_values_json, channel, provider,
         provider_message_id, idempotency_key, status
       ) VALUES (?, ?, ?, ?, ?, 'Exclusive Person', ?, 'email', 'resend', ?, ?, 'delivered')`,
    ).bind(
      deliveryId,
      eventId,
      communicationId,
      exclusiveId,
      `${exclusiveId}@example.com`,
      JSON.stringify({ name: "Exclusive Person" }),
      id("provider-message"),
      id("privacy-delivery-key"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO calendar_invitations (
         id, event_id, session_id, person_id, ical_uid, sequence_number,
         method, provider_event_id, status, last_payload_hash
       ) VALUES (?, ?, ?, ?, ?, 1, 'CANCEL', ?, 'cancelled', ?)`,
    ).bind(
      invitationId,
      eventId,
      sessionId,
      exclusiveId,
      id("private-ical"),
      id("private-provider-event"),
      id("private-payload-hash"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO calendar_sync_attempts (
         id, invitation_id, sequence_number, method, provider, status,
         provider_event_id, error_message
       ) VALUES (?, ?, 1, 'CANCEL', 'google', 'succeeded', ?, 'Private provider error')`,
    ).bind(
      id("privacy-calendar-attempt"),
      invitationId,
      id("private-event-id"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO auth_sessions (
         id, person_id, token, expires_at, ip_address, user_agent
       ) VALUES (?, ?, ?, unixepoch() + 3600, '192.0.2.4', 'Private browser')`,
    ).bind(id("privacy-auth-session"), exclusiveId, id("private-auth-token")),
    testEnv.DB.prepare(
      `INSERT INTO auth_accounts (
         id, person_id, provider_id, account_id, access_token, refresh_token
       ) VALUES (?, ?, 'google', ?, 'private-access-token', 'private-refresh-token')`,
    ).bind(id("privacy-auth-account"), exclusiveId, id("private-account")),
    testEnv.DB.prepare(
      `INSERT INTO verification_tokens (id, identifier, value, expires_at)
       VALUES (?, ?, ?, unixepoch() + 3600)`,
    ).bind(
      id("privacy-application-session"),
      `application-session:${formId}:fingerprint:${exclusiveId}`,
      id("private-session-token"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, ?, ?, ?, 'submission.created', 'submission', ?, ?)`,
    ).bind(
      id("privacy-audit-exclusive"),
      organisationId,
      eventId,
      exclusiveId,
      exclusiveSubmissionId,
      JSON.stringify({ email: `${exclusiveId}@example.com` }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, ?, ?, ?, 'submission.created', 'submission', ?, ?)`,
    ).bind(
      id("privacy-audit-shared"),
      organisationId,
      eventId,
      sharedId,
      sharedSubmissionId,
      JSON.stringify({ email: `${sharedId}@example.com` }),
    ),
  ]);
  const owner: Viewer = {
    personId: "person-demo-owner",
    name: "Morgan Chen",
    email: "morgan.owner@example.com",
    role: "owner",
    organisationId,
    eventId,
    demo: true,
  };
  return {
    testEnv,
    owner,
    eventId,
    otherEventId,
    exclusiveId,
    sharedId,
    formId,
    exclusiveSubmissionId,
    sharedSubmissionId,
    communicationId,
    deliveryId,
    invitationId,
    senderProfileId,
    templateVersionId,
    resourceId,
    resourceVersionId,
    fileAssetId,
    fileVersionId,
    operationalTaskId,
    operationalTaskCommentId,
    operationalTaskEvidenceId,
    sessionId,
    scheduleVersionId,
  };
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("participant retention", () => {
  it("anonymises event-scoped PII, revokes exclusive credentials, and preserves shared identities plus immutable audit", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    const preview = await service.preview(seeded.owner);
    expect(preview).toMatchObject({
      name: "Expired privacy event",
      canRun: true,
      pendingParticipants: 3,
      completed: false,
      immutableAuditRecords: 3,
      retainedProgrammeRecords: 1,
      externalProviderErasureRequired: true,
    });

    const result = await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(result).toMatchObject({ complete: true, duplicate: false });
    expect(result.state).toMatchObject({
      completed: true,
      pendingParticipants: 0,
      anonymisedParticipants: 3,
      sharedIdentities: 2,
      sharedIdentityAuditLinks: 2,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT participant_retention_completed_at AS completedAt
           FROM events WHERE id = ?`,
      )
        .bind(seeded.eventId)
        .first(),
    ).toMatchObject({ completedAt: expect.any(Number) });

    const submissions = await seeded.testEnv.DB.prepare(
      `SELECT id, submitter_person_id AS personId, submitter_email AS email,
              answers_json AS answersJson, submitted_snapshot_json AS snapshotJson,
              title
         FROM submissions WHERE event_id = ? ORDER BY id`,
    )
      .bind(seeded.eventId)
      .all<{
        id: string;
        personId: string;
        email: string | null;
        answersJson: string;
        snapshotJson: string;
        title: string;
      }>();
    expect(submissions.results).toHaveLength(2);
    for (const submission of submissions.results) {
      expect(submission.personId).toMatch(/^retained-participant-/);
      expect(submission.email).toBeNull();
      expect(JSON.parse(submission.answersJson)).toEqual({
        redacted: true,
        reason: "event_retention_period_elapsed",
      });
      expect(JSON.parse(submission.snapshotJson)).toEqual({
        redacted: true,
        reason: "event_retention_period_elapsed",
      });
      expect(submission.title).toBe("Retained submission");
    }

    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT email, display_name AS name, biography FROM people WHERE id = ?",
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toMatchObject({
      name: "Anonymised participant",
      biography: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT email, display_name AS name, biography FROM people WHERE id = ?",
      )
        .bind(seeded.sharedId)
        .first(),
    ).toEqual({
      email: `${seeded.sharedId}@example.com`,
      name: "Shared Person",
      biography: "Shared biography",
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT person.email, membership.revoked_at AS revokedAt
           FROM people person
           JOIN memberships membership ON membership.person_id = person.id
          WHERE person.id = 'person-demo-owner' AND membership.role = 'owner'`,
      ).first(),
    ).toEqual({ email: "morgan.owner@example.com", revokedAt: null });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM session_speakers
          WHERE event_id = ? AND person_id = 'person-demo-owner'`,
      )
        .bind(seeded.eventId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT session.description AS sessionDescription,
                content.description AS snapshotDescription
           FROM sessions session
           JOIN schedule_session_contents content
             ON content.session_id = session.id
            AND content.event_id = session.event_id
          WHERE session.id = ? AND content.schedule_version_id = ?`,
      )
        .bind(seeded.sessionId, seeded.scheduleVersionId)
        .first(),
    ).toEqual({ sessionDescription: null, snapshotDescription: null });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT task.owner_person_id AS ownerPersonId, task.description,
                comment.author_person_id AS authorPersonId, comment.body,
                evidence.submitted_by_person_id AS submittedByPersonId,
                evidence.evidence_json AS evidenceJson
           FROM task_instances task
           JOIN task_comments comment ON comment.task_id = task.id
           JOIN task_evidence evidence ON evidence.task_id = task.id
          WHERE task.id = ? AND comment.id = ? AND evidence.id = ?`,
      )
        .bind(
          seeded.operationalTaskId,
          seeded.operationalTaskCommentId,
          seeded.operationalTaskEvidenceId,
        )
        .first(),
    ).toEqual({
      ownerPersonId: "person-demo-owner",
      description: "Retained staff instruction",
      authorPersonId: "person-demo-owner",
      body: "Retained staff note",
      submittedByPersonId: "person-demo-owner",
      evidenceJson: '{"operational":true}',
    });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM auth_sessions WHERE person_id = ?",
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM auth_accounts WHERE person_id = ?",
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM verification_tokens WHERE identifier LIKE ?",
      )
        .bind(`application-session:${seeded.formId}:%`)
        .first(),
    ).toEqual({ total: 0 });

    const delivery = await seeded.testEnv.DB.prepare(
      `SELECT recipient_address AS address, recipient_name AS name,
              provider, provider_message_id AS providerMessageId,
              source_values_json AS sourceValuesJson
         FROM communication_deliveries WHERE id = ?`,
    )
      .bind(seeded.deliveryId)
      .first();
    expect(delivery).toMatchObject({
      name: null,
      provider: null,
      providerMessageId: null,
    });
    expect(String((delivery as { address: string }).address)).toContain(
      "@privacy.invalid",
    );
    expect(
      JSON.parse((delivery as { sourceValuesJson: string }).sourceValuesJson),
    ).toMatchObject({ redacted: true });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT status, from_name AS fromName, from_email AS fromEmail,
                reply_to_email AS replyTo, provider_sender_id AS providerSenderId
           FROM sender_profiles WHERE id = ?`,
      )
        .bind(seeded.senderProfileId)
        .first(),
    ).toMatchObject({
      status: "disabled",
      fromName: "Retained sender",
      replyTo: null,
      providerSenderId: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT content_json AS contentJson, rendered_preview_html AS previewHtml
           FROM communication_template_versions WHERE id = ?`,
      )
        .bind(seeded.templateVersionId)
        .first(),
    ).toMatchObject({ previewHtml: null });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT page.status, page.title, version.document_json AS documentJson,
                version.rendered_html AS renderedHtml
           FROM resource_pages page
           JOIN resource_page_versions version
             ON version.resource_page_id = page.id
          WHERE page.id = ? AND version.id = ?`,
      )
        .bind(seeded.resourceId, seeded.resourceVersionId)
        .first(),
    ).toMatchObject({
      status: "archived",
      title: "Retained resource",
      renderedHtml: "<p>Content removed under the event retention policy.</p>",
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT original_filename AS filename, object_key AS objectKey,
                checksum_sha256 AS checksum, object_etag AS etag,
                scan_provider AS scanProvider, scan_result_json AS scanResult,
                scan_error AS scanError
           FROM file_versions WHERE id = ?`,
      )
        .bind(seeded.fileVersionId)
        .first(),
    ).toEqual({
      filename: "retained-file",
      objectKey: `retained/${seeded.fileVersionId}`,
      checksum: null,
      etag: null,
      scanProvider: null,
      scanResult: null,
      scanError: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT provider_event_id AS providerEventId, last_payload_hash AS payloadHash,
                connection_id AS connectionId, status
           FROM calendar_invitations WHERE id = ?`,
      )
        .bind(seeded.invitationId)
        .first(),
    ).toEqual({
      providerEventId: null,
      payloadHash: null,
      connectionId: null,
      status: "cancelled",
    });

    const immutableAudit = await seeded.testEnv.DB.prepare(
      `SELECT actor_person_id AS actorPersonId, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND action = 'submission.created'
        ORDER BY actor_person_id`,
    )
      .bind(seeded.eventId)
      .all<{ actorPersonId: string; metadataJson: string }>();
    expect(immutableAudit.results.map((row) => row.actorPersonId)).toEqual([
      seeded.exclusiveId,
      seeded.sharedId,
    ]);
    expect(
      immutableAudit.results.every((row) =>
        row.metadataJson.includes("@example.com"),
      ),
    ).toBe(true);

    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).resolves.toMatchObject({ complete: true, duplicate: true });
  });

  it("redacts immutable session evaluation snapshots before completing retention", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const planId = id("privacy-evaluation-plan");
    const roundId = id("privacy-evaluation-round");
    const assignmentId = id("privacy-session-assignment");
    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, created_by_person_id
         ) VALUES (?, ?, 'Retained session review', 'archived',
                   'person-demo-owner')`,
      ).bind(planId, seeded.eventId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status
         ) VALUES (?, ?, ?, 1, 'Retained session review', 'archived')`,
      ).bind(roundId, seeded.eventId, planId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status
         ) VALUES (?, ?, ?, ?, ?, 'person-demo-owner', 'submitted')`,
      ).bind(
        assignmentId,
        seeded.eventId,
        roundId,
        seeded.sessionId,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: seeded.sessionId,
          title: "Retained programme fact",
          description: "Private speaker description",
          speakers: [{ name: "Exclusive Person", roleLabel: "Presenter" }],
        }),
      ),
    ]);

    const service = new ParticipantRetentionService(seeded.testEnv);
    const result = await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(result).toMatchObject({
      complete: true,
      state: { integrityViolations: [] },
    });

    const assignment = await seeded.testEnv.DB.prepare(
      `SELECT session_snapshot_json AS snapshotJson
         FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
    )
      .bind(assignmentId, seeded.eventId)
      .first<{ snapshotJson: string }>();
    expect(JSON.parse(assignment!.snapshotJson)).toEqual({
      redacted: true,
      reason: "event_retention_period_elapsed",
    });
  });

  it("rejects participant PII writes after the durable completion tombstone", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    const retained = await seeded.testEnv.DB.prepare(
      `SELECT submitter_person_id AS personId
         FROM submissions WHERE id = ?`,
    )
      .bind(seeded.exclusiveSubmissionId)
      .first<{ personId: string }>();
    expect(retained?.personId).toMatch(/^retained-participant-/);
    const lockMessage =
      "event participant retention is complete; participant PII is read-only";

    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE submissions SET submitter_email = 'restored@example.com'
          WHERE id = ?`,
      )
        .bind(seeded.exclusiveSubmissionId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, 'person-demo-owner', 'speaker', unixepoch())`,
      )
        .bind(id("post-retention-membership"), organisationId, seeded.eventId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE people SET display_name = 'Restored participant'
          WHERE id = ?`,
      )
        .bind(retained!.personId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at
         ) VALUES (?, ?, 'private-token', unixepoch() + 3600)`,
      )
        .bind(
          id("post-retention-token"),
          `application-session:${seeded.formId}:restored@example.com`,
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address, channel,
           idempotency_key
         ) VALUES (?, ?, ?, 'restored@example.com', 'email', ?)`,
      )
        .bind(
          id("post-retention-delivery"),
          seeded.eventId,
          seeded.communicationId,
          id("post-retention-delivery-key"),
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'pending')`,
      )
        .bind(
          id("post-retention-file"),
          seeded.eventId,
          retained!.personId,
          retained!.personId,
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE schedule_session_contents
            SET description = 'Restored private speaker description'
          WHERE schedule_version_id = ? AND session_id = ?`,
      )
        .bind(seeded.scheduleVersionId, seeded.sessionId)
        .run(),
    ).rejects.toThrow(lockMessage);

    const operationalWebhookId = id("post-retention-webhook");
    await expect(
      seeded.testEnv.DB.batch([
        seeded.testEnv.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json
           ) VALUES (?, ?, ?, 'person-demo-owner', 'retention.follow_up',
                     'event', ?, '{}')`,
        ).bind(
          id("post-retention-audit"),
          organisationId,
          seeded.eventId,
          seeded.eventId,
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json
           ) VALUES (?, ?, ?, 'person-demo-owner', 'retention_follow_up',
                     ?, ?, 'completed', '{"maintenance":true}')`,
        ).bind(
          id("post-retention-operation"),
          organisationId,
          seeded.eventId,
          id("post-retention-operation-key"),
          id("post-retention-correlation"),
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id
           ) VALUES (?, 'event', ?, 'updated', ?)`,
        ).bind(
          seeded.eventId,
          seeded.eventId,
          id("post-retention-event-change"),
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO webhook_endpoints (
             id, organisation_id, event_id, name, url, secret_ciphertext,
             event_types_json, status
           ) VALUES (?, ?, ?, 'Operational retention webhook',
                     'https://operations.invalid/hook', 'encrypted-secret',
                     '["retention.follow_up"]', 'active')`,
        ).bind(operationalWebhookId, organisationId, seeded.eventId),
        seeded.testEnv.DB.prepare(
          `INSERT INTO webhook_deliveries (
             id, endpoint_id, event_type, entity_type, entity_id,
             idempotency_key, request_hash, payload_json, status
           ) VALUES (?, ?, 'retention.follow_up', 'event', ?, ?,
                     '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                     '{"maintenance":true}', 'delivered')`,
        ).bind(
          id("post-retention-webhook-delivery"),
          operationalWebhookId,
          seeded.eventId,
          id("post-retention-webhook-key"),
        ),
        seeded.testEnv.DB.prepare(
          `UPDATE communication_deliveries SET status = 'delivered'
            WHERE id = ?`,
        ).bind(seeded.deliveryId),
        seeded.testEnv.DB.prepare(
          `UPDATE sessions SET title = 'Corrected retained programme fact'
            WHERE event_id = ?`,
        ).bind(seeded.eventId),
      ]),
    ).resolves.toBeDefined();
    await expect(service.preview(seeded.owner)).resolves.toMatchObject({
      completed: true,
      integrityViolations: [],
    });
  });

  it("fails a rerun when the completion tombstone and immutable audit disagree", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await seeded.testEnv.DB.prepare(
      `UPDATE events SET participant_retention_completed_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(seeded.eventId)
      .run();

    const preview = await service.preview(seeded.owner);
    expect(preview.completed).toBe(true);
    expect(preview.integrityViolations).toContain(
      "The completion tombstone exists without its immutable completion audit.",
    );
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("integrity check failed");

    const auditOnly = await seedExpiredRetentionEvent();
    const auditOnlyService = new ParticipantRetentionService(auditOnly.testEnv);
    await auditOnly.testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action, entity_type,
         entity_id, metadata_json
       ) VALUES (?, ?, ?, 'person-demo-owner',
                 'participant.retention.completed', 'event', ?, ?)`,
    )
      .bind(
        `participant-retention-complete:${auditOnly.eventId}`,
        organisationId,
        auditOnly.eventId,
        auditOnly.eventId,
        JSON.stringify({
          version: 1,
          scope: "local_event_data",
          repositoryProvider: "d1",
          externalProviderErasureRequired: false,
          immutableAuditRecords: 0,
          sharedIdentityAuditLinks: 0,
          retainedProgrammeRecords: 0,
          unscopedStoresNotAutomaticallyRedacted: [
            "webhook_receipts",
            "abuse_rate_limits",
          ],
        }),
      )
      .run();
    const auditOnlyPreview = await auditOnlyService.preview(auditOnly.owner);
    expect(auditOnlyPreview.integrityViolations).toContain(
      "The immutable completion audit exists without the event completion tombstone.",
    );
    await expect(
      auditOnlyService.anonymiseExpiredParticipants(auditOnly.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("integrity check failed");
  });

  it("fails closed for non-owners, legal holds, published forms, and incorrect confirmation", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await expect(
      service.preview({ ...seeded.owner, role: "administrator" }),
    ).rejects.toBeInstanceOf(ParticipantRetentionAccessError);
    await expect(
      service.preview({
        ...seeded.owner,
        organisationId: "org-outside-retention-scope",
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionAccessError);
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "wrong event",
        acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionConfirmationError);

    await seeded.testEnv.DB.prepare(
      "UPDATE events SET file_retention_hold_at = unixepoch() WHERE id = ?",
    )
      .bind(seeded.eventId)
      .run();
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("retention hold");

    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        "UPDATE events SET file_retention_hold_at = NULL WHERE id = ?",
      ).bind(seeded.eventId),
      seeded.testEnv.DB.prepare(
        "UPDATE form_definitions SET status = 'published' WHERE id = ?",
      ).bind(seeded.formId),
    ]);
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionStateError);
  });

  it("serialises concurrent confirmations into one completion without duplicate subjects", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    const results = await Promise.all([
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ]);
    expect(results.every((result) => result.complete)).toBe(true);
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_events
             WHERE id = ?) AS completions,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ?
               AND action = 'participant.retention.subject_anonymised') AS subjects,
           (SELECT COUNT(*) FROM audit_events subject
             WHERE subject.event_id = ?
               AND subject.action = 'participant.retention.subject_anonymised'
               AND (
                 EXISTS (SELECT 1 FROM memberships membership
                   WHERE membership.event_id = ?
                     AND membership.person_id = subject.entity_id)
                 OR EXISTS (SELECT 1 FROM submissions submission
                   WHERE submission.event_id = ?
                     AND submission.submitter_person_id = subject.entity_id)
                 OR EXISTS (SELECT 1 FROM session_speakers speaker
                   WHERE speaker.event_id = ?
                     AND speaker.person_id = subject.entity_id)
               )) AS linkedSubjects`,
      )
        .bind(
          `participant-retention-complete:${seeded.eventId}`,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
        )
        .first(),
    ).toEqual({ completions: 1, subjects: 3, linkedSubjects: 3 });
  });
});

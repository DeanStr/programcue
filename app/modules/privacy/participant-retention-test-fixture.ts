import { env } from "cloudflare:test";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

export const organisationId = "org-future-events";

export function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function seedExpiredRetentionEvent() {
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
  const decisionOperationId = id("privacy-decision-operation");
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
         pronunciation, organisation_name, job_title, linkedin_url, x_handle,
         profile_status
       ) VALUES (?, ?, 'Exclusive Person', 1, 'https://images.invalid/exclusive',
                 'Private biography', 'Private pronunciation', 'Private Org',
                 'Private role', 'https://www.linkedin.com/in/exclusive-person',
                 'exclusive_user', 'published')`,
    ).bind(exclusiveId, `${exclusiveId}@example.com`),
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, biography, linkedin_url,
         x_handle, profile_status
       ) VALUES (?, ?, 'Shared Person', 1, 'Shared biography',
                 'https://www.linkedin.com/in/shared-person', 'shared_user',
                 'published')`,
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
      `INSERT INTO event_participant_profiles (
         event_id, organisation_id, person_id, travel_preferences,
         last_operation_id
       ) VALUES (?, ?, ?, 'Exclusive event travel preferences', ?),
                (?, ?, ?, 'Shared event travel preferences', ?),
                (?, ?, ?, 'Other event travel preferences', ?)`,
    ).bind(
      eventId,
      organisationId,
      exclusiveId,
      id("privacy-exclusive-event-profile"),
      eventId,
      organisationId,
      sharedId,
      id("privacy-shared-event-profile"),
      otherEventId,
      organisationId,
      sharedId,
      id("privacy-shared-other-event-profile"),
    ),
    testEnv.DB.prepare(
      `INSERT INTO speaker_profile_revisions (
         id, organisation_id, event_id, person_id, source, profile_revision,
         display_name, biography, publication_status, recorded_by_person_id,
         correlation_id
       ) VALUES (?, ?, ?, ?, 'canonical_person', 1, 'Exclusive Person',
                 'Private historical biography', 'published',
                 'person-demo-owner', ?),
                (?, ?, ?, ?, 'canonical_person', 1, 'Shared Person',
                 'Other event historical biography', 'published',
                 'person-demo-owner', ?)`,
    ).bind(
      id("privacy-profile-revision"),
      organisationId,
      eventId,
      exclusiveId,
      id("privacy-profile-correlation"),
      id("privacy-other-profile-revision"),
      organisationId,
      otherEventId,
      sharedId,
      id("privacy-other-profile-correlation"),
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
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (?, ?, ?, 0, 'Presenter', 'confirmed', unixepoch(), 'public')`,
    ).bind(sessionId, eventId, exclusiveId),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (?, ?, 'person-demo-owner', 1, 'Host', 'confirmed', unixepoch(), 'public')`,
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
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, 'person', 'internal', 1, ?, ?, 'person-demo-owner', 'file.erasure.completed',
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
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json
       ) VALUES (?, ?, ?, 'person-demo-owner', 'decision.notification', ?, ?,
                 'completed', '{"privateDecisionId":"private-decision"}')`,
    ).bind(
      decisionOperationId,
      organisationId,
      eventId,
      id("privacy-decision-operation-key"),
      id("privacy-decision-correlation"),
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
         id, event_id, template_version_id, sender_profile_id, operation_id,
         idempotency_key, kind, channel, status, audience_json, content_snapshot_json,
         recipient_count, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'transactional', 'email', 'sent', ?, ?, 1,
                 unixepoch())`,
    ).bind(
      communicationId,
      eventId,
      templateVersionId,
      senderProfileId,
      decisionOperationId,
      id("privacy-communication-key"),
      JSON.stringify({
        type: "decision",
        decisionId: id("privacy-decision"),
        email: `${exclusiveId}@example.com`,
      }),
      JSON.stringify({ html: "Hello Exclusive Person" }),
    ),
    testEnv.DB.prepare(
      `INSERT INTO communication_deliveries (
         id, event_id, communication_id, person_id, recipient_address,
         recipient_name, source_values_json, channel, provider,
         provider_message_id, idempotency_key, status, rendered_subject,
         rendered_body_sha256
       ) VALUES (?, ?, ?, ?, ?, 'Exclusive Person', ?, 'email', 'resend', ?, ?,
                 'delivered', 'Hello Exclusive Person',
                 '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')`,
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
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'submission.created', 'submission', ?, ?)`,
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
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json
       ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'submission.created', 'submission', ?, ?)`,
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
    decisionOperationId,
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

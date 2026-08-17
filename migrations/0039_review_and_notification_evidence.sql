-- Bind AI assessments to the exact submitted source and materialise
-- decision-notification intent before Queue dispatch.

ALTER TABLE ai_review_assessments
  ADD COLUMN submission_revision_id TEXT REFERENCES submission_revisions(id);

ALTER TABLE ai_review_assessments
  ADD COLUMN source_snapshot_sha256 TEXT CHECK (
    source_snapshot_sha256 IS NULL OR (
      length(source_snapshot_sha256) = 64
      AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE ai_review_assessments
  ADD COLUMN model_input_sha256 TEXT CHECK (
    model_input_sha256 IS NULL OR (
      length(model_input_sha256) = 64
      AND model_input_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE ai_review_assessments
  ADD COLUMN prompt_version INTEGER CHECK (
    prompt_version IS NULL OR prompt_version > 0
  );

CREATE TRIGGER ai_review_assessments_source_required
BEFORE INSERT ON ai_review_assessments
WHEN NEW.submission_revision_id IS NULL
  OR NEW.source_snapshot_sha256 IS NULL
  OR NEW.model_input_sha256 IS NULL
  OR NEW.prompt_version IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM submission_revisions revision
     WHERE revision.id = NEW.submission_revision_id
       AND revision.event_id = NEW.event_id
       AND revision.submission_id = NEW.submission_id
       AND revision.save_kind = 'submitted'
  )
BEGIN
  SELECT RAISE(ABORT, 'AI assessment requires exact submitted-source provenance');
END;

CREATE TRIGGER ai_review_assessments_source_immutable
BEFORE UPDATE OF
  submission_revision_id,
  source_snapshot_sha256,
  model_input_sha256,
  prompt_version
ON ai_review_assessments
BEGIN
  SELECT RAISE(ABORT, 'AI assessment source provenance is immutable');
END;

ALTER TABLE submission_decisions
  ADD COLUMN notification_operation_id TEXT
    REFERENCES operation_jobs(id) DEFERRABLE INITIALLY DEFERRED;

-- Existing releases remain explicitly unlinked: their historical Queue work
-- did not capture the complete pinned render and delivery evidence required by
-- this contract, so linking it here would overstate the available provenance.
-- Mark that closed historical set now; the publication sentinel below must not
-- infer legacy status from a NULL link that a new malformed release could also
-- create.
INSERT OR IGNORE INTO audit_events (
  id, actor_kind, origin, metadata_version, organisation_id, event_id,
  action, entity_type, entity_id, metadata_json, created_at
)
SELECT 'migration-0039-decision-notification-unlinked:' || decision.id,
       'system', 'internal', 1, event.organisation_id, decision.event_id,
       'decision.notification.legacy_unlinked', 'submission_decision',
       decision.id,
       json_object(
         'reason', 'release predates pinned notification evidence',
         'deliveryOutcome', 'not asserted by migration'
       ),
       unixepoch()
  FROM submission_decisions decision
  JOIN events event ON event.id = decision.event_id
 WHERE decision.status = 'published'
   AND decision.notification_operation_id IS NULL;

CREATE TRIGGER decision_notification_legacy_unlinked_set_closed
BEFORE INSERT ON audit_events
WHEN NEW.action = 'decision.notification.legacy_unlinked'
BEGIN
  SELECT RAISE(ABORT, 'legacy unlinked decision notification set is closed');
END;

-- A running legacy operation may already have crossed the provider boundary,
-- so require it to drain before migration. Unclaimed legacy work cannot be
-- rendered safely by the new contract and is cancelled with durable evidence.
CREATE TABLE migration_0039_decision_notification_guard (
  legacy_running_notifications_must_drain INTEGER NOT NULL
    CHECK (legacy_running_notifications_must_drain = 1)
);

INSERT INTO migration_0039_decision_notification_guard (
  legacy_running_notifications_must_drain
)
SELECT 0
  FROM operation_jobs operation
 WHERE operation.type = 'decision.notification'
   AND operation.status = 'running'
   AND json_type(operation.payload_json, '$.communicationId') IS NULL
 LIMIT 1;

DROP TABLE migration_0039_decision_notification_guard;

INSERT OR IGNORE INTO audit_events (
  id, actor_kind, origin, metadata_version, organisation_id, event_id,
  action, entity_type, entity_id, correlation_id, metadata_json, created_at
)
SELECT 'migration-0039-decision-notification-cancelled:' || operation.id,
       'system', 'internal', 1, operation.organisation_id, operation.event_id,
       'decision.notification.legacy_cancelled', 'operation_job', operation.id,
       operation.correlation_id,
       json_object(
         'reason', 'legacy intent lacks pinned communication and delivery evidence',
         'previousStatus', operation.status,
         'deliveryOutcome', 'not asserted by migration'
       ),
       unixepoch()
  FROM operation_jobs operation
 WHERE operation.type = 'decision.notification'
   AND operation.status IN (
     'queued','queue_failed','received','retrying','failed','partially_failed'
   )
   AND json_type(operation.payload_json, '$.communicationId') IS NULL;

UPDATE communication_deliveries
   SET status = 'cancelled', updated_at = unixepoch()
 WHERE status IN ('queued','failed','sending')
   AND communication_id IN (
     SELECT communication.id
       FROM communications communication
       JOIN operation_jobs operation
         ON operation.id = communication.operation_id
        AND operation.event_id = communication.event_id
      WHERE operation.type = 'decision.notification'
        AND operation.status IN (
          'queued','queue_failed','received','retrying','failed','partially_failed'
        )
        AND json_type(operation.payload_json, '$.communicationId') IS NULL
   );

UPDATE communications
   SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
 WHERE status IN ('draft','scheduled','queued','failed','partially_failed','sending')
   AND operation_id IN (
     SELECT operation.id
       FROM operation_jobs operation
      WHERE operation.type = 'decision.notification'
        AND operation.status IN (
          'queued','queue_failed','received','retrying','failed','partially_failed'
        )
        AND json_type(operation.payload_json, '$.communicationId') IS NULL
   );

UPDATE operation_items
   SET status = 'skipped', error_code = 'LEGACY_INTENT_RETIRED',
       error_message =
         'The pre-migration decision notification lacked pinned delivery evidence.',
       completed_at = unixepoch(), updated_at = unixepoch()
 WHERE status IN ('pending','failed','running')
   AND operation_id IN (
     SELECT operation.id
       FROM operation_jobs operation
      WHERE operation.type = 'decision.notification'
        AND operation.status IN (
          'queued','queue_failed','received','retrying','failed','partially_failed'
        )
        AND json_type(operation.payload_json, '$.communicationId') IS NULL
   );

UPDATE operation_jobs
   SET status = 'cancelled', last_error = NULL, claim_token = NULL,
       claim_expires_at = NULL, completed_at = unixepoch(), updated_at = unixepoch()
 WHERE type = 'decision.notification'
   AND status IN (
     'queued','queue_failed','received','retrying','failed','partially_failed'
   )
   AND json_type(payload_json, '$.communicationId') IS NULL;

CREATE UNIQUE INDEX ux_submission_decisions_notification_operation
  ON submission_decisions(notification_operation_id)
  WHERE notification_operation_id IS NOT NULL;

CREATE TRIGGER submission_decisions_notification_operation_immutable
BEFORE UPDATE OF notification_operation_id ON submission_decisions
WHEN OLD.notification_operation_id IS NOT NEW.notification_operation_id
BEGIN
  SELECT RAISE(ABORT, 'decision notification operation identity is immutable');
END;

CREATE TRIGGER decision_notification_operation_intent_immutable
BEFORE UPDATE OF
  organisation_id,
  event_id,
  requested_by_person_id,
  type,
  idempotency_key,
  correlation_id,
  payload_json
ON operation_jobs
WHEN (
  OLD.type = 'decision.notification'
  OR NEW.type = 'decision.notification'
)
AND (
  OLD.organisation_id IS NOT NEW.organisation_id
  OR OLD.event_id IS NOT NEW.event_id
  OR OLD.requested_by_person_id IS NOT NEW.requested_by_person_id
  OR OLD.type IS NOT NEW.type
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.correlation_id IS NOT NEW.correlation_id
  OR OLD.payload_json IS NOT NEW.payload_json
)
AND NOT (
  OLD.organisation_id IS NEW.organisation_id
  AND OLD.event_id IS NEW.event_id
  AND OLD.requested_by_person_id IS NEW.requested_by_person_id
  AND OLD.type IS NEW.type
  AND NEW.idempotency_key = 'retained-operation-' || OLD.id
  AND NEW.correlation_id = 'retained-correlation-' || OLD.id
  AND NEW.payload_json =
      '{"redacted":true,"reason":"event_retention_period_elapsed"}'
)
BEGIN
  SELECT RAISE(ABORT, 'decision notification operation intent is immutable');
END;

ALTER TABLE communication_deliveries
  ADD COLUMN rendered_subject TEXT CHECK (
    rendered_subject IS NULL OR length(rendered_subject) BETWEEN 1 AND 500
  );

ALTER TABLE communication_deliveries
  ADD COLUMN rendered_body_sha256 TEXT CHECK (
    rendered_body_sha256 IS NULL OR (
      length(rendered_body_sha256) = 64
      AND rendered_body_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TRIGGER communication_deliveries_evidence_retention_no_pii_update
BEFORE UPDATE OF rendered_subject, rendered_body_sha256
ON communication_deliveries
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER decision_communications_intent_required
BEFORE INSERT ON communications
WHEN EXISTS (
  SELECT 1
    FROM submission_decisions decision
   WHERE decision.notification_operation_id = NEW.operation_id
     AND decision.event_id = NEW.event_id
)
AND (
  NEW.template_version_id IS NULL
  OR NEW.sender_profile_id IS NULL
  OR NEW.kind IS NOT 'transactional'
  OR NEW.channel IS NOT 'email'
  OR NEW.recipient_count IS NOT 1
  OR json_extract(NEW.audience_json, '$.type') IS NOT 'decision'
  OR json_extract(NEW.audience_json, '$.renderContractVersion') IS NOT 1
  OR NOT EXISTS (
    SELECT 1
      FROM submission_decisions decision
     WHERE decision.notification_operation_id = NEW.operation_id
       AND decision.event_id = NEW.event_id
       AND decision.id = json_extract(NEW.audience_json, '$.decisionId')
       AND decision.submission_id =
           json_extract(NEW.audience_json, '$.submissionId')
  )
  OR json_extract(NEW.content_snapshot_json, '$.schemaVersion') IS NOT 1
  OR json_extract(NEW.content_snapshot_json, '$.renderContractVersion') IS NOT 1
  OR json_extract(NEW.content_snapshot_json, '$.category') IS NOT 'decision'
  OR json_extract(NEW.content_snapshot_json, '$.template.id')
       IS NOT NEW.template_version_id
  OR COALESCE(length(trim(json_extract(
       NEW.content_snapshot_json, '$.template.name'
     ))), 0) < 1
  OR json_type(NEW.content_snapshot_json, '$.template.versionNumber')
       IS NOT 'integer'
  OR json_extract(NEW.content_snapshot_json, '$.template.versionNumber') < 1
  OR json_extract(NEW.content_snapshot_json, '$.sender.id')
       IS NOT NEW.sender_profile_id
  OR (
    json_extract(NEW.content_snapshot_json, '$.sender.provider') IS NOT 'resend'
    AND json_extract(NEW.content_snapshot_json, '$.sender.provider') IS NOT 'mailpit'
  )
  OR COALESCE(length(trim(json_extract(
       NEW.content_snapshot_json, '$.sender.fromName'
     ))), 0) < 1
  OR COALESCE(length(trim(json_extract(
       NEW.content_snapshot_json, '$.sender.fromEmail'
     ))), 0) < 1
  OR COALESCE(length(trim(json_extract(
       NEW.content_snapshot_json, '$.subjectTemplate'
     ))), 0) < 1
  OR NOT EXISTS (
    SELECT 1
      FROM operation_jobs operation
     WHERE operation.id = NEW.operation_id
       AND operation.event_id = NEW.event_id
       AND operation.type = 'decision.notification'
       AND operation.idempotency_key = NEW.idempotency_key
  )
)
BEGIN
  SELECT RAISE(ABORT, 'decision communication requires complete pinned intent');
END;

CREATE TRIGGER decision_deliveries_intent_required
BEFORE INSERT ON communication_deliveries
WHEN EXISTS (
  SELECT 1
    FROM communications communication
    JOIN submission_decisions decision
      ON decision.notification_operation_id = communication.operation_id
     AND decision.event_id = communication.event_id
   WHERE communication.id = NEW.communication_id
     AND communication.event_id = NEW.event_id
     AND (
       COALESCE(length(trim(NEW.recipient_address)), 0) < 1
       OR COALESCE(length(trim(NEW.recipient_name)), 0) < 1
       OR NEW.source_id IS NOT decision.submission_id
       OR NEW.channel IS NOT 'email'
       OR NEW.provider IS NOT json_extract(
            communication.content_snapshot_json, '$.sender.provider'
          )
       OR COALESCE(length(trim(NEW.rendered_subject)), 0) < 1
       OR NEW.rendered_body_sha256 IS NULL
     )
)
BEGIN
  SELECT RAISE(ABORT, 'decision delivery requires complete pinned evidence');
END;

-- The final published-decision audit is also the transaction completion
-- sentinel. Every preceding notification write is deliberately conditional;
-- abort the batch instead of allowing any of those statements to succeed as a
-- no-op and leave a released decision with partial durable intent.
CREATE TRIGGER decision_published_notification_graph_required
BEFORE INSERT ON audit_events
WHEN NEW.action = 'decision.published'
AND NOT EXISTS (
  -- Only the closed set marked while this migration ran may remain unlinked.
  SELECT 1
    FROM submission_decisions legacy_decision
   WHERE legacy_decision.id = NEW.entity_id
     AND legacy_decision.event_id = NEW.event_id
     AND legacy_decision.status = 'published'
     AND legacy_decision.notification_operation_id IS NULL
     AND EXISTS (
       SELECT 1 FROM audit_events legacy_marker
        WHERE legacy_marker.organisation_id = NEW.organisation_id
          AND legacy_marker.event_id = NEW.event_id
          AND legacy_marker.action = 'decision.notification.legacy_unlinked'
          AND legacy_marker.entity_type = 'submission_decision'
          AND legacy_marker.entity_id = legacy_decision.id
     )
  UNION ALL
  SELECT 1
    FROM submission_decisions decision
    JOIN operation_jobs operation
      ON operation.id = decision.notification_operation_id
     AND operation.event_id = decision.event_id
     AND operation.organisation_id = NEW.organisation_id
     AND operation.type = 'decision.notification'
     AND operation.status = 'queued'
    JOIN communications communication
      ON communication.operation_id = operation.id
     AND communication.event_id = decision.event_id
     AND communication.status = 'queued'
    JOIN communication_deliveries delivery
      ON delivery.communication_id = communication.id
     AND delivery.event_id = decision.event_id
     AND delivery.status = 'queued'
    JOIN operation_items item
      ON item.operation_id = operation.id
     AND item.entity_type = 'communication_delivery'
     AND item.entity_id = delivery.id
     AND item.status = 'pending'
   WHERE decision.id = NEW.entity_id
     AND decision.event_id = NEW.event_id
     AND decision.status = 'published'
     AND decision.notification_operation_id =
         json_extract(NEW.metadata_json, '$.notificationOperationId')
     AND (SELECT COUNT(*) FROM communications linked_communication
           WHERE linked_communication.operation_id = operation.id
             AND linked_communication.event_id = decision.event_id) = 1
     AND (SELECT COUNT(*)
            FROM communication_deliveries linked_delivery
           WHERE linked_delivery.communication_id = communication.id
             AND linked_delivery.event_id = decision.event_id) = 1
     AND (SELECT COUNT(*) FROM operation_items linked_item
           WHERE linked_item.operation_id = operation.id) = 1
     AND EXISTS (
       SELECT 1 FROM audit_events prepared
        WHERE prepared.action = 'decision.notification.prepared'
          AND prepared.organisation_id = NEW.organisation_id
          AND prepared.event_id = NEW.event_id
          AND prepared.entity_type = 'communication'
          AND prepared.entity_id = communication.id
          AND prepared.correlation_id = operation.id
          AND json_extract(prepared.metadata_json, '$.decisionId') = decision.id
          AND json_extract(prepared.metadata_json, '$.operationId') = operation.id
          AND json_extract(prepared.metadata_json, '$.deliveryId') = delivery.id
     )
     AND EXISTS (
       SELECT 1 FROM event_changes notification_change
        WHERE notification_change.event_id = decision.event_id
          AND notification_change.entity_type = 'communication'
          AND notification_change.entity_id = communication.id
          AND notification_change.change_type = 'created'
          AND notification_change.correlation_id = operation.correlation_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'published decision requires a complete durable notification graph');
END;

CREATE TRIGGER decision_communications_intent_immutable
BEFORE UPDATE OF
  event_id,
  template_version_id,
  sender_profile_id,
  operation_id,
  idempotency_key,
  kind,
  channel,
  audience_json,
  content_snapshot_json,
  recipient_count
ON communications
WHEN (
  json_extract(OLD.audience_json, '$.type') = 'decision'
  OR json_extract(NEW.audience_json, '$.type') = 'decision'
)
  AND (
    OLD.event_id IS NOT NEW.event_id
    OR OLD.template_version_id IS NOT NEW.template_version_id
    OR OLD.sender_profile_id IS NOT NEW.sender_profile_id
    OR OLD.operation_id IS NOT NEW.operation_id
    OR OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.kind IS NOT NEW.kind
    OR OLD.channel IS NOT NEW.channel
    OR OLD.audience_json IS NOT NEW.audience_json
    OR OLD.content_snapshot_json IS NOT NEW.content_snapshot_json
    OR OLD.recipient_count IS NOT NEW.recipient_count
  )
  AND NOT (
    OLD.event_id IS NEW.event_id
    AND OLD.template_version_id IS NEW.template_version_id
    AND OLD.sender_profile_id IS NEW.sender_profile_id
    AND OLD.operation_id IS NEW.operation_id
    AND NEW.idempotency_key = 'retained-communication-' || OLD.id
    AND OLD.kind IS NEW.kind
    AND OLD.channel IS NEW.channel
    AND NEW.audience_json =
        '{"redacted":true,"reason":"event_retention_period_elapsed"}'
    AND NEW.content_snapshot_json =
        '{"redacted":true,"reason":"event_retention_period_elapsed"}'
    AND OLD.recipient_count IS NEW.recipient_count
  )
BEGIN
  SELECT RAISE(ABORT, 'decision communication intent is immutable');
END;

CREATE TRIGGER decision_deliveries_intent_immutable
BEFORE UPDATE OF
  event_id,
  communication_id,
  person_id,
  recipient_address,
  recipient_name,
  source_id,
  source_values_json,
  channel,
  provider,
  idempotency_key,
  rendered_subject,
  rendered_body_sha256
ON communication_deliveries
WHEN (
  EXISTS (
    SELECT 1
      FROM communications communication
     WHERE communication.id = OLD.communication_id
       AND communication.event_id = OLD.event_id
       AND json_extract(communication.audience_json, '$.type') = 'decision'
  )
  OR EXISTS (
    SELECT 1
      FROM communications communication
     WHERE communication.id = NEW.communication_id
       AND communication.event_id = NEW.event_id
       AND json_extract(communication.audience_json, '$.type') = 'decision'
  )
)
  AND (
    OLD.event_id IS NOT NEW.event_id
    OR OLD.communication_id IS NOT NEW.communication_id
    OR OLD.person_id IS NOT NEW.person_id
    OR OLD.recipient_address IS NOT NEW.recipient_address
    OR OLD.recipient_name IS NOT NEW.recipient_name
    OR OLD.source_id IS NOT NEW.source_id
    OR OLD.source_values_json IS NOT NEW.source_values_json
    OR OLD.channel IS NOT NEW.channel
    OR OLD.provider IS NOT NEW.provider
    OR OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.rendered_subject IS NOT NEW.rendered_subject
    OR OLD.rendered_body_sha256 IS NOT NEW.rendered_body_sha256
  )
  AND NOT (
    OLD.event_id IS NEW.event_id
    AND OLD.communication_id IS NEW.communication_id
    AND OLD.person_id IS NOT NEW.person_id
    AND NEW.person_id GLOB 'retained-participant-*'
    AND OLD.recipient_address IS NEW.recipient_address
    AND OLD.recipient_name IS NEW.recipient_name
    AND OLD.source_id IS NEW.source_id
    AND OLD.source_values_json IS NEW.source_values_json
    AND OLD.channel IS NEW.channel
    AND OLD.provider IS NEW.provider
    AND OLD.idempotency_key IS NEW.idempotency_key
    AND OLD.rendered_subject IS NEW.rendered_subject
    AND OLD.rendered_body_sha256 IS NEW.rendered_body_sha256
  )
  AND NOT (
    OLD.event_id IS NEW.event_id
    AND OLD.communication_id IS NEW.communication_id
    AND OLD.person_id IS NEW.person_id
    AND NEW.recipient_address =
        'retained-delivery-' || OLD.id || '@privacy.invalid'
    AND NEW.recipient_name IS NULL
    AND NEW.source_id IS NULL
    AND NEW.source_values_json =
        '{"redacted":true,"reason":"event_retention_period_elapsed"}'
    AND OLD.channel IS NEW.channel
    AND NEW.provider IS NULL
    AND NEW.idempotency_key = 'retained-delivery-' || OLD.id
    AND (
      (OLD.rendered_subject IS NULL AND NEW.rendered_subject IS NULL)
      OR (
        OLD.rendered_subject IS NOT NULL
        AND NEW.rendered_subject = 'Retained message'
      )
    )
    AND NEW.rendered_body_sha256 IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'decision delivery intent is immutable');
END;

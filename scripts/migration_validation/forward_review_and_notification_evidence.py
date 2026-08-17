import json
from pathlib import Path
import sqlite3


MIGRATION = "0041_review_and_notification_evidence.sql"
FILE_POLICY = json.dumps(
    {
        "headshotMaximumBytes": 10_485_760,
        "slidesMaximumBytes": 104_857_600,
        "supportingDocumentMaximumBytes": 104_857_600,
        "videoMaximumBytes": 1_073_741_824,
    }
)


def database_before_migration(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())
    connection.executescript(
        f"""
        INSERT INTO organisations (id, name, slug)
        VALUES ('notification-org', 'Notification Org', 'notification-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('notification-admin', 'admin@example.test', 'Admin');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'notification-event', 'notification-org', 'Notification Event',
          'notification-event', 'UTC', 100, 200, '{FILE_POLICY}'
        );
        """
    )
    return connection


def legacy_message(operation_id: str) -> str:
    return json.dumps(
        {
            "type": "decision.notification",
            "operationId": operation_id,
            "eventId": "notification-event",
            "organisationId": "notification-org",
            "idempotencyKey": f"legacy-key-{operation_id}",
            "payload": {"decisionId": f"decision-{operation_id}"},
        },
        separators=(",", ":"),
    )


def insert_operation(
    connection: sqlite3.Connection,
    operation_id: str,
    status: str,
    *,
    pinned: bool = False,
) -> None:
    payload = (
        json.dumps(
            {
                "type": "decision.notification",
                "operationId": operation_id,
                "communicationId": f"communication-{operation_id}",
                "eventId": "notification-event",
                "organisationId": "notification-org",
                "idempotencyKey": f"legacy-key-{operation_id}",
                "payload": {"decisionId": f"decision-{operation_id}"},
            },
            separators=(",", ":"),
        )
        if pinned
        else legacy_message(operation_id)
    )
    connection.execute(
        """
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json
        ) VALUES (?, 'notification-org', 'notification-event',
                  'notification-admin', 'decision.notification', ?, ?, ?, ?)
        """,
        (
            operation_id,
            f"legacy-key-{operation_id}",
            f"correlation-{operation_id}",
            status,
            payload,
        ),
    )


def validate_review_and_notification_evidence_forward_migration(root: Path) -> None:
    deployed = database_before_migration(root)
    insert_operation(deployed, "queued-operation", "queued")
    insert_operation(deployed, "retrying-operation", "retrying")
    insert_operation(deployed, "failed-operation", "failed")
    insert_operation(deployed, "partially-failed-operation", "partially_failed")
    insert_operation(deployed, "completed-operation", "completed")
    insert_operation(deployed, "pinned-operation", "queued", pinned=True)
    deployed.executescript(
        """
        INSERT INTO submissions (
          id, event_id, submitter_email, public_reference, title, status,
          answers_json, submitted_snapshot_json, submitted_at
        ) VALUES
        (
          'legacy-release-submission', 'notification-event',
          'legacy@example.test', 'LEGACY-RELEASE', 'Legacy release',
          'rejected', '{}', '{}', unixepoch()
        ),
        (
          'legacy-superseded-submission', 'notification-event',
          'superseded@example.test', 'LEGACY-SUPERSEDED',
          'Legacy superseded release', 'rejected', '{}', '{}', unixepoch()
        ),
        (
          'legacy-revoked-submission', 'notification-event',
          'revoked@example.test', 'LEGACY-REVOKED',
          'Legacy revoked release', 'rejected', '{}', '{}', unixepoch()
        ),
        (
          'legacy-draft-submission', 'notification-event',
          'draft@example.test', 'LEGACY-DRAFT', 'Legacy superseded draft',
          'rejected', '{}', '{}', unixepoch()
        );
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, notification_feedback_json,
          effect_preview_json, published_at
        ) VALUES
        (
          'legacy-unlinked-decision', 'notification-event',
          'legacy-release-submission', 1, 'published', 'rejected',
          'notification-admin', '[]', '{}', unixepoch()
        ),
        (
          'legacy-superseded-decision', 'notification-event',
          'legacy-superseded-submission', 1, 'superseded', 'rejected',
          'notification-admin', '[]', '{}', unixepoch()
        ),
        (
          'legacy-revoked-decision', 'notification-event',
          'legacy-revoked-submission', 1, 'revoked', 'rejected',
          'notification-admin', '[]', '{}', unixepoch()
        ),
        (
          'legacy-superseded-draft', 'notification-event',
          'legacy-draft-submission', 1, 'superseded', 'rejected',
          'notification-admin', '[]', '{}', NULL
        );
        INSERT INTO communications (
          id, event_id, operation_id, idempotency_key, kind, channel, status,
          audience_json, content_snapshot_json, recipient_count,
          created_by_person_id
        ) VALUES (
          'legacy-communication', 'notification-event', 'queued-operation',
          'legacy-communication-key', 'transactional', 'email', 'queued',
          '{}', '{}', 1, 'notification-admin'
        );
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, recipient_address,
          recipient_name, source_values_json, channel, idempotency_key, status
        ) VALUES (
          'legacy-delivery', 'notification-event', 'legacy-communication',
          'recipient@example.test', 'Recipient', '{}', 'email',
          'legacy-delivery-key', 'queued'
        );
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status
        ) VALUES (
          'legacy-item', 'queued-operation', 'legacy-delivery-key',
          'communication_delivery', 'legacy-delivery', 'pending'
        );
        """
    )

    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())

    statuses = dict(
        deployed.execute(
            "SELECT id, status FROM operation_jobs ORDER BY id"
        ).fetchall()
    )
    expected = {
        "completed-operation": "completed",
        "failed-operation": "cancelled",
        "partially-failed-operation": "cancelled",
        "pinned-operation": "queued",
        "queued-operation": "cancelled",
        "retrying-operation": "cancelled",
    }
    if statuses != expected:
        raise SystemExit(
            f"Decision notification migration produced invalid operation states: {statuses}"
        )
    graph = deployed.execute(
        """
        SELECT communication.status, delivery.status, item.status,
               item.error_code
          FROM communications communication
          JOIN communication_deliveries delivery
            ON delivery.communication_id = communication.id
          JOIN operation_items item ON item.operation_id = communication.operation_id
         WHERE communication.id = 'legacy-communication'
        """
    ).fetchone()
    if graph != (
        "cancelled",
        "cancelled",
        "skipped",
        "LEGACY_INTENT_RETIRED",
    ):
        raise SystemExit(
            f"Decision notification migration left an active legacy graph: {graph}"
        )
    audit_rows = deployed.execute(
        """
        SELECT entity_id, metadata_json
          FROM audit_events
         WHERE action = 'decision.notification.legacy_cancelled'
         ORDER BY entity_id
        """
    ).fetchall()
    if [row[0] for row in audit_rows] != [
        "failed-operation",
        "partially-failed-operation",
        "queued-operation",
        "retrying-operation",
    ]:
        raise SystemExit("Legacy decision notification cancellations were not audited")
    previous_statuses = {
        json.loads(metadata)["previousStatus"] for _, metadata in audit_rows
    }
    if previous_statuses != {
        "failed",
        "partially_failed",
        "queued",
        "retrying",
    }:
        raise SystemExit("Legacy cancellation audit lost the previous operation state")

    legacy_markers = deployed.execute(
        """
        SELECT action, entity_type, entity_id
          FROM audit_events
         WHERE action = 'decision.notification.legacy_unlinked'
         ORDER BY entity_id
        """
    ).fetchall()
    if legacy_markers != [
        (
            "decision.notification.legacy_unlinked",
            "submission_decision",
            "legacy-revoked-decision",
        ),
        (
            "decision.notification.legacy_unlinked",
            "submission_decision",
            "legacy-superseded-decision",
        ),
        (
            "decision.notification.legacy_unlinked",
            "submission_decision",
            "legacy-unlinked-decision",
        ),
    ]:
        raise SystemExit(
            "The migration did not mark exactly its historical released decisions"
        )
    deployed.execute(
        """
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id,
          action, entity_type, entity_id, metadata_json
        ) VALUES (
          'legacy-release-audit', 'system', 'internal', 1,
          'notification-org', 'notification-event', 'decision.published',
          'submission_decision', 'legacy-unlinked-decision',
          '{"decision":"rejected"}'
        )
        """
    )
    deployed.executescript(
        """
        INSERT INTO submissions (
          id, event_id, submitter_email, public_reference, title, status,
          answers_json, submitted_snapshot_json, submitted_at
        ) VALUES (
          'new-release-submission', 'notification-event',
          'new@example.test', 'NEW-RELEASE', 'New release',
          'rejected', '{}', '{}', unixepoch()
        );
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, notification_feedback_json,
          effect_preview_json, published_at
        ) VALUES (
          'new-unlinked-decision', 'notification-event',
          'new-release-submission', 1, 'published', 'rejected',
          'notification-admin', '[]', '{}', unixepoch()
        );
        """
    )
    try:
        deployed.execute(
            """
            INSERT INTO audit_events (
              id, actor_kind, origin, metadata_version, organisation_id,
              event_id, action, entity_type, entity_id, metadata_json
            ) VALUES (
              'forged-legacy-marker', 'system', 'internal', 1,
              'notification-org', 'notification-event',
              'decision.notification.legacy_unlinked',
              'submission_decision', 'new-unlinked-decision', '{}'
            )
            """
        )
    except sqlite3.IntegrityError as error:
        if "legacy unlinked decision notification set is closed" not in str(error):
            raise
    else:
        raise SystemExit("A post-migration release forged a legacy exemption")
    try:
        deployed.execute(
            """
            INSERT INTO audit_events (
              id, actor_kind, origin, metadata_version, organisation_id,
              event_id, action, entity_type, entity_id, metadata_json
            ) VALUES (
              'new-release-audit', 'system', 'internal', 1,
              'notification-org', 'notification-event', 'decision.published',
              'submission_decision', 'new-unlinked-decision',
              '{"decision":"rejected"}'
            )
            """
        )
    except sqlite3.IntegrityError as error:
        if "published decision requires a complete durable notification graph" not in str(
            error
        ):
            raise
    else:
        raise SystemExit("A new NULL-linked release bypassed the notification sentinel")
    if deployed.execute("PRAGMA foreign_key_check").fetchall():
        raise SystemExit("Decision notification migration left broken foreign keys")

    running = database_before_migration(root)
    insert_operation(running, "running-operation", "running")
    try:
        running.executescript(root.joinpath("migrations", MIGRATION).read_text())
    except sqlite3.IntegrityError as error:
        if "legacy_running_notifications_must_drain = 1" not in str(error):
            raise
    else:
        raise SystemExit(
            "Decision notification migration accepted an indeterminate running send"
        )

from pathlib import Path
import sqlite3


MIGRATION = "0052_schedule_review_links.sql"


def validate_schedule_review_links_forward_migration(root: Path) -> None:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())

    connection.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('review-org', 'Review org', 'review-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('review-admin', 'admin@example.test', 'Review admin');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'review-event', 'review-org', 'Review event', 'review-event', 'UTC',
          100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO schedule_versions (id, event_id, version_number, status, revision)
        VALUES ('review-draft', 'review-event', 1, 'draft', 3);
        """
    )
    connection.executescript(root.joinpath("migrations", MIGRATION).read_text())

    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(schedule_review_links)")
    }
    required = {
        "id",
        "organisation_id",
        "event_id",
        "schedule_version_id",
        "schedule_revision",
        "projection_json",
        "token_hash",
        "expires_at",
        "created_by_person_id",
        "created_at",
        "purpose",
        "revoked_at",
        "revoked_by_person_id",
        "revocation_reason",
    }
    missing = required - columns
    if missing:
        raise SystemExit(
            f"Migration 0052 did not create schedule_review_links columns: {sorted(missing)}"
        )

    triggers = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger'"
        )
    }
    required_triggers = {
        "schedule_review_links_immutable_identity",
        "schedule_review_links_revoke_once",
        "schedule_review_links_participant_retention_no_pii_insert",
        "schedule_review_links_participant_retention_no_pii_update",
        "audit_events_display_metadata_insert",
    }
    missing_triggers = required_triggers - triggers
    if missing_triggers:
        raise SystemExit(
            f"Migration 0052 did not install triggers: {sorted(missing_triggers)}"
        )

    try:
        connection.execute(
            """
            INSERT INTO schedule_review_links (
              id, organisation_id, event_id, schedule_version_id, schedule_revision,
              projection_json, token_hash, expires_at, created_by_person_id, created_at,
              purpose
            ) VALUES (
              'review-link-bad-hash', 'review-org', 'review-event', 'review-draft', 3,
              '{"schemaVersion":1}',
              'a' || replace(hex(zeroblob(31)), '0', 'z') || 'a',
              unixepoch() + 86400, 'review-admin', unixepoch(), 'Programme committee'
            )
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Migration 0052 accepted a non-hex token hash")

    connection.execute(
        """
        INSERT INTO schedule_review_links (
          id, organisation_id, event_id, schedule_version_id, schedule_revision,
          projection_json, token_hash, expires_at, created_by_person_id, created_at,
          purpose
        ) VALUES (
          'review-link', 'review-org', 'review-event', 'review-draft', 3,
          '{"schemaVersion":1}',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          unixepoch() + 86400, 'review-admin', unixepoch(), 'Programme committee'
        )
        """
    )
    try:
        connection.execute(
            """
            INSERT INTO schedule_review_links (
              id, organisation_id, event_id, schedule_version_id, schedule_revision,
              projection_json, token_hash, expires_at, created_by_person_id, created_at,
              purpose, revoked_at
            ) VALUES (
              'review-link-null-reason', 'review-org', 'review-event', 'review-draft', 3,
              '{"schemaVersion":1}',
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              unixepoch() + 86400, 'review-admin', unixepoch(), 'Programme committee',
              unixepoch()
            )
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit(
            "Migration 0052 accepted a revoked review link without a revocation reason"
        )

    try:
        connection.execute(
            "UPDATE schedule_review_links SET revoked_at = unixepoch() WHERE id = 'review-link'"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit(
            "Migration 0052 allowed revoke without a revocation reason"
        )

    try:
        connection.execute(
            "UPDATE schedule_review_links SET projection_json = '{}' WHERE id = 'review-link'"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Migration 0052 allowed mutation of an immutable review projection")

    connection.execute(
        """
        UPDATE schedule_review_links
           SET revoked_at = unixepoch(),
               revoked_by_person_id = 'review-admin',
               revocation_reason = 'manual'
         WHERE id = 'review-link'
        """
    )
    try:
        connection.execute(
            """
            UPDATE schedule_review_links
               SET revoked_at = unixepoch(),
                   revoked_by_person_id = 'review-admin',
                   revocation_reason = 'published'
             WHERE id = 'review-link'
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Migration 0052 allowed a second review-link revocation")

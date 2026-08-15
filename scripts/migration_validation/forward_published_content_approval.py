from pathlib import Path
import sqlite3


def validate_published_content_approval_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0012_backfill_published_content_approval.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('legacy-content-org', 'Legacy content organisation', 'legacy-content-organisation');
        INSERT INTO people (id, email, display_name)
        VALUES ('legacy-content-owner', 'legacy-content-owner@example.test', 'Legacy content owner');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'legacy-content-event', 'legacy-content-org', 'Legacy content event',
          'legacy-content-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, visibility,
          status, required_resources_json
        ) VALUES (
          'legacy-content-session', 'legacy-content-event', 'Legacy session',
          'legacy-session', 'talk', 30, 'public', 'published', '[]'
        );
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id,
          published_at
        ) VALUES (
          'legacy-content-version', 'legacy-content-event', 1, 'published',
          'legacy-content-owner', 150
        );
        UPDATE schedule_session_contents
           SET content_status = 'draft',
               approved_by_person_id = NULL,
               approved_at = NULL,
               updated_at = 140
         WHERE schedule_version_id = 'legacy-content-version'
           AND session_id = 'legacy-content-session';
        """
    )
    deployed.executescript(
        root.joinpath(
            "migrations/0012_backfill_published_content_approval.sql"
        ).read_text()
    )
    approval = deployed.execute(
        """
        SELECT content_status, approved_by_person_id, approved_at
          FROM schedule_session_contents
         WHERE schedule_version_id = 'legacy-content-version'
           AND session_id = 'legacy-content-session'
        """
    ).fetchone()
    if approval != ("approved", "legacy-content-owner", 150):
        raise SystemExit(
            "Legacy published content was not migrated to attributed approval"
        )

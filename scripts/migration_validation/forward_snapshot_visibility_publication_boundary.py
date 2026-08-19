from pathlib import Path
import sqlite3

MIGRATION = "0044_snapshot_visibility_publication_boundary.sql"
FILE_POLICY = (
    '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,'
    '"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
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
        VALUES ('visibility-org', 'Visibility Org', 'visibility-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('visibility-admin', 'visibility-admin@example.test', 'Admin');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json, programme_published_at
        ) VALUES (
          'visibility-event', 'visibility-org', 'Visibility Event',
          'visibility-event', 'UTC', 100, 200, '{FILE_POLICY}', 150
        );
        INSERT INTO rooms (id, event_id, name, position, capacity)
        VALUES ('visibility-room', 'visibility-event', 'Main', 0, 100);
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, visibility,
          status, required_resources_json
        ) VALUES
          ('public-session', 'visibility-event', 'Public session',
           'public-session', 'talk', 30, 'public', 'published', '[]'),
          ('private-session', 'visibility-event', 'Private session',
           'private-session', 'talk', 30, 'private', 'published', '[]');
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id
        ) VALUES (
          'published-version', 'visibility-event', 1, 'draft',
          'visibility-admin'
        );
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES
          ('public-entry', 'visibility-event', 'published-version',
           'public-session', 'visibility-room', 110, 140),
          ('private-entry', 'visibility-event', 'published-version',
           'private-session', 'visibility-room', 150, 180);
        UPDATE schedule_session_contents
           SET content_status = 'approved',
               approved_by_person_id = 'visibility-admin',
               approved_at = 150, approval_source = 'editorial'
         WHERE schedule_version_id = 'published-version'
           AND session_id = 'public-session';
        UPDATE schedule_session_contents
           SET visibility = 'public', content_status = 'draft',
               approved_by_person_id = NULL, approved_at = NULL,
               approval_source = NULL
         WHERE schedule_version_id = 'published-version'
           AND session_id = 'private-session';
        UPDATE schedule_versions
           SET status = 'published', published_at = 150
         WHERE id = 'published-version';
        UPDATE sessions
           SET visibility = 'private'
         WHERE id = 'public-session';
        """
    )
    return connection


def validate_snapshot_visibility_publication_boundary_forward_migration(
    root: Path,
) -> None:
    deployed = database_before_migration(root)
    drifted = deployed.execute(
        "SELECT visibility FROM sessions WHERE id = 'public-session'"
    ).fetchone()
    if drifted != ("private",):
        raise SystemExit(
            "Pre-0044 fixture did not diverge live visibility from the published snapshot"
        )

    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())

    repaired = deployed.execute(
        """
        SELECT session.visibility, content.visibility
          FROM sessions session
          JOIN schedule_session_contents content
            ON content.session_id = session.id
           AND content.event_id = session.event_id
           AND content.schedule_version_id = 'published-version'
         WHERE session.id = 'public-session'
        """
    ).fetchone()
    if repaired != ("public", "public"):
        raise SystemExit(
            "Migration 0044 did not restore live visibility from the published snapshot"
        )

    legacy_repaired = deployed.execute(
        """
        SELECT session.visibility, content.visibility, content.content_status,
               content.approved_by_person_id, content.approved_at,
               content.approval_source
          FROM sessions session
          JOIN schedule_session_contents content
            ON content.session_id = session.id
           AND content.event_id = session.event_id
           AND content.schedule_version_id = 'published-version'
         WHERE session.id = 'private-session'
        """
    ).fetchone()
    if legacy_repaired != (
        "public",
        "public",
        "approved",
        None,
        150,
        "legacy_publication",
    ):
        raise SystemExit(
            "Migration 0044 did not normalize a legacy public snapshot before restoring visibility"
        )

    change = deployed.execute(
        """
        SELECT COUNT(*) FROM event_changes
         WHERE event_id = 'visibility-event'
           AND correlation_id = 'migration-0044-snapshot-visibility'
        """
    ).fetchone()
    if change != (1,):
        raise SystemExit(
            "Migration 0044 did not record a public-cache invalidation change"
        )

    deployed.execute(
        """
        UPDATE schedule_session_contents
           SET description = 'Retention may still redact published descriptions'
         WHERE schedule_version_id = 'published-version'
           AND session_id = 'public-session'
        """
    )
    deployed.execute(
        """
        UPDATE schedule_session_contents
           SET content_status = 'approved', visibility = 'public'
         WHERE schedule_version_id = 'published-version'
           AND session_id = 'public-session'
        """
    )

    for statement, message in (
        (
            """
            UPDATE schedule_session_contents
               SET visibility = 'public', content_status = 'draft',
                   approved_by_person_id = NULL, approved_at = NULL,
                   approval_source = NULL
             WHERE schedule_version_id = 'published-version'
               AND session_id = 'private-session'
            """,
            "A legacy published snapshot was allowed to lose approval",
        ),
        (
            """
            UPDATE schedule_session_contents
               SET content_status = 'draft'
             WHERE schedule_version_id = 'published-version'
               AND session_id = 'public-session'
            """,
            "A published public snapshot was allowed to lose approval",
        ),
        (
            """
            UPDATE schedule_session_contents
               SET visibility = 'private'
             WHERE schedule_version_id = 'published-version'
               AND session_id = 'public-session'
            """,
            "A published public snapshot was allowed to change visibility",
        ),
        (
            """
            DELETE FROM schedule_session_contents
             WHERE schedule_version_id = 'published-version'
               AND session_id = 'private-session'
            """,
            "A legacy published snapshot was allowed to be deleted",
        ),
    ):
        try:
            deployed.execute(statement)
        except sqlite3.IntegrityError as error:
            if "published schedule snapshot" not in str(error):
                raise
        else:
            raise SystemExit(message)

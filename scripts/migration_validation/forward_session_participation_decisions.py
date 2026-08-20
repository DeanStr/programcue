from pathlib import Path
import sqlite3


MIGRATION = "0050_session_participation_decisions.sql"


def validate_session_participation_decisions_forward_migration(root: Path) -> None:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())

    connection.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('participation-org', 'Participation org', 'participation-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('participation-person', 'participant@example.test', 'Participant');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'participation-event', 'participation-org', 'Participation event',
          'participation-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes
        ) VALUES (
          'participation-session', 'participation-event', 'Session',
          'participation-session', 'presentation', 30
        );
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label,
          participation_status, participation_confirmed_at, visibility
        ) VALUES (
          'participation-session', 'participation-event',
          'participation-person', 0, 'Speaker', 'pending', NULL, 'public'
        );
        """
    )
    connection.executescript(root.joinpath("migrations", MIGRATION).read_text())

    migrated = connection.execute(
        """
        SELECT participation_status, participation_revision,
               participation_confirmed_at, participation_declined_at,
               participation_decline_reason
          FROM session_speakers
         WHERE session_id = 'participation-session'
           AND person_id = 'participation-person'
        """
    ).fetchone()
    if migrated != ("pending", 1, None, None, None):
        raise SystemExit("Migration 0050 did not preserve pending participation")

    required_triggers = {
        "session_speakers_participant_retention_no_pii_insert",
        "session_speakers_participant_retention_no_pii_update",
        "event_speaker_workflow_session_insert",
        "event_speaker_workflow_session_participation_update",
        "prevent_referenced_public_speaker_relationship_visibility_change",
        "prevent_referenced_public_speaker_relationship_delete",
        "session_speakers_identity_immutable",
    }
    triggers = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'session_speakers'"
        )
    }
    missing = required_triggers - triggers
    if missing:
        raise SystemExit(
            f"Migration 0050 did not restore session-speaker triggers: {sorted(missing)}"
        )

    stale_schema_references = connection.execute(
        """
        SELECT type, name FROM sqlite_master
         WHERE sql LIKE '%session_speakers_before_decision%'
         ORDER BY type, name
        """
    ).fetchall()
    if stale_schema_references:
        raise SystemExit(
            "Migration 0050 left schema objects targeting its temporary table: "
            f"{stale_schema_references}"
        )

    def must_fail(statement: str, message: str) -> None:
        try:
            connection.execute(statement)
        except sqlite3.IntegrityError:
            return
        raise SystemExit(message)

    must_fail(
        "UPDATE session_speakers SET participation_status = 'declined', participation_revision = 2, participation_declined_at = 1, participation_decline_reason = '' WHERE session_id = 'participation-session'",
        "Migration 0050 accepted an empty decline reason",
    )
    must_fail(
        "UPDATE session_speakers SET participation_status = 'declined', participation_revision = 2, participation_declined_at = 1, participation_decline_reason = ' padded ' WHERE session_id = 'participation-session'",
        "Migration 0050 accepted an untrimmed decline reason",
    )
    connection.execute(
        """
        UPDATE session_speakers
           SET participation_status = 'declined', participation_revision = 2,
               participation_confirmed_at = NULL, participation_declined_at = 1,
               participation_decline_reason = 'Unavailable'
         WHERE session_id = 'participation-session'
        """
    )
    connection.execute(
        """
        UPDATE session_speakers
           SET participation_status = 'pending', participation_revision = 3,
               participation_confirmed_at = NULL, participation_declined_at = NULL,
               participation_decline_reason = NULL
         WHERE session_id = 'participation-session'
        """
    )
    connection.execute(
        """
        UPDATE session_speakers
           SET participation_status = 'confirmed', participation_revision = 4,
               participation_confirmed_at = 2, participation_declined_at = NULL,
               participation_decline_reason = NULL
         WHERE session_id = 'participation-session'
        """
    )
    workflow = connection.execute(
        """
        SELECT status FROM event_speaker_workflows
         WHERE event_id = 'participation-event'
           AND person_id = 'participation-person'
        """
    ).fetchone()
    if workflow != ("confirmed",):
        raise SystemExit("Migration 0050 did not restore speaker-workflow promotion")

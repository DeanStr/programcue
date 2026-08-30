from pathlib import Path
import sqlite3


MIGRATION = "0055_participant_operations_depth.sql"


def validate_participant_operations_depth_forward_migration(root: Path) -> None:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())

    connection.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('participant-depth-org', 'Participant depth org', 'participant-depth-org');
        INSERT INTO people (id, email, display_name)
        VALUES
          ('participant-depth-admin', 'admin-depth@example.test', 'Depth admin'),
          ('participant-depth-speaker', 'speaker-depth@example.test', 'Depth speaker'),
          ('participant-depth-trigger-speaker', 'trigger-speaker-depth@example.test', 'Trigger speaker');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'participant-depth-event', 'participant-depth-org', 'Participant depth event',
          'participant-depth-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes
        ) VALUES (
          'participant-depth-session', 'participant-depth-event', 'Depth session',
          'participant-depth-session', 'presentation', 30
        );
        """
    )
    connection.execute(
        """
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label,
          participation_status, visibility
        ) VALUES (?, ?, ?, 0, ?, 'pending', 'public')
        """,
        (
            "participant-depth-session",
            "participant-depth-event",
            "participant-depth-speaker",
            "Legacy role " + ("x" * 67) + " " + ("y" * 20),
        ),
    )

    connection.executescript(root.joinpath("migrations", MIGRATION).read_text())

    role = connection.execute(
        """
        SELECT label, length(label)
          FROM session_participant_roles
         WHERE session_id = 'participant-depth-session'
           AND person_id = 'participant-depth-speaker'
        """
    ).fetchone()
    expected_label = "Legacy role " + ("x" * 67)
    if role != (expected_label, len(expected_label)):
        raise SystemExit(
            "Migration 0055 did not trim a truncated legacy role label"
        )

    connection.execute(
        """
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label,
          participation_status, visibility
        ) VALUES (?, ?, ?, 1, ?, 'pending', 'public')
        """,
        (
            "participant-depth-session",
            "participant-depth-event",
            "participant-depth-trigger-speaker",
            "Legacy role " + ("x" * 67) + " " + ("y" * 20),
        ),
    )
    triggered_role = connection.execute(
        """
        SELECT label, length(label)
          FROM session_participant_roles
         WHERE session_id = 'participant-depth-session'
           AND person_id = 'participant-depth-trigger-speaker'
        """
    ).fetchone()
    if triggered_role != (expected_label, len(expected_label)):
        raise SystemExit(
            "Migration 0055 did not trim a truncated default role label"
        )

    connection.executescript(
        """
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, accepted_at, created_at
        ) VALUES (
          'participant-depth-membership', 'participant-depth-org',
          'participant-depth-event', 'participant-depth-speaker', 'speaker',
          unixepoch(), unixepoch(), unixepoch()
        );
        INSERT INTO event_field_definitions (
          id, event_id, owner_type, field_key, label, field_type,
          participant_access, created_by_person_id, updated_by_person_id
        ) VALUES (
          'participant-depth-field', 'participant-depth-event', 'person',
          'depth_note', 'Depth note', 'short_text', 'editable',
          'participant-depth-admin', 'participant-depth-admin'
        );
        INSERT INTO event_field_values (
          definition_id, event_id, person_id, value_json, revision,
          updated_by_person_id, updated_at
        ) VALUES (
          'participant-depth-field', 'participant-depth-event',
          'participant-depth-speaker', '"first"', 1,
          'participant-depth-admin', 0
        );
        """
    )
    try:
        connection.execute(
            """
            UPDATE event_field_values
               SET value_json = '"stale"', revision = 2, updated_at = 0
             WHERE definition_id = 'participant-depth-field'
               AND person_id = 'participant-depth-speaker'
            """
        )
    except sqlite3.IntegrityError as error:
        if "event field value revision conflict" not in str(error):
            raise
    else:
        raise SystemExit("Migration 0055 accepted a stale event-field revision")

from pathlib import Path
import sqlite3


def validate_approved_publication_boundary_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0021_require_approved_public_content.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('approval-boundary-org', 'Approval boundary organisation',
                'approval-boundary-organisation');
        INSERT INTO people (id, email, display_name)
        VALUES ('approval-boundary-owner', 'approval-owner@example.test',
                'Approval owner');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'approval-boundary-event', 'approval-boundary-org',
          'Approval boundary event', 'approval-boundary-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO rooms (id, event_id, name, position, capacity)
        VALUES ('approval-room', 'approval-boundary-event', 'Approval room', 0, 100);
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, visibility,
          status, required_resources_json
        ) VALUES (
          'approval-session', 'approval-boundary-event', 'Approval session',
          'approval-session', 'talk', 30, 'public', 'published', '[]'
        );
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id,
          published_at
        ) VALUES (
          'advisory-live-version', 'approval-boundary-event', 1, 'published',
          'approval-boundary-owner', 150
        );
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES (
          'advisory-live-entry', 'approval-boundary-event',
          'advisory-live-version', 'approval-session', 'approval-room', 110, 140
        );
        UPDATE schedule_session_contents
           SET content_status = 'in_review', approved_by_person_id = NULL,
               approved_at = NULL, approval_source = NULL
         WHERE schedule_version_id = 'advisory-live-version'
           AND session_id = 'approval-session';
        """
    )
    deployed.executescript(
        root.joinpath(
            "migrations/0021_require_approved_public_content.sql"
        ).read_text()
    )
    approval = deployed.execute(
        """
        SELECT content_status, approved_by_person_id, approved_at,
               approval_source
          FROM schedule_session_contents
         WHERE schedule_version_id = 'advisory-live-version'
           AND session_id = 'approval-session'
        """
    ).fetchone()
    if approval != ("approved", None, 150, "legacy_publication"):
        raise SystemExit(
            "Former advisory public content was not retained as legacy approval"
        )

    deployed.executescript(
        """
        UPDATE schedule_versions SET status = 'archived'
         WHERE id = 'advisory-live-version';
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id
        ) VALUES (
          'unapproved-draft-version', 'approval-boundary-event', 2, 'draft',
          'approval-boundary-owner'
        );
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES (
          'unapproved-draft-entry', 'approval-boundary-event',
          'unapproved-draft-version', 'approval-session', 'approval-room', 110, 140
        );
        UPDATE schedule_session_contents
           SET content_status = 'in_review', approved_by_person_id = NULL,
               approved_at = NULL, approval_source = NULL
         WHERE schedule_version_id = 'unapproved-draft-version'
           AND session_id = 'approval-session';
        """
    )
    try:
        deployed.execute(
            """
            UPDATE schedule_versions
               SET status = 'published', published_at = 160
             WHERE id = 'unapproved-draft-version'
            """
        )
    except sqlite3.IntegrityError as error:
        if "public schedule content must be approved" not in str(error):
            raise
    else:
        raise SystemExit("An unapproved public schedule snapshot was published")

    deployed.execute(
        """
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id,
          published_at
        ) VALUES (
          'direct-published-version', 'approval-boundary-event', 3,
          'published', 'approval-boundary-owner', 170
        )
        """
    )
    try:
        deployed.execute(
            """
            INSERT INTO schedule_entries (
              id, event_id, schedule_version_id, session_id, room_id,
              starts_at, ends_at
            ) VALUES (
              'direct-unapproved-entry', 'approval-boundary-event',
              'direct-published-version', 'approval-session', 'approval-room',
              110, 140
            )
            """
        )
    except sqlite3.IntegrityError as error:
        if "public schedule content must be approved" not in str(error):
            raise
    else:
        raise SystemExit(
            "A direct published schedule insert accepted an unapproved entry"
        )

    deployed.execute(
        """
        UPDATE schedule_session_contents
           SET content_status = 'approved',
               approved_by_person_id = 'approval-boundary-owner',
               approved_at = 170, approval_source = 'editorial'
         WHERE schedule_version_id = 'direct-published-version'
           AND session_id = 'approval-session'
        """
    )
    deployed.execute(
        """
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES (
          'direct-approved-entry', 'approval-boundary-event',
          'direct-published-version', 'approval-session', 'approval-room',
          110, 140
        )
        """
    )

    for statement, message in (
        (
            """
            UPDATE schedule_session_contents
               SET content_status = 'in_review',
                   approved_by_person_id = NULL, approved_at = NULL,
                   approval_source = NULL
             WHERE schedule_version_id = 'direct-published-version'
               AND session_id = 'approval-session'
            """,
            "Published public content was allowed to lose approval",
        ),
        (
            """
            UPDATE schedule_session_contents SET visibility = 'private'
             WHERE schedule_version_id = 'direct-published-version'
               AND session_id = 'approval-session'
            """,
            "Published public content was allowed to become private",
        ),
        (
            """
            DELETE FROM schedule_session_contents
             WHERE schedule_version_id = 'direct-published-version'
               AND session_id = 'approval-session'
            """,
            "Published public content was allowed to be deleted",
        ),
    ):
        try:
            deployed.execute(statement)
        except sqlite3.IntegrityError:
            pass
        else:
            raise SystemExit(message)

    deployed.executescript(
        """
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, visibility,
          status, required_resources_json
        ) VALUES
          ('approval-second-session', 'approval-boundary-event',
           'Second approval session', 'second-approval-session', 'talk', 30,
           'public', 'published', '[]'),
          ('approval-private-session', 'approval-boundary-event',
           'Private approval session', 'private-approval-session', 'talk', 30,
           'private', 'published', '[]');
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES
          ('draft-second-entry', 'approval-boundary-event',
           'unapproved-draft-version', 'approval-second-session',
           'approval-room', 150, 180),
          ('direct-private-entry', 'approval-boundary-event',
           'direct-published-version', 'approval-private-session',
           'approval-room', 150, 180);
        """
    )
    try:
        deployed.execute(
            """
            UPDATE schedule_entries
               SET schedule_version_id = 'direct-published-version'
             WHERE id = 'draft-second-entry'
            """
        )
    except sqlite3.IntegrityError as error:
        if "public schedule content must be approved" not in str(error):
            raise
    else:
        raise SystemExit(
            "An existing entry moved into a published schedule without approved content"
        )

    try:
        deployed.execute(
            """
            UPDATE sessions SET visibility = 'public'
             WHERE id = 'approval-private-session'
            """
        )
    except sqlite3.IntegrityError as error:
        if "public schedule content must be approved" not in str(error):
            raise
    else:
        raise SystemExit(
            "A scheduled private session became public without approved content"
        )

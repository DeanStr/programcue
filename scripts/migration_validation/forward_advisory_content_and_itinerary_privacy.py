from pathlib import Path
import sqlite3


def validate_advisory_content_and_itinerary_privacy_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0013_advisory_content_and_itinerary_privacy.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('advisory-org', 'Advisory organisation', 'advisory-organisation');
        INSERT INTO people (id, email, display_name)
        VALUES
          ('legacy-publisher', 'legacy-publisher@example.test', 'Legacy publisher'),
          ('editorial-reviewer', 'editorial-reviewer@example.test', 'Editorial reviewer');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'advisory-event', 'advisory-org', 'Advisory event',
          'advisory-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, visibility,
          status, required_resources_json
        ) VALUES
          ('legacy-approved-session', 'advisory-event', 'Legacy approved',
           'legacy-approved', 'talk', 30, 'public', 'published', '[]'),
          ('editorial-approved-session', 'advisory-event', 'Editorial approved',
           'editorial-approved', 'talk', 30, 'public', 'published', '[]'),
          ('stale-approval-session', 'advisory-event', 'Stale approval',
           'stale-approval', 'talk', 30, 'public', 'published', '[]');
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id,
          published_at
        ) VALUES (
          'advisory-published-version', 'advisory-event', 1, 'published',
          'legacy-publisher', 150
        );
        UPDATE schedule_session_contents
           SET content_status = 'approved', approved_by_person_id = 'legacy-publisher',
               approved_at = 150
         WHERE schedule_version_id = 'advisory-published-version';
        UPDATE schedule_session_contents
           SET content_revision = 2,
               approved_by_person_id = 'editorial-reviewer', approved_at = 160
         WHERE schedule_version_id = 'advisory-published-version'
           AND session_id = 'editorial-approved-session';
        INSERT INTO session_content_revisions (
          id, event_id, schedule_version_id, session_id, revision_number,
          title, slug, description, track_id, format, duration_minutes,
          required_resources_json, visibility, content_status, change_kind,
          created_by_person_id, created_at
        )
        SELECT 'stale-editorial-approval', event_id, schedule_version_id,
               session_id, 2, title, slug, description, track_id, format,
               duration_minutes, required_resources_json, visibility,
               'approved', 'status', 'editorial-reviewer', 140
          FROM schedule_session_contents
         WHERE schedule_version_id = 'advisory-published-version'
           AND session_id = 'stale-approval-session';
        INSERT INTO session_content_revisions (
          id, event_id, schedule_version_id, session_id, revision_number,
          title, slug, description, track_id, format, duration_minutes,
          required_resources_json, visibility, content_status, change_kind,
          created_by_person_id, created_at
        )
        SELECT 'explicit-editorial-approval', event_id, schedule_version_id,
               session_id, 2, title, slug, description, track_id, format,
               duration_minutes, required_resources_json, visibility,
               'approved', 'status', 'editorial-reviewer', 161
          FROM schedule_session_contents
         WHERE schedule_version_id = 'advisory-published-version'
           AND session_id = 'editorial-approved-session';
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id
        ) VALUES (
          'cross-version-approval', 'advisory-event', 99, 'archived',
          'legacy-publisher'
        );
        DELETE FROM session_content_revisions
         WHERE schedule_version_id = 'cross-version-approval'
           AND session_id = 'legacy-approved-session';
        INSERT INTO session_content_revisions (
          id, event_id, schedule_version_id, session_id, revision_number,
          title, slug, description, track_id, format, duration_minutes,
          required_resources_json, visibility, content_status, change_kind,
          created_by_person_id, created_at
        )
        SELECT 'different-version-editorial-approval', event_id,
               schedule_version_id, session_id, 1, title, slug, description,
               track_id, format, duration_minutes, required_resources_json,
               visibility, 'approved', 'status', 'legacy-publisher', 150
          FROM schedule_session_contents
         WHERE schedule_version_id = 'cross-version-approval'
           AND session_id = 'legacy-approved-session';
        INSERT INTO public_itineraries (
          id, event_id, visitor_key_hash, expires_at
        ) VALUES ('legacy-anonymous-itinerary', 'advisory-event', 'shared-browser-hash', 300);
        INSERT INTO public_itineraries (
          id, event_id, person_id, expires_at
        ) VALUES ('signed-in-itinerary', 'advisory-event', 'editorial-reviewer', 300);
        """
    )
    deployed.executescript(
        root.joinpath(
            "migrations/0013_advisory_content_and_itinerary_privacy.sql"
        ).read_text()
    )
    approvals = deployed.execute(
        """
        SELECT session_id, approval_source, approved_by_person_id
          FROM schedule_session_contents
         WHERE schedule_version_id = 'advisory-published-version'
         ORDER BY session_id
        """
    ).fetchall()
    if approvals != [
        ("editorial-approved-session", "editorial", "editorial-reviewer"),
        ("legacy-approved-session", "legacy_publication", None),
        ("stale-approval-session", "legacy_publication", None),
    ]:
        raise SystemExit(
            "Advisory content migration did not preserve honest approval provenance"
        )
    if deployed.execute(
        "SELECT id FROM public_itineraries ORDER BY id"
    ).fetchall() != [("signed-in-itinerary",)]:
        raise SystemExit(
            "Itinerary privacy migration did not remove only legacy anonymous identifiers"
        )
    deployed.execute(
        """
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, created_by_person_id
        ) VALUES ('advisory-draft-version', 'advisory-event', 2, 'draft',
                  'editorial-reviewer')
        """
    )
    inherited = deployed.execute(
        """
        SELECT session_id, approval_source, approved_by_person_id
          FROM schedule_session_contents
         WHERE schedule_version_id = 'advisory-draft-version'
         ORDER BY session_id
        """
    ).fetchall()
    if inherited != approvals:
        raise SystemExit(
            "New draft content did not retain the published approval provenance"
        )
    try:
        deployed.execute(
            """
            UPDATE schedule_session_contents
               SET approval_source = 'editorial'
             WHERE schedule_version_id = 'advisory-draft-version'
               AND session_id = 'legacy-approved-session'
            """
        )
    except sqlite3.IntegrityError as error:
        if "schedule content approval provenance is inconsistent" not in str(error):
            raise
    else:
        raise SystemExit(
            "An editorial approval without an attributed approver was accepted"
        )

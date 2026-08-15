from pathlib import Path
import sqlite3


def validate_canonical_demo_dates_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0015_canonical_demo_dates.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('org-future-events', 'Future Events Association', 'future-events-association');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
           'evt-foe-2025', 'org-future-events', 'Future of Events 2025',
          'future-of-events-2025', 'America/Toronto',
          unixepoch('2025-05-20T00:00:00Z'),
          unixepoch('2025-05-22T23:59:59Z'),
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO form_definitions (
          id, event_id, name, kind, status, public_slug, closes_at
        ) VALUES (
          'demo-form', 'evt-foe-2025', 'Call for proposals', 'submission',
          'published', 'form', NULL
        );
        INSERT INTO form_versions (
          id, event_id, form_id, version_number, schema_json,
          settings_snapshot_json, status, published_at
        ) VALUES (
          'demo-form-version', 'evt-foe-2025', 'demo-form', 1, '{}',
          '{"closesAt":null}', 'published', unixepoch('2025-05-01T12:00:00Z')
        );
        INSERT INTO rooms (id, event_id, name, capacity)
        VALUES ('main', 'evt-foe-2025', 'Main room', 500);
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status
        ) VALUES
          ('demo-session-1', 'evt-foe-2025', 'Session 1', 'session-1', 'presentation', 45, 'published'),
          ('demo-session-2', 'evt-foe-2025', 'Session 2', 'session-2', 'presentation', 60, 'published'),
          ('demo-session-3', 'evt-foe-2025', 'Session 3', 'session-3', 'workshop', 60, 'published'),
          ('demo-session-4', 'evt-foe-2025', 'Session 4', 'session-4', 'panel', 45, 'published'),
          ('demo-session-5', 'evt-foe-2025', 'Session 5', 'session-5', 'breakout', 60, 'published');
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, published_at
        ) VALUES (
          'demo-schedule-published', 'evt-foe-2025', 1, 'published',
          unixepoch('2025-05-01T12:00:00Z')
        );
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES
          ('demo-entry-1', 'evt-foe-2025', 'demo-schedule-published', 'demo-session-1', 'main', unixepoch('2025-05-20T13:00:00Z'), unixepoch('2025-05-20T13:45:00Z')),
          ('demo-entry-2', 'evt-foe-2025', 'demo-schedule-published', 'demo-session-2', 'main', unixepoch('2025-05-20T14:00:00Z'), unixepoch('2025-05-20T15:00:00Z')),
          ('demo-entry-3', 'evt-foe-2025', 'demo-schedule-published', 'demo-session-3', 'main', unixepoch('2025-05-20T15:15:00Z'), unixepoch('2025-05-20T16:15:00Z')),
          ('demo-entry-4', 'evt-foe-2025', 'demo-schedule-published', 'demo-session-4', 'main', unixepoch('2025-05-21T13:30:00Z'), unixepoch('2025-05-21T14:15:00Z')),
          ('demo-entry-5', 'evt-foe-2025', 'demo-schedule-published', 'demo-session-5', 'main', unixepoch('2025-05-21T17:00:00Z'), unixepoch('2025-05-21T18:00:00Z'));
        UPDATE schedule_versions
           SET status = 'archived'
         WHERE id = 'demo-schedule-published';
        INSERT INTO schedule_versions (
          id, event_id, version_number, status, published_at
        ) VALUES (
          'evaluation-schedule-published', 'evt-foe-2025', 2, 'published',
          unixepoch('2025-05-02T12:00:00Z')
        );
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at
        ) VALUES (
          'evaluation-generated-entry', 'evt-foe-2025',
          'evaluation-schedule-published', 'demo-session-1', 'main',
          unixepoch('2025-05-20T11:00:00Z'),
          unixepoch('2025-05-20T12:00:00Z')
        );
        INSERT INTO task_templates (
          id, event_id, name, target_type, task_type, impact, evidence_mode,
          due_anchor, fixed_due_at, auto_assign_on_acceptance
        ) VALUES
          ('task-template-profile', 'evt-foe-2025', 'Complete your speaker profile',
           'speaker', 'short_form', 'high', 'checkbox', 'fixed',
           unixepoch('2025-05-10T16:00:00Z'), 1),
          ('task-template-slides', 'evt-foe-2025', 'Upload presentation slides',
           'speaker', 'file_upload', 'critical', 'file', 'fixed',
           unixepoch('2025-05-10T16:00:00Z'), 1),
          ('task-template-handbook', 'evt-foe-2025', 'Read the speaker handbook',
           'speaker', 'acknowledgement', 'medium', 'checkbox', 'fixed',
           unixepoch('2025-05-12T16:00:00Z'), 1);
        INSERT INTO task_instances (
          id, event_id, template_id, target_type, target_id, title, task_type,
          impact, status, readiness_state, readiness_percent, due_at
        ) VALUES
          ('task-demo-profile', 'evt-foe-2025', 'task-template-profile', 'speaker', 'person-demo-speaker', 'Complete your speaker profile', 'short_form', 'high', 'completed', 'on_track', 100, unixepoch('2025-05-10T16:00:00Z')),
          ('task-demo-slides', 'evt-foe-2025', 'task-template-slides', 'speaker', 'person-demo-speaker', 'Upload presentation slides', 'file_upload', 'critical', 'not_started', 'at_risk', 0, unixepoch('2025-05-16T16:00:00Z')),
          ('task-demo-handbook', 'evt-foe-2025', 'task-template-handbook', 'speaker', 'person-demo-speaker', 'Read the speaker handbook', 'acknowledgement', 'medium', 'not_started', 'on_track', 0, unixepoch('2025-05-12T16:00:00Z'));
        """
    )
    deployed.executescript(
        root.joinpath("migrations/0015_canonical_demo_dates.sql").read_text()
    )
    event = deployed.execute(
        """
        SELECT name, datetime(starts_at, 'unixepoch'), datetime(ends_at, 'unixepoch')
          FROM events
         WHERE id = 'evt-foe-2025'
        """
    ).fetchone()
    if event != (
        "Future of Events 2027",
        "2027-05-20 00:00:00",
        "2027-05-22 23:59:59",
    ):
        raise SystemExit("The existing canonical demo event dates were not migrated")
    schedule = deployed.execute(
        """
        SELECT id, datetime(starts_at, 'unixepoch'), datetime(ends_at, 'unixepoch')
          FROM schedule_entries
         WHERE schedule_version_id = 'demo-schedule-published'
         ORDER BY id
        """
    ).fetchall()
    if schedule != [
        ("demo-entry-1", "2027-05-20 13:00:00", "2027-05-20 13:45:00"),
        ("demo-entry-2", "2027-05-20 14:00:00", "2027-05-20 15:00:00"),
        ("demo-entry-3", "2027-05-20 15:15:00", "2027-05-20 16:15:00"),
        ("demo-entry-4", "2027-05-21 13:30:00", "2027-05-21 14:15:00"),
        ("demo-entry-5", "2027-05-21 17:00:00", "2027-05-21 18:00:00"),
    ]:
        raise SystemExit("The existing canonical demo schedule was not migrated")
    generated_entry_before_followup = deployed.execute(
        """
        SELECT datetime(starts_at, 'unixepoch'), datetime(ends_at, 'unixepoch')
          FROM schedule_entries
         WHERE id = 'evaluation-generated-entry'
        """
    ).fetchone()
    if generated_entry_before_followup != (
        "2025-05-20 11:00:00",
        "2025-05-20 12:00:00",
    ):
        raise SystemExit(
            "The forward-migration fixture no longer represents a generated published entry"
        )
    deployed.executescript(
        root.joinpath(
            "migrations/0016_canonical_fixture_schedule_dates.sql"
        ).read_text()
    )
    generated_entry = deployed.execute(
        """
        SELECT datetime(starts_at, 'unixepoch'), datetime(ends_at, 'unixepoch')
          FROM schedule_entries
         WHERE id = 'evaluation-generated-entry'
        """
    ).fetchone()
    if generated_entry != ("2027-05-20 11:00:00", "2027-05-20 12:00:00"):
        raise SystemExit(
            "The generated canonical fixture schedule entry was not migrated"
        )
    slug_migration = root.joinpath(
        "migrations/0017_canonical_fixture_slug.sql"
    ).read_text()
    deployed.execute(
        "UPDATE events SET slug = 'unexpected-fixture-slug' WHERE id = 'evt-foe-2025'"
    )
    try:
        deployed.executescript(slug_migration)
    except sqlite3.IntegrityError as error:
        if "people.email" not in str(error):
            raise
    else:
        raise SystemExit(
            "The canonical fixture slug migration silently accepted unexpected drift"
        )
    deployed.execute(
        "UPDATE events SET slug = 'future-of-events-2025' WHERE id = 'evt-foe-2025'"
    )
    deployed.executescript(slug_migration)
    # Already-correct deployments are valid; only an unexpected third value is drift.
    deployed.executescript(slug_migration)
    slug = deployed.execute(
        "SELECT slug FROM events WHERE id = 'evt-foe-2025'"
    ).fetchone()
    if slug != ("future-of-events-2027",):
        raise SystemExit("The canonical fixture public slug was not migrated")
    deadline = deployed.execute(
        """
        SELECT datetime(form.closes_at, 'unixepoch'),
               datetime(json_extract(version.settings_snapshot_json, '$.closesAt'), 'unixepoch')
          FROM form_definitions form
          JOIN form_versions version ON version.form_id = form.id
         WHERE form.event_id = 'evt-foe-2025' AND form.public_slug = 'form'
        """
    ).fetchone()
    if deadline != ("2027-05-01 03:59:59", "2027-05-01 03:59:59"):
        raise SystemExit("The existing canonical demo application deadline was not migrated")
    speaker_dates = deployed.execute(
        """
        SELECT
          datetime((SELECT fixed_due_at FROM task_templates WHERE id = 'task-template-profile'), 'unixepoch'),
          datetime((SELECT fixed_due_at FROM task_templates WHERE id = 'task-template-slides'), 'unixepoch'),
          datetime((SELECT fixed_due_at FROM task_templates WHERE id = 'task-template-handbook'), 'unixepoch'),
          datetime((SELECT due_at FROM task_instances WHERE id = 'task-demo-profile'), 'unixepoch'),
          datetime((SELECT due_at FROM task_instances WHERE id = 'task-demo-slides'), 'unixepoch'),
          datetime((SELECT due_at FROM task_instances WHERE id = 'task-demo-handbook'), 'unixepoch')
        """
    ).fetchone()
    if speaker_dates != (
        "2027-05-10 16:00:00",
        "2027-05-10 16:00:00",
        "2027-05-12 16:00:00",
        "2027-05-10 16:00:00",
        "2027-05-16 16:00:00",
        "2027-05-12 16:00:00",
    ):
        raise SystemExit("The existing canonical demo speaker deadlines were not migrated")

    deployed.executescript(
        """
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status
        ) VALUES (
          'signed-itinerary-person', 'signed-itinerary@example.com',
          'Signed itinerary person', 1, 'published'
        );
        INSERT INTO public_itineraries (
          id, event_id, visitor_key_hash, created_at, updated_at
        ) VALUES (
          'anonymous-itinerary', 'evt-foe-2025', 'legacy-secret-hash', 1, 1
        );
        INSERT INTO public_itineraries (
          id, event_id, person_id, created_at, updated_at
        ) VALUES (
          'signed-itinerary', 'evt-foe-2025', 'signed-itinerary-person', 1, 1
        );
        INSERT INTO public_itineraries (
          id, event_id, visitor_key_hash, created_at, updated_at
        ) VALUES (
          'versioned-anonymous-itinerary', 'evt-foe-2025',
          'v2.fresh-secret-hash', 1, 1
        );
        INSERT INTO public_itinerary_items (itinerary_id, session_id, created_at)
        VALUES
          ('anonymous-itinerary', 'demo-session-1', 1),
          ('signed-itinerary', 'demo-session-1', 1),
          ('versioned-anonymous-itinerary', 'demo-session-1', 1);
        """
    )
    deployed.executescript(
        root.joinpath(
            "migrations/0018_anonymous_itinerary_secret_reset.sql"
        ).read_text()
    )
    itinerary_counts = deployed.execute(
        """
        SELECT
          (SELECT COUNT(*) FROM public_itineraries
            WHERE person_id IS NULL),
          (SELECT COUNT(*) FROM public_itineraries
            WHERE person_id = 'signed-itinerary-person'),
          (SELECT COUNT(*) FROM public_itinerary_items
            WHERE itinerary_id = 'anonymous-itinerary'),
          (SELECT COUNT(*) FROM public_itinerary_items
            WHERE itinerary_id = 'signed-itinerary'),
          (SELECT COUNT(*) FROM public_itineraries
            WHERE id = 'versioned-anonymous-itinerary'),
          (SELECT COUNT(*) FROM public_itinerary_items
            WHERE itinerary_id = 'versioned-anonymous-itinerary')
        """
    ).fetchone()
    if itinerary_counts != (1, 1, 0, 1, 1, 1):
        raise SystemExit(
            "The itinerary-secret reset did not remove only legacy anonymous itineraries"
        )

    deployed.executescript(
        """
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          profile_revision, last_operation_id, created_at, updated_at
        ) VALUES
          ('legacy-manual-actor', 'legacy-actor@example.com', 'Legacy actor',
           1, 'published', 1, NULL, 1, 1),
          ('legacy-manual-speaker', 'legacy-speaker@example.com',
           'Organiser supplied name', 0, 'draft', 1,
           'legacy-manual-command', 2, 2),
          ('participant-updated-speaker', 'participant-updated@example.com',
           'Participant supplied name', 1, 'published', 2,
           'participant-profile-command', 3, 3);
        UPDATE people
           SET biography = 'Organiser supplied biography',
               organisation_name = 'Organiser supplied company',
               job_title = 'Organiser supplied title'
         WHERE id = 'legacy-manual-speaker';
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) VALUES
          ('legacy-manual-audit', 'org-future-events', 'evt-foe-2025',
           'legacy-manual-actor', 'speaker.admin.added', 'person',
           'legacy-manual-speaker', 'legacy-manual-command',
           '{"createdIdentity":true,"createdRosterAssociation":true}', 2),
          ('participant-updated-audit', 'org-future-events', 'evt-foe-2025',
           'legacy-manual-actor', 'speaker.admin.added', 'person',
           'participant-updated-speaker', 'legacy-participant-command',
           '{"createdIdentity":true,"createdRosterAssociation":true}', 3);
        """
    )
    deployed.executescript(
        root.joinpath(
            "migrations/0019_manual_speaker_profile_ownership.sql"
        ).read_text()
    )
    migrated_manual_profile = deployed.execute(
        """
        SELECT person.display_name, person.biography,
               person.organisation_name, person.job_title,
               contact.source, contact.status,
               profile.display_name, profile.biography,
               profile.organisation_name, profile.job_title, profile.source
          FROM people person
          JOIN organisation_contacts contact
            ON contact.organisation_id = 'org-future-events'
           AND contact.person_id = person.id
          JOIN organisation_contact_profiles profile
            ON profile.organisation_id = contact.organisation_id
           AND profile.person_id = contact.person_id
         WHERE person.id = 'legacy-manual-speaker'
        """
    ).fetchone()
    if migrated_manual_profile != (
        "legacy-speaker@example.com",
        None,
        None,
        None,
        "manual",
        "active",
        "Organiser supplied name",
        "Organiser supplied biography",
        "Organiser supplied company",
        "Organiser supplied title",
        "manual",
    ):
        raise SystemExit(
            "The legacy manual-speaker profile was not moved to organisation scope"
        )
    participant_owned_profile = deployed.execute(
        """
        SELECT person.display_name,
               (SELECT COUNT(*) FROM organisation_contacts contact
                 WHERE contact.organisation_id = 'org-future-events'
                   AND contact.person_id = person.id)
          FROM people person
         WHERE person.id = 'participant-updated-speaker'
        """
    ).fetchone()
    if participant_owned_profile != ("Participant supplied name", 0):
        raise SystemExit(
            "The manual-speaker ownership migration changed a participant-owned profile"
        )

    manual_profile_migration = root.joinpath(
        "migrations/0019_manual_speaker_profile_ownership.sql"
    ).read_text()
    deployed.executescript(
        """
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          profile_revision, last_operation_id, created_at, updated_at
        ) VALUES (
          'merged-manual-speaker', 'merged-manual@example.com',
          'Organiser merged name', 0, 'draft', 1,
          'merged-manual-command', 4, 4
        );
        INSERT INTO organisation_contacts (
          organisation_id, person_id, source, status, merged_into_person_id,
          created_by_person_id, created_at, updated_at
        ) VALUES (
          'org-future-events', 'merged-manual-speaker', 'manual', 'merged',
          'legacy-manual-speaker', 'legacy-manual-actor', 4, 4
        );
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) VALUES (
          'merged-manual-audit', 'org-future-events', 'evt-foe-2025',
          'legacy-manual-actor', 'speaker.admin.added', 'person',
          'merged-manual-speaker', 'merged-manual-command',
          '{"createdIdentity":true,"createdRosterAssociation":true}', 4
        );
        """
    )
    try:
        deployed.executescript(manual_profile_migration)
    except sqlite3.IntegrityError as error:
        if "people.email" not in str(error):
            raise
    else:
        raise SystemExit(
            "The manual-speaker ownership migration silently skipped a merged exact-provenance candidate"
        )
    deployed.executescript(
        """
        DELETE FROM organisation_contacts
         WHERE organisation_id = 'org-future-events'
           AND person_id = 'merged-manual-speaker';
        DELETE FROM people WHERE id = 'merged-manual-speaker';

        INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          profile_revision, last_operation_id, created_at, updated_at
        ) VALUES (
          'invalid-manual-speaker', 'invalid-manual@example.com', 'X',
          0, 'draft', 1, 'invalid-manual-command', 5, 5
        );
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) VALUES (
          'invalid-manual-audit', 'org-future-events', 'evt-foe-2025',
          'legacy-manual-actor', 'speaker.admin.added', 'person',
          'invalid-manual-speaker', 'invalid-manual-command',
          '{"createdIdentity":true,"createdRosterAssociation":true}', 5
        );
        """
    )
    try:
        deployed.executescript(manual_profile_migration)
    except sqlite3.IntegrityError as error:
        if "length(trim(display_name)) BETWEEN 2 AND 120" not in str(error):
            raise
    else:
        raise SystemExit(
            "The manual-speaker ownership migration silently skipped invalid exact-provenance enrichment"
        )

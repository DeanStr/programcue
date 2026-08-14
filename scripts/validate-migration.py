from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parents[1]
migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
migration_numbers: dict[str, list[str]] = {}
for migration_path in migration_files:
    match = re.fullmatch(r"(\d{4})_[a-z0-9_]+\.sql", migration_path.name)
    if match is None:
        raise SystemExit(
            f"Migration filename must use NNNN_lowercase_name.sql: {migration_path.name}"
        )
    migration_numbers.setdefault(match.group(1), []).append(migration_path.name)
duplicate_migration_numbers = {
    number: names for number, names in migration_numbers.items() if len(names) > 1
}
if duplicate_migration_numbers:
    details = ", ".join(
        f"{number}: {', '.join(names)}"
        for number, names in sorted(duplicate_migration_numbers.items())
    )
    raise SystemExit(f"Migration numbers must be unique ({details})")
sql = "\n".join(path.read_text() for path in migration_files)
schema_source = root.joinpath("app/platform/database/schema.ts").read_text()

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(sql)


def validate_session_participation_forward_migration() -> None:
    migration = root.joinpath(
        "migrations/0008_session_speaker_participation.sql"
    ).read_text()
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    deployed.executescript(
        """
        CREATE TABLE people (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          source_submission_id TEXT,
          UNIQUE(id, event_id)
        );
        CREATE TABLE participant_retention_locked_events (
          event_id TEXT PRIMARY KEY
        );
        CREATE TABLE session_speakers (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          person_id TEXT NOT NULL REFERENCES people(id),
          position INTEGER NOT NULL CHECK (position >= 0),
          role_label TEXT,
          visibility TEXT NOT NULL DEFAULT 'public'
            CHECK (visibility IN ('public','private','hidden')),
          PRIMARY KEY (session_id, person_id),
          UNIQUE(session_id, position),
          FOREIGN KEY (session_id, event_id)
            REFERENCES sessions(id, event_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_session_speakers_person
          ON session_speakers(event_id, person_id);
        INSERT INTO people (id) VALUES ('legacy-speaker');
        INSERT INTO sessions (id, event_id)
          VALUES ('legacy-session', 'legacy-event');
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        ) VALUES (
          'legacy-session', 'legacy-event', 'legacy-speaker', 0,
          'Speaker', 'public'
        );
        """
    )
    deployed.executescript(migration)
    migrated = deployed.execute(
        """
        SELECT participation_status, participation_confirmed_at
          FROM session_speakers
         WHERE session_id = 'legacy-session'
           AND person_id = 'legacy-speaker'
        """
    ).fetchone()
    if migrated != ("pending", None):
        raise SystemExit(
            "Legacy session participation was not migrated to fail-closed pending state"
        )
    for status, confirmed_at in (("confirmed", None), ("pending", 1)):
        try:
            deployed.execute(
                """
                UPDATE session_speakers
                   SET participation_status = ?,
                       participation_confirmed_at = ?
                 WHERE session_id = 'legacy-session'
                   AND person_id = 'legacy-speaker'
                """,
                (status, confirmed_at),
            )
        except sqlite3.IntegrityError:
            continue
        raise SystemExit(
            "Session participation migration accepted an inconsistent confirmation"
        )


validate_session_participation_forward_migration()


def validate_speaker_workflow_forward_migration() -> None:
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0011_event_speaker_workflows.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('legacy-org', 'Legacy organisation', 'legacy-organisation');
        INSERT INTO people (id, email, display_name)
        VALUES ('legacy-invitee', 'legacy-invitee@example.test', 'Legacy invitee');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'legacy-event', 'legacy-org', 'Legacy event', 'legacy-event', 'UTC',
          100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at
        ) VALUES (
          'legacy-speaker-invitation', 'legacy-org', 'legacy-event',
          'legacy-invitee', 'speaker', 50, 150
        );
        """
    )
    deployed.executescript(
        root.joinpath("migrations/0011_event_speaker_workflows.sql").read_text()
    )
    workflow = deployed.execute(
        """
        SELECT status, source
          FROM event_speaker_workflows
         WHERE event_id = 'legacy-event' AND person_id = 'legacy-invitee'
        """
    ).fetchone()
    if workflow != ("invited", "backfill"):
        raise SystemExit(
            "Legacy pending speaker invitation was not migrated into the workflow roster"
        )


validate_speaker_workflow_forward_migration()


def validate_published_content_approval_forward_migration() -> None:
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


validate_published_content_approval_forward_migration()


def validate_advisory_content_and_itinerary_privacy_forward_migration() -> None:
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


validate_advisory_content_and_itinerary_privacy_forward_migration()


def validate_speaker_profile_depth_forward_migration() -> None:
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0014_speaker_profile_depth.sql":
            break
        deployed.executescript(path.read_text())
    deployed.execute(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, ?)",
        ("legacy-profile", "legacy-profile@example.test", "Legacy Profile"),
    )
    deployed.execute(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, ?)",
        (
            "cross-tenant-profile",
            "cross-tenant-profile@example.test",
            "Cross Tenant Profile",
        ),
    )
    deployed.execute(
        "INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)",
        ("legacy-profile-org", "Legacy Profile Org", "legacy-profile-org"),
    )
    deployed.execute(
        "INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)",
        ("other-profile-org", "Other Profile Org", "other-profile-org"),
    )
    deployed.execute(
        """
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, ?, ?, 'UTC', 1800000000, 1800086400, ?)
        """,
        (
            "legacy-profile-event",
            "legacy-profile-org",
            "Legacy Profile Event",
            "legacy-profile-event",
            '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}',
        ),
    )
    deployed.executescript(
        root.joinpath("migrations/0014_speaker_profile_depth.sql").read_text()
    )
    migrated = deployed.execute(
        """
        SELECT linkedin_url, x_handle
          FROM people WHERE id = 'legacy-profile'
        """
    ).fetchone()
    if migrated != (None, None):
        raise SystemExit(
            "Legacy speaker profiles were not migrated with empty public depth fields"
        )
    if "travel_preferences" in {
        row[1] for row in deployed.execute("PRAGMA table_info(people)")
    }:
        raise SystemExit("Private travel preferences were added to the global people table")
    deployed.execute(
        """
        INSERT INTO event_participant_profiles (
          event_id, organisation_id, person_id, travel_preferences,
          last_operation_id
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            "legacy-profile-event",
            "legacy-profile-org",
            "legacy-profile",
            "Step-free transport",
            "legacy-profile-operation",
        ),
    )
    try:
        deployed.execute(
            """
            INSERT INTO event_participant_profiles (
              event_id, organisation_id, person_id, travel_preferences,
              last_operation_id
            ) VALUES ('legacy-profile-event', 'other-profile-org',
                      'cross-tenant-profile', 'Cross-tenant value',
                      'cross-tenant-profile-operation')
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Event profile migration accepted a cross-tenant event/org pair")
    try:
        deployed.execute(
            """
            UPDATE event_participant_profiles SET travel_preferences = '   '
             WHERE event_id = 'legacy-profile-event'
               AND person_id = 'legacy-profile'
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Event profile migration accepted blank travel preferences")
    try:
        deployed.execute(
            "UPDATE people SET x_handle = 'invalid handle' WHERE id = 'legacy-profile'"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Speaker profile migration accepted an invalid X handle")


validate_speaker_profile_depth_forward_migration()

tables = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
}
required = {
    "organisations", "people", "organisation_ai_settings", "events", "event_participant_profiles", "memberships",
    "organisation_contacts", "organisation_contact_profiles", "organisation_contact_tags", "organisation_contact_notes",
    "crm_segments", "crm_pipeline_entries", "crm_pipeline_activity",
    "form_definitions", "form_versions", "submissions", "submission_revisions",
    "submission_track_selections", "submission_routing_teams",
    "submission_email_verifications", "submission_speakers",
    "evaluation_plans", "evaluation_teams", "evaluation_team_members", "evaluation_rounds",
    "evaluation_criteria", "evaluation_round_reviewers", "evaluator_conflicts", "evaluator_assignments", "reviews", "ai_review_assessments",
    "review_revisions", "review_moderations", "submission_decisions",
    "tracks", "rooms", "schedule_policies", "sessions", "session_speakers", "event_speaker_workflows",
    "tags", "session_tags", "session_archives",
    "schedule_versions", "schedule_session_contents", "session_content_revisions", "schedule_entries", "schedule_conflicts",
    "public_itineraries", "public_itinerary_items",
    "task_templates", "task_template_dependencies", "task_instances",
    "task_instance_dependencies", "task_comments", "task_evidence",
    "file_assets", "file_versions", "file_multipart_uploads", "resource_pages", "resource_page_versions",
    "resource_audiences", "resource_attachments", "resource_acknowledgements",
    "sender_profiles", "communication_templates", "communication_template_versions",
    "communication_triggers", "communications", "communication_deliveries",
    "communication_delivery_events", "communication_unsubscribes",
    "calendar_connections", "calendar_invitations", "calendar_sync_attempts",
    "integration_connections", "integration_runs", "integration_run_items", "integration_entity_mappings",
    "operation_jobs", "operation_items", "event_changes", "saved_views",
    "idempotency_records", "abuse_rate_limits", "webhook_endpoints", "webhook_deliveries",
    "webhook_delivery_attempts", "webhook_receipts", "audit_events",
    "assistant_proposal_executions",
    "auth_sessions", "auth_accounts", "verification_tokens", "api_keys",
}
if tables != required:
    raise SystemExit(
        f"Migration table mismatch; missing={sorted(required - tables)}, extra={sorted(tables - required)}"
    )

drizzle_tables = set(re.findall(r'sqliteTable\(\s*"([^"]+)"', schema_source))
if drizzle_tables != required:
    raise SystemExit(
        f"Drizzle table mismatch; missing={sorted(required - drizzle_tables)}, extra={sorted(drizzle_tables - required)}"
    )
if 'uniqueIndex("events_slug_unique").on(table.slug)' not in schema_source:
    raise SystemExit("Drizzle events.slug is not globally unique")


def columns(table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


for table, expected in {
    "people": {"linkedin_url", "x_handle", "profile_revision"},
    "event_participant_profiles": {"event_id", "organisation_id", "person_id", "travel_preferences", "last_operation_id"},
    "organisation_ai_settings": {"provider", "model", "revision", "last_updated_by_person_id", "last_operation_id"},
    "memberships": {"organisation_id", "event_id", "person_id", "role", "revoked_at"},
    "organisation_contacts": {"organisation_id", "person_id", "source", "status", "merged_into_person_id"},
    "organisation_contact_profiles": {"organisation_id", "person_id", "display_name", "biography", "organisation_name", "job_title", "source", "created_by_person_id", "updated_by_person_id", "last_operation_id"},
    "organisation_contact_notes": {"organisation_id", "person_id", "author_person_id", "body"},
    "crm_pipeline_entries": {"organisation_id", "person_id", "stage", "score", "rationale", "revision"},
    "crm_pipeline_activity": {"organisation_id", "pipeline_entry_id", "kind", "from_stage", "to_stage"},
    "form_versions": {"event_id", "schema_json", "routing_json", "settings_snapshot_json", "revision"},
    "submissions": {"submitted_snapshot_json", "revision", "last_operation_id"},
    "submission_track_selections": {"submission_id", "event_id", "track_id", "track_name_snapshot", "position"},
    "submission_routing_teams": {"submission_id", "event_id", "team_id"},
    "submission_decisions": {"notification_feedback_json", "effect_preview_json"},
    "submission_revisions": {"answers_json", "speaker_snapshot_json", "save_kind", "idempotency_key"},
    "submission_email_verifications": {"form_id", "token_hash", "status", "attempt_count", "verified_at", "consumed_at"},
    "submission_speakers": {"person_id", "email", "invitation_status", "claim_token_hash", "claimed_at"},
    "evaluation_rounds": {"plan_id", "round_number", "advancement_rule_json", "revision", "last_operation_id", "opens_at", "closes_at", "blinded_reviewing", "scorecard_id", "scorecard_version"},
    "evaluation_criteria": {"round_id", "input_type", "options_json", "weight_percent", "required"},
    "evaluation_round_reviewers": {"event_id", "round_id", "person_id", "added_by_person_id", "revision"},
    "evaluator_conflicts": {"round_id", "submission_id", "session_id", "evaluator_person_id"},
    "evaluator_assignments": {"round_id", "submission_id", "session_id", "session_snapshot_json", "team_id", "revision", "cancellation_reason", "due_at"},
    "reviews": {"status", "scores_json", "revision", "locked_at"},
    "ai_review_assessments": {"round_id", "submission_id", "scorecard_id", "scorecard_version", "round_revision", "score", "rationale", "provider", "model", "provider_response_id", "override_score", "override_rationale", "override_by_person_id", "override_at", "revision", "last_operation_id"},
    "file_versions": {"object_key", "upload_status", "signature_status", "scan_status", "released_at"},
    "file_multipart_uploads": {"version_id", "asset_id", "upload_id", "idempotency_key", "status", "manifest_json", "expires_at"},
    "schedule_policies": {"room_overlap_action", "speaker_overlap_action", "required_resource_overlap_action"},
    "session_speakers": {"participation_status", "participation_confirmed_at"},
    "rooms": {"status"},
    "tags": {"event_id", "name", "colour_token"},
    "session_archives": {"event_id", "previous_status", "archive_operation_id"},
    "schedule_versions": {"status", "revision", "notes"},
    "schedule_session_contents": {"schedule_version_id", "event_id", "session_id", "title", "slug", "description", "track_id", "format", "duration_minutes", "required_resources_json", "visibility", "content_status", "content_revision", "last_edited_by_person_id", "approved_by_person_id", "approved_at", "approval_source", "last_operation_id"},
    "session_content_revisions": {"event_id", "schedule_version_id", "session_id", "revision_number", "title", "description", "content_status", "change_kind", "restored_from_revision_id", "created_by_person_id"},
    "communications": {"idempotency_key", "content_snapshot_json", "recipient_count", "operation_id", "revision"},
    "calendar_invitations": {"ical_uid", "sequence_number", "method", "provider_event_id", "status"},
    "operation_jobs": {"correlation_id", "progress_total", "progress_completed", "progress_failed", "result_json", "claim_token", "claim_expires_at"},
    "abuse_rate_limits": {"scope_key", "window_started_at", "request_count", "blocked_until"},
    "integration_entity_mappings": {"connection_id", "entity_type", "entity_id", "external_id", "source_hash"},
    "integration_connections": {"event_id", "provider", "revision", "last_operation_id"},
    "webhook_deliveries": {"idempotency_key", "request_hash", "payload_json", "attempt_count", "next_attempt_at"},
    "assistant_proposal_executions": {"proposal_id", "organisation_id", "event_id", "actor_person_id", "tool_name", "status", "claim_token", "claim_expires_at", "result_json", "completed_at"},
}.items():
    absent = expected - columns(table)
    if absent:
        raise SystemExit(f"{table} missing columns: {sorted(absent)}")

indexes = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    )
}
drizzle_index_names = re.findall(r'(?:uniqueIndex|index)\(\s*"([^"]+)"\)', schema_source)
if len(drizzle_index_names) != len(set(drizzle_index_names)):
    duplicates = sorted({name for name in drizzle_index_names if drizzle_index_names.count(name) > 1})
    raise SystemExit(f"Drizzle schema contains duplicate index names: {duplicates}")

# Inline UNIQUE constraints become implementation-named sqlite_autoindex entries,
# so they cannot retain the corresponding Drizzle declaration name. Every
# explicitly named baseline index must still be represented in the Drizzle
# schema; Drizzle-only names are allowed for those inline UNIQUE constraints.
missing_drizzle_indexes = indexes - set(drizzle_index_names)
if missing_drizzle_indexes:
    raise SystemExit(
        f"Drizzle schema missing migration indexes: {sorted(missing_drizzle_indexes)}"
    )

required_indexes = {
    "idx_submissions_event_status", "idx_assignments_evaluator_status",
    "idx_schedule_session_contents_event", "idx_session_content_revisions_history", "idx_schedule_entries_room_time", "idx_schedule_conflicts_open", "ux_tags_event_name",
    "idx_tasks_event_status_due", "ux_task_instances_template_target", "ux_file_assets_logical_active", "idx_file_versions_release", "idx_file_multipart_status_expiry",
    "idx_deliveries_communication_status", "idx_calendar_invitation_status",
    "idx_operation_jobs_event_status", "idx_operation_items_status",
    "idx_event_changes_cursor", "idx_webhook_deliveries_status",
    "idx_audit_event_created",
    "idx_evaluation_rounds_schedule", "idx_evaluation_round_reviewers_round", "idx_evaluation_round_reviewers_person", "evaluation_criteria_position_unique", "idx_ai_review_assessments_round", "idx_ai_review_assessments_submission",
    "idx_organisation_contacts_status", "idx_organisation_contact_tags_tag",
    "idx_crm_pipeline_stage", "idx_crm_pipeline_activity_entry",
    "assistant_proposal_executions_claim_idx",
}
if required_indexes - indexes:
    raise SystemExit(f"Migration missing indexes: {sorted(required_indexes - indexes)}")

# Exercise the high-risk invariants instead of only checking names.
connection.executescript("""
INSERT INTO organisations (id,name,slug) VALUES ('org-a','A','a'),('org-b','B','b');
INSERT INTO people (id,email,display_name) VALUES ('person-a','a@example.test','A');
INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at,file_policy_json)
VALUES
  ('event-a','org-a','A','a','UTC',100,200,'{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'),
  ('event-b','org-b','B','b','UTC',100,200,'{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}');
INSERT INTO memberships (id,organisation_id,event_id,person_id,role)
VALUES ('member-a','org-a','event-a','person-a','committee_chair');
INSERT INTO file_assets (id,event_id,owner_person_id,target_type,target_id,asset_kind)
VALUES
  ('asset-a','event-a','person-a','person','person-a','headshot'),
  ('asset-b','event-a','person-a','resource','asset-b','resource_attachment');
INSERT INTO file_versions (
  id,event_id,asset_id,version_number,object_key,original_filename,
  declared_content_type,size_bytes
) VALUES ('version-a','event-a','asset-a',1,'version-a','a.jpg','image/jpeg',10);
INSERT INTO sessions (
  id,event_id,title,slug,format,duration_minutes,status,visibility
) VALUES ('session-a','event-a','Session A','session-a','presentation',30,'unscheduled','public');
INSERT INTO operation_jobs (
  id,organisation_id,event_id,type,idempotency_key,correlation_id,status,payload_json
) VALUES
  ('operation-a','org-a','event-a','test','operation-a-key','operation-a-correlation','completed','{}'),
  ('operation-b','org-b','event-b','test','operation-b-key','operation-b-correlation','completed','{}');
INSERT INTO tags (id,event_id,name,created_by_person_id)
VALUES ('tag-a','event-a','Featured','person-a');
INSERT INTO schedule_versions (id,event_id,version_number,status)
VALUES ('draft-a','event-a',1,'draft');
""")


def must_fail(statement: str, message: str) -> None:
    try:
        connection.execute(statement)
    except sqlite3.IntegrityError:
        return
    raise SystemExit(message)


must_fail(
    "INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at,file_policy_json) "
    "VALUES ('duplicate-event-slug','org-b','Duplicate','a','UTC',100,200,'{\"headshotMaximumBytes\":10485760,\"slidesMaximumBytes\":104857600,\"supportingDocumentMaximumBytes\":104857600,\"videoMaximumBytes\":1073741824}')",
    "A duplicate event slug was accepted across organisations",
)
must_fail(
    "INSERT INTO events "
    "(id,organisation_id,name,slug,timezone,starts_at,ends_at,repository_provider,file_policy_json) "
    "VALUES ('event-airtable-active','org-a','Bad Airtable event','bad-airtable-event','UTC',100,200,'airtable','{}')",
    "An Airtable event was allowed to activate without provisioning",
)
must_fail(
    "INSERT INTO memberships (id,organisation_id,event_id,person_id,role) "
    "VALUES ('cross-tenant','org-b','event-a','person-a','speaker')",
    "Cross-tenant membership was accepted",
)
must_fail(
    "INSERT INTO file_assets (id,event_id,owner_person_id,target_type,target_id,asset_kind) "
    "VALUES ('asset-duplicate','event-a','person-a','person','person-a','headshot')",
    "A duplicate active logical file asset was accepted",
)
must_fail(
    "INSERT INTO memberships (id,organisation_id,event_id,person_id,role) "
    "VALUES ('old-role','org-a','event-a','person-a','participant')",
    "Legacy participant role was accepted",
)
must_fail(
    "INSERT INTO rooms (id,event_id,name,capacity) "
    "VALUES ('room-without-capacity','event-a','Unknown capacity',NULL)",
    "A room without an explicit capacity was accepted",
)
must_fail(
    "INSERT INTO submissions "
    "(id,event_id,public_reference,title,status,answers_json,submitted_at) "
    "VALUES ('submitted-without-snapshot','event-a','PC-NO-SNAPSHOT','Missing snapshot','submitted','{}',unixepoch())",
    "A non-draft submission without an immutable submitted snapshot was accepted",
)
must_fail(
    "INSERT INTO file_versions "
    "(id,event_id,asset_id,version_number,object_key,original_filename,declared_content_type,size_bytes,released_at) "
    "VALUES ('unsafe-file','event-a','asset-a',1,'unsafe','unsafe.jpg','image/jpeg',10,unixepoch())",
    "An unvalidated/unscanned file version was released",
)
must_fail(
    "INSERT INTO operation_jobs "
    "(id,event_id,type,idempotency_key,correlation_id,status,payload_json,progress_total,progress_completed) "
    "VALUES ('bad-progress','event-a','test','key','correlation','running','{}',1,2)",
    "Invalid operation progress was accepted",
)
must_fail(
    "INSERT INTO file_multipart_uploads "
    "(version_id,event_id,asset_id,idempotency_key,part_size_bytes,expires_at) "
    "VALUES ('version-a','event-a','asset-b','mismatched-asset',5242880,unixepoch()+3600)",
    "A multipart upload was allowed to pair a version with the wrong asset",
)
must_fail(
    "INSERT INTO session_archives "
    "(session_id,event_id,previous_status,archived_by_person_id,archive_operation_id) "
    "VALUES ('session-a','event-a','unscheduled','person-a','operation-b')",
    "A session archive was allowed to cite an operation from another event",
)
must_fail(
    "INSERT INTO tags (id,event_id,name,created_by_person_id) "
    "VALUES ('tag-case-duplicate','event-a','featured','person-a')",
    "A case-only duplicate event tag was accepted",
)
must_fail(
    "INSERT INTO schedule_versions (id,event_id,version_number,status) "
    "VALUES ('draft-b','event-a',2,'draft')",
    "A second draft schedule version was accepted for one event",
)
must_fail(
    "INSERT INTO integration_connections "
    "(id,organisation_id,event_id,provider,status,direction) "
    "VALUES ('cross-tenant-integration','org-b','event-a','test','connected','outbound')",
    "A cross-tenant integration connection was accepted",
)
must_fail(
    "INSERT INTO calendar_connections "
    "(id,organisation_id,event_id,person_id,provider,account_reference,encrypted_credentials,scopes_json,status,expires_at) "
    "VALUES ('cross-tenant-calendar','org-b','event-a','person-a','google','account','sealed','[]','connected',unixepoch()+3600)",
    "A cross-tenant calendar connection was accepted",
)
must_fail(
    "INSERT INTO calendar_connections "
    "(id,organisation_id,event_id,person_id,provider,account_reference,scopes_json,status) "
    "VALUES ('missing-calendar-credentials','org-a','event-a','person-a','google','missing','[]','connected')",
    "A connected calendar account without durable credentials was accepted",
)
connection.execute(
    "INSERT INTO evaluation_plans (id,event_id,name,status) "
    "VALUES ('migration-evaluation-plan','event-a','Migration evaluation plan','draft')"
)
must_fail(
    "INSERT INTO evaluation_rounds "
    "(id,event_id,plan_id,round_number,name,status) "
    "VALUES ('missing-scorecard-round','event-a','migration-evaluation-plan',1,'Missing scorecard','draft')",
    "An evaluation round without a scorecard identity was accepted",
)
connection.execute(
    "INSERT INTO evaluation_rounds "
    "(id,event_id,plan_id,round_number,name,status,scorecard_id) "
    "VALUES ('dropdown-round','event-a','migration-evaluation-plan',1,'Dropdown round','draft','dropdown-scorecard')"
)
must_fail(
    "INSERT INTO evaluation_criteria "
    "(id,event_id,round_id,name,input_type,weight_percent,required,position) "
    "VALUES ('empty-dropdown','event-a','dropdown-round','Recommendation','dropdown',0,1,0)",
    "A dropdown criterion without persisted options was accepted",
)

connection.execute(
    "UPDATE events SET participant_retention_completed_at=unixepoch() WHERE id='event-a'"
)
must_fail(
    "UPDATE events SET participant_retention_completed_at=NULL WHERE id='event-a'",
    "The participant-retention completion tombstone was cleared",
)

connection.execute(
    "INSERT INTO audit_events (id,event_id,action,entity_type,metadata_json) "
    "VALUES ('audit-a','event-a','test','event','{}')"
)
must_fail("UPDATE audit_events SET action='changed' WHERE id='audit-a'", "Audit update was accepted")
must_fail("DELETE FROM audit_events WHERE id='audit-a'", "Audit delete was accepted")

foreign_key_errors = list(connection.execute("PRAGMA foreign_key_check"))
if foreign_key_errors:
    raise SystemExit(f"Foreign-key validation failed: {foreign_key_errors}")

triggers = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
required_triggers = {
    "audit_events_no_update",
    "audit_events_no_delete",
    "events_create_schedule_policy",
    "events_airtable_insert_requires_provisioning",
    "schedule_versions_seed_session_content",
    "sessions_seed_draft_schedule_content",
    "events_participant_retention_tombstone_immutable",
    "people_participant_retention_no_pii_update",
    "event_participant_profiles_retention_no_pii_insert",
    "event_participant_profiles_retention_no_pii_update",
    "event_participant_profiles_retention_no_pii_delete",
    "submission_revisions_participant_retention_no_pii_update",
    "review_revisions_participant_retention_no_pii_update",
    "communication_delivery_events_participant_retention_no_pii_update",
    "calendar_sync_attempts_participant_retention_no_pii_insert",
    "calendar_sync_attempts_participant_retention_no_pii_update",
    "schedule_session_contents_participant_retention_no_pii_insert",
    "schedule_session_contents_participant_retention_no_pii_update",
    "session_speakers_participant_retention_no_pii_insert",
    "session_speakers_participant_retention_no_pii_update",
    "evaluation_rounds_scorecard_id_required_insert",
    "evaluation_rounds_scorecard_id_required_update",
    "schedule_session_contents_approval_provenance_insert",
    "schedule_session_contents_approval_provenance_update",
}
if required_triggers - triggers:
    raise SystemExit(f"Migration triggers are missing: {sorted(required_triggers - triggers)}")
events_without_policy = connection.execute(
    "SELECT COUNT(*) FROM events e LEFT JOIN schedule_policies p ON p.event_id = e.id WHERE p.event_id IS NULL"
).fetchone()[0]
if events_without_policy:
    raise SystemExit("Event insertion did not provision its required schedule policy")

print(f"migration validated: {len(tables)} application tables, {len(indexes)} indexes, {len(triggers)} triggers")

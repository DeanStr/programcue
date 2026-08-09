from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parents[1]
sql = root.joinpath("migrations/0001_initial.sql").read_text()
schema_source = root.joinpath("app/platform/database/schema.ts").read_text()

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(sql)

tables = {
    row[0]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
}
required = {
    "organisations", "people", "events", "memberships",
    "form_definitions", "form_versions", "submissions", "submission_revisions",
    "submission_email_verifications", "submission_speakers",
    "evaluation_plans", "evaluation_teams", "evaluation_team_members", "evaluation_rounds",
    "evaluation_criteria", "evaluator_conflicts", "evaluator_assignments", "reviews",
    "review_revisions", "review_moderations", "submission_decisions",
    "tracks", "rooms", "schedule_policies", "sessions", "session_speakers",
    "schedule_versions", "schedule_entries", "schedule_conflicts",
    "public_itineraries", "public_itinerary_items",
    "task_templates", "task_template_dependencies", "task_instances",
    "task_instance_dependencies", "task_comments", "task_evidence",
    "file_assets", "file_versions", "resource_pages", "resource_page_versions",
    "resource_audiences", "resource_attachments", "resource_acknowledgements",
    "sender_profiles", "communication_templates", "communication_template_versions",
    "communication_triggers", "communications", "communication_deliveries",
    "communication_delivery_events", "communication_unsubscribes",
    "calendar_connections", "calendar_invitations", "calendar_sync_attempts",
    "integration_connections", "integration_runs", "integration_run_items",
    "operation_jobs", "operation_items", "event_changes", "saved_views",
    "idempotency_records", "webhook_endpoints", "webhook_deliveries",
    "webhook_delivery_attempts", "webhook_receipts", "audit_events",
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
    "memberships": {"organisation_id", "event_id", "person_id", "role", "revoked_at"},
    "form_versions": {"event_id", "schema_json", "routing_json", "settings_snapshot_json", "revision"},
    "submissions": {"submitted_snapshot_json", "revision", "last_operation_id"},
    "submission_revisions": {"answers_json", "speaker_snapshot_json", "save_kind", "idempotency_key"},
    "submission_email_verifications": {"form_id", "token_hash", "status", "attempt_count", "verified_at", "consumed_at"},
    "submission_speakers": {"person_id", "email", "invitation_status", "claim_token_hash", "claimed_at"},
    "evaluation_rounds": {"plan_id", "round_number", "advancement_rule_json", "revision"},
    "evaluation_criteria": {"round_id", "input_type", "weight_percent", "required"},
    "evaluator_assignments": {"round_id", "team_id", "revision", "due_at"},
    "reviews": {"status", "scores_json", "revision", "locked_at"},
    "file_versions": {"object_key", "upload_status", "signature_status", "scan_status", "released_at"},
    "schedule_policies": {"room_overlap_action", "speaker_overlap_action", "required_resource_overlap_action"},
    "rooms": {"status"},
    "communications": {"idempotency_key", "content_snapshot_json", "recipient_count", "operation_id"},
    "calendar_invitations": {"ical_uid", "sequence_number", "method", "provider_event_id", "status"},
    "operation_jobs": {"correlation_id", "progress_total", "progress_completed", "progress_failed", "result_json", "claim_token", "claim_expires_at"},
    "webhook_deliveries": {"idempotency_key", "payload_json", "attempt_count", "next_attempt_at"},
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
    "idx_schedule_entries_room_time", "idx_schedule_conflicts_open",
    "idx_tasks_event_status_due", "ux_task_instances_template_target", "ux_file_assets_logical_active", "idx_file_versions_release",
    "idx_deliveries_communication_status", "idx_calendar_invitation_status",
    "idx_operation_jobs_event_status", "idx_operation_items_status",
    "idx_event_changes_cursor", "idx_webhook_deliveries_status",
    "idx_audit_event_created",
}
if required_indexes - indexes:
    raise SystemExit(f"Migration missing indexes: {sorted(required_indexes - indexes)}")

# Exercise the high-risk invariants instead of only checking names.
connection.executescript("""
INSERT INTO organisations (id,name,slug) VALUES ('org-a','A','a'),('org-b','B','b');
INSERT INTO people (id,email,display_name) VALUES ('person-a','a@example.test','A');
INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at)
VALUES ('event-a','org-a','A','a','UTC',100,200),('event-b','org-b','B','b','UTC',100,200);
INSERT INTO memberships (id,organisation_id,event_id,person_id,role)
VALUES ('member-a','org-a','event-a','person-a','committee_chair');
INSERT INTO file_assets (id,event_id,owner_person_id,target_type,target_id,asset_kind)
VALUES ('asset-a','event-a','person-a','person','person-a','headshot');
""")


def must_fail(statement: str, message: str) -> None:
    try:
        connection.execute(statement)
    except sqlite3.IntegrityError:
        return
    raise SystemExit(message)


must_fail(
    "INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at) "
    "VALUES ('duplicate-event-slug','org-b','Duplicate','a','UTC',100,200)",
    "A duplicate event slug was accepted across organisations",
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
}
if required_triggers - triggers:
    raise SystemExit(f"Migration triggers are missing: {sorted(required_triggers - triggers)}")
events_without_policy = connection.execute(
    "SELECT COUNT(*) FROM events e LEFT JOIN schedule_policies p ON p.event_id = e.id WHERE p.event_id IS NULL"
).fetchone()[0]
if events_without_policy:
    raise SystemExit("Event insertion did not provision its required schedule policy")

print(f"migration validated: {len(tables)} application tables, {len(indexes)} indexes, {len(triggers)} triggers")

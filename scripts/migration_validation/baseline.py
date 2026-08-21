import re
import sqlite3


def validate_baseline(connection: sqlite3.Connection, schema_source: str) -> None:
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
        "evaluation_criteria", "evaluation_round_reviewers", "evaluator_conflicts", "evaluator_assignments", "reviews", "evaluation_discussion_messages", "ai_review_assessments", "event_ai_review_settings", "reviewer_ai_suggestions",
        "review_revisions", "review_moderations", "submission_decisions", "speaker_profile_revisions",
        "tracks", "rooms", "schedule_policies", "sessions", "session_speakers", "speaker_blackout_windows", "event_speaker_workflows",
        "tags", "session_tags", "session_archives",
        "schedule_versions", "schedule_session_contents", "session_content_revisions", "schedule_entries", "schedule_conflicts",
        "programme_embeds", "public_itineraries", "public_itinerary_items",
        "event_public_sites", "event_public_site_references", "event_site_sponsors", "event_session_recordings",
        "task_templates", "task_template_dependencies", "task_instances",
        "task_instance_dependencies", "task_comments", "task_evidence",
        "file_assets", "file_versions", "file_multipart_uploads", "event_brand_assets", "resource_pages", "resource_page_versions",
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
        "events": {"public_projection_revision", "brand_logo_asset_id", "brand_banner_asset_id", "brand_draft_accent", "brand_draft_logo_asset_id", "brand_draft_banner_asset_id", "brand_draft_welcome_text", "brand_draft_support_url", "brand_draft_revision", "brand_published_revision", "brand_published_at"},
        "event_brand_assets": {"organisation_id", "event_id", "kind", "object_key", "object_etag", "original_filename", "content_type", "size_bytes", "width_px", "height_px", "normalizer_version", "normalized_at", "created_by_person_id", "deleted_at", "cleanup_attempts", "cleanup_last_attempt_at", "cleanup_last_error"},
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
        "submission_email_verifications": {"form_id", "token_hash", "evaluation_generation_hash", "status", "attempt_count", "verified_at", "consumed_at"},
        "submission_speakers": {"person_id", "email", "invitation_status", "claim_token_hash", "claimed_at"},
        "task_instances": {"evidence_mode", "configuration_json"},
        "evaluation_rounds": {"plan_id", "round_number", "advancement_rule_json", "revision", "last_operation_id", "opens_at", "closes_at", "blinded_reviewing", "scorecard_id", "scorecard_version", "recommendation_choices_json"},
        "evaluation_criteria": {"round_id", "input_type", "options_json", "weight_percent", "required"},
        "evaluation_round_reviewers": {"event_id", "round_id", "person_id", "added_by_person_id", "revision"},
        "evaluator_conflicts": {"round_id", "submission_id", "session_id", "evaluator_person_id"},
        "evaluator_assignments": {"round_id", "submission_id", "session_id", "session_snapshot_json", "team_id", "revision", "cancellation_reason", "due_at"},
        "reviews": {"status", "scores_json", "recommendation", "recommendation_choices_snapshot_json", "revision", "locked_at", "ai_suggestion_id", "imported_criterion_ids_json", "confirmed_ai_criterion_ids_json"},
        "review_revisions": {"scorecard_id", "scorecard_version", "criteria_snapshot_json", "recommendation_choices_snapshot_json", "ai_suggestion_id", "imported_criterion_ids_json", "confirmed_ai_criterion_ids_json"},
        "speaker_profile_revisions": {"organisation_id", "event_id", "person_id", "source", "profile_revision", "display_name", "publication_status", "headshot_file_version_id", "recorded_by_person_id", "correlation_id"},
        "evaluation_discussion_messages": {"event_id", "round_id", "submission_id", "session_id", "author_person_id", "body", "idempotency_key"},
        "ai_review_assessments": {"round_id", "submission_id", "scorecard_id", "scorecard_version", "round_revision", "score", "rationale", "provider", "model", "provider_response_id", "override_score", "override_rationale", "override_by_person_id", "override_at", "revision", "last_operation_id"},
        "event_ai_review_settings": {"event_id", "enabled", "revision", "updated_by_person_id", "last_operation_id", "created_at", "updated_at"},
        "reviewer_ai_suggestions": {"event_id", "assignment_id", "evaluator_person_id", "assignment_revision", "round_id", "target_type", "target_id", "source_snapshot_hash", "scorecard_id", "scorecard_version", "suggestions_json", "provider", "model", "provider_response_id", "status", "generated_at", "dismissed_at", "imported_at", "lifecycle_operation_id", "last_operation_id"},
        "file_versions": {"object_key", "upload_status", "signature_status", "scan_status", "released_at"},
        "file_multipart_uploads": {"version_id", "asset_id", "upload_id", "idempotency_key", "status", "manifest_json", "expires_at"},
        "schedule_policies": {"room_overlap_action", "speaker_overlap_action", "required_resource_overlap_action", "speaker_unavailable_action"},
        "speaker_blackout_windows": {"event_id", "person_id", "starts_at", "ends_at", "note"},
        "session_speakers": {"participation_status", "participation_revision", "participation_confirmed_at", "participation_declined_at", "participation_decline_reason"},
        "rooms": {"status"},
        "tags": {"event_id", "name", "colour_token"},
        "session_archives": {"event_id", "previous_status", "archive_operation_id"},
        "schedule_versions": {"status", "revision", "notes"},
        "schedule_session_contents": {"schedule_version_id", "event_id", "session_id", "title", "slug", "description", "track_id", "format", "duration_minutes", "required_resources_json", "visibility", "content_status", "content_revision", "last_edited_by_person_id", "approved_by_person_id", "approved_at", "approval_source", "last_operation_id"},
        "session_content_revisions": {"event_id", "schedule_version_id", "session_id", "revision_number", "title", "description", "content_status", "change_kind", "restored_from_revision_id", "created_by_person_id"},
        "event_public_sites": {"event_id", "organisation_id", "draft_json", "draft_revision", "published_json", "published_revision", "published_at", "last_updated_by_person_id", "last_operation_id"},
        "event_public_site_references": {"event_id", "organisation_id", "kind", "record_id", "site_revision"},
        "event_site_sponsors": {"id", "organisation_id", "event_id", "name", "tier", "website_url", "logo_url", "description", "position", "revision", "last_updated_by_person_id", "last_operation_id"},
        "event_session_recordings": {"id", "organisation_id", "event_id", "session_id", "draft_title", "draft_recording_url", "draft_captions_url", "draft_transcript_url", "draft_revision", "published_title", "published_recording_url", "published_captions_url", "published_transcript_url", "published_revision", "published_at", "last_updated_by_person_id", "last_operation_id"},
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
        "idx_audit_events_event_created_id", "idx_audit_events_organisation_created_id", "idx_audit_events_event_actor_created_id",
        "idx_speaker_profile_revisions_person_created", "idx_speaker_profile_revisions_event_person_created",
        "idx_evaluation_rounds_schedule", "idx_evaluation_round_reviewers_round", "idx_evaluation_round_reviewers_person", "evaluation_criteria_position_unique", "idx_ai_review_assessments_round", "idx_ai_review_assessments_submission", "idx_reviewer_ai_suggestions_assignment", "ux_reviewer_ai_suggestions_active", "idx_reviewer_ai_operations_organisation_usage", "idx_reviewer_ai_operations_assignment_usage",
        "idx_organisation_contacts_status", "idx_organisation_contact_tags_tag",
        "idx_crm_pipeline_stage", "idx_crm_pipeline_activity_entry",
        "assistant_proposal_executions_claim_idx",
        "idx_event_brand_assets_cleanup",
        "idx_event_site_sponsors_order", "idx_event_session_recordings_public",
    }
    if required_indexes - indexes:
        raise SystemExit(f"Migration missing indexes: {sorted(required_indexes - indexes)}")

    # Exercise the high-risk invariants instead of only checking names.
    connection.executescript("""
    INSERT INTO organisations (id,name,slug) VALUES ('org-a','A','a'),('org-b','B','b');
    INSERT INTO people (id,email,display_name) VALUES
      ('person-a','a@example.test','A'),
      ('person-b','b@example.test','B');
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
        "INSERT INTO speaker_blackout_windows "
        "(id,event_id,person_id,starts_at,ends_at) "
        "VALUES ('window-inverted','event-a','person-a',200,100)",
        "A blackout window ending before it starts was accepted",
    )
    must_fail(
        "INSERT INTO speaker_blackout_windows "
        "(id,event_id,person_id,starts_at,ends_at,note) "
        "VALUES ('window-padded-note','event-a','person-a',100,200,' padded ')",
        "A padded blackout note was accepted",
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
    must_fail(
        "INSERT INTO event_brand_assets "
        "(id,organisation_id,event_id,kind,object_key,object_etag,original_filename,content_type,size_bytes,created_by_person_id) "
        "VALUES ('raw-brand','org-a','event-a','logo','raw-brand','raw-etag','raw.png','image/png',10,'person-a')",
        "A live event branding asset without normalized image evidence was accepted",
    )
    connection.execute(
        "INSERT INTO event_brand_assets "
        "(id,organisation_id,event_id,kind,object_key,object_etag,original_filename,content_type,size_bytes,width_px,height_px,normalizer_version,normalized_at,created_by_person_id) "
        "VALUES ('brand-logo','org-a','event-a','logo','brand-logo','brand-etag','brand.webp','image/webp',10,100,100,'cloudflare-images-webp-v1',unixepoch(),'person-a')"
    )
    connection.execute(
        "INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at,file_policy_json) "
        "VALUES ('brand-event','org-a','Brand event','brand-event','UTC',100,200,'{\"headshotMaximumBytes\":10485760,\"slidesMaximumBytes\":104857600,\"supportingDocumentMaximumBytes\":104857600,\"videoMaximumBytes\":1073741824}')"
    )
    connection.execute(
        "INSERT INTO event_brand_assets "
        "(id,organisation_id,event_id,kind,object_key,object_etag,original_filename,content_type,size_bytes,width_px,height_px,normalizer_version,normalized_at,created_by_person_id) "
        "VALUES ('brand-delete-guard','org-a','brand-event','logo','brand-delete-guard','brand-delete-etag','brand.webp','image/webp',10,100,100,'cloudflare-images-webp-v1',unixepoch(),'person-a')"
    )
    must_fail(
        "DELETE FROM events WHERE id='brand-event'",
        "An event deletion discarded durable brand-object cleanup evidence",
    )
    connection.execute(
        "DELETE FROM event_brand_assets WHERE id='brand-delete-guard'"
    )
    connection.execute("DELETE FROM events WHERE id='brand-event'")
    connection.execute(
        "UPDATE events SET brand_draft_logo_asset_id='brand-logo' WHERE id='event-a'"
    )
    must_fail(
        "UPDATE events SET brand_draft_banner_asset_id='brand-logo' WHERE id='event-a'",
        "An event banner pointer accepted a logo asset",
    )
    must_fail(
        "UPDATE event_brand_assets SET deleted_at=unixepoch() WHERE id='brand-logo'",
        "A referenced event branding asset was retired",
    )
    must_fail(
        "DELETE FROM event_brand_assets WHERE id='brand-logo'",
        "A referenced event branding asset was deleted",
    )
    connection.execute(
        "UPDATE events SET brand_draft_logo_asset_id=NULL WHERE id='event-a'"
    )
    connection.execute(
        "UPDATE event_brand_assets SET deleted_at=unixepoch() WHERE id='brand-logo'"
    )
    must_fail(
        "UPDATE event_brand_assets SET deleted_at=NULL WHERE id='brand-logo'",
        "A retired event branding asset was restored after cleanup became eligible",
    )
    connection.execute("DELETE FROM event_brand_assets WHERE id='brand-logo'")
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

    connection.executescript("""
    INSERT INTO sessions (
      id,event_id,title,slug,format,duration_minutes,status,visibility
    ) VALUES
      ('reviewer-ai-session-a','event-a','Reviewer AI A','reviewer-ai-a','presentation',30,'unscheduled','private'),
      ('reviewer-ai-session-b','event-a','Reviewer AI B','reviewer-ai-b','presentation',30,'unscheduled','private');
    INSERT INTO evaluator_assignments (
      id,event_id,round_id,session_id,session_snapshot_json,evaluator_person_id
    ) VALUES
      ('reviewer-ai-assignment-a','event-a','dropdown-round','reviewer-ai-session-a','{}','person-a'),
      ('reviewer-ai-assignment-b','event-a','dropdown-round','reviewer-ai-session-b','{}','person-a');
    INSERT INTO reviews (id,event_id,assignment_id)
    VALUES
      ('reviewer-ai-review-a','event-a','reviewer-ai-assignment-a'),
      ('reviewer-ai-review-b','event-a','reviewer-ai-assignment-b');
    """)
    must_fail(
        "INSERT INTO reviewer_ai_suggestions "
        "(id,event_id,assignment_id,evaluator_person_id,assignment_revision,round_id,target_type,target_id,"
        "source_snapshot_hash,scorecard_id,scorecard_version,suggestions_json,provider,model,provider_response_id,last_operation_id) "
        "VALUES ('reviewer-ai-wrong-evaluator','event-a','reviewer-ai-assignment-a','person-b',1,'dropdown-round',"
        "'session','reviewer-ai-session-a','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',"
        "'dropdown-scorecard',1,'[]','workers_ai','test-model','wrong-evaluator-response','wrong-evaluator-operation')",
        "A reviewer AI suggestion named an evaluator other than its assignment evaluator",
    )
    connection.executescript("""
    INSERT INTO reviewer_ai_suggestions (
      id,event_id,assignment_id,evaluator_person_id,assignment_revision,
      round_id,target_type,target_id,source_snapshot_hash,scorecard_id,
      scorecard_version,suggestions_json,provider,model,provider_response_id,
      last_operation_id
    ) VALUES
      ('reviewer-ai-suggestion-a','event-a','reviewer-ai-assignment-a','person-a',1,
       'dropdown-round','session','reviewer-ai-session-a',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'dropdown-scorecard',1,'[]','workers_ai','test-model','response-a','suggestion-operation-a'),
      ('reviewer-ai-suggestion-b','event-a','reviewer-ai-assignment-b','person-a',1,
       'dropdown-round','session','reviewer-ai-session-b',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       'dropdown-scorecard',1,'[]','workers_ai','test-model','response-b','suggestion-operation-b');
    """)
    must_fail(
        "UPDATE reviews SET ai_suggestion_id='reviewer-ai-suggestion-a' "
        "WHERE id='reviewer-ai-review-b'",
        "A review referenced a reviewer AI suggestion from another assignment",
    )
    must_fail(
        "UPDATE reviewer_ai_suggestions SET status='imported', imported_at=unixepoch(), "
        "lifecycle_operation_id='suggestion-import-b' WHERE id='reviewer-ai-suggestion-b'",
        "A reviewer AI suggestion was imported without a matching review",
    )
    connection.execute(
        "UPDATE reviewer_ai_suggestions SET status='dismissed', dismissed_at=unixepoch(), "
        "lifecycle_operation_id='suggestion-dismiss-b' WHERE id='reviewer-ai-suggestion-b'"
    )
    must_fail(
        "UPDATE reviews SET ai_suggestion_id='reviewer-ai-suggestion-b' "
        "WHERE id='reviewer-ai-review-b'",
        "A review referenced a dismissed reviewer AI suggestion",
    )
    connection.execute(
        "UPDATE reviews SET ai_suggestion_id='reviewer-ai-suggestion-a' "
        "WHERE id='reviewer-ai-review-a'"
    )
    must_fail(
        "UPDATE reviewer_ai_suggestions SET status='dismissed', dismissed_at=unixepoch(), "
        "lifecycle_operation_id='suggestion-dismiss-a' WHERE id='reviewer-ai-suggestion-a'",
        "A reviewer AI suggestion referenced by a review was dismissed",
    )
    connection.execute(
        "UPDATE reviewer_ai_suggestions SET status='imported', imported_at=unixepoch(), "
        "lifecycle_operation_id='suggestion-import-a' WHERE id='reviewer-ai-suggestion-a'"
    )
    must_fail(
        "INSERT INTO review_revisions "
        "(id,event_id,review_id,revision_number,scores_json,content_json,save_kind,saved_by_person_id,"
        "scorecard_id,scorecard_version,criteria_snapshot_json,ai_suggestion_id) "
        "VALUES ('reviewer-ai-invalid-revision','event-a','reviewer-ai-review-b',1,'{}','{}','manual','person-a',"
        "'dropdown-scorecard',1,'[]','reviewer-ai-suggestion-a')",
        "A review revision referenced a reviewer AI suggestion from another review",
    )
    connection.execute(
        "INSERT INTO review_revisions "
        "(id,event_id,review_id,revision_number,scores_json,content_json,save_kind,saved_by_person_id,"
        "scorecard_id,scorecard_version,criteria_snapshot_json,ai_suggestion_id) "
        "VALUES ('reviewer-ai-valid-revision','event-a','reviewer-ai-review-a',1,'{}','{}','manual','person-a',"
        "'dropdown-scorecard',1,'[]','reviewer-ai-suggestion-a')"
    )
    must_fail(
        "UPDATE review_revisions SET ai_suggestion_id='reviewer-ai-suggestion-b' "
        "WHERE id='reviewer-ai-valid-revision'",
        "A review revision was changed to a dismissed reviewer AI suggestion",
    )

    connection.execute(
        "UPDATE events SET participant_retention_completed_at=unixepoch() WHERE id='event-a'"
    )
    must_fail(
        "UPDATE events SET participant_retention_completed_at=NULL WHERE id='event-a'",
        "The participant-retention completion tombstone was cleared",
    )

    connection.execute(
        "INSERT INTO audit_events (id,organisation_id,event_id,actor_person_id,actor_kind,origin,action,entity_type,metadata_version,metadata_json) "
        "VALUES ('audit-a','org-a','event-a','person-a','person','internal','test','event',1,'{}')"
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
        "speaker_profile_revisions_participant_retention_no_pii_insert",
        "submission_revisions_participant_retention_no_pii_update",
        "review_revisions_participant_retention_no_pii_update",
        "evaluation_discussion_messages_participant_retention_no_pii_insert",
        "evaluation_discussion_messages_participant_retention_no_pii_update",
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
        "schedule_versions_public_content_approval_guard",
        "event_brand_assets_ready_insert",
        "event_brand_assets_ready_update",
        "event_brand_assets_identity_immutable",
        "event_brand_assets_no_restore",
        "event_brand_assets_no_retire_while_referenced",
        "event_brand_assets_no_delete_while_referenced",
        "events_no_delete_with_brand_assets",
        "events_brand_assets_ready_insert",
        "events_brand_assets_ready_update",
        "events_retire_unreferenced_brand_assets",
        "reviews_ai_suggestion_provenance_insert",
        "reviews_ai_suggestion_provenance_update",
        "reviewer_ai_suggestions_assignment_provenance_insert",
        "reviewer_ai_suggestions_import_requires_review",
        "reviewer_ai_suggestions_dismiss_requires_unreferenced",
        "review_revisions_ai_suggestion_provenance_insert",
        "review_revisions_ai_suggestion_provenance_update",
    }
    if required_triggers - triggers:
        raise SystemExit(f"Migration triggers are missing: {sorted(required_triggers - triggers)}")
    events_without_policy = connection.execute(
        "SELECT COUNT(*) FROM events e LEFT JOIN schedule_policies p ON p.event_id = e.id WHERE p.event_id IS NULL"
    ).fetchone()[0]
    if events_without_policy:
        raise SystemExit("Event insertion did not provision its required schedule policy")

    print(f"migration validated: {len(tables)} application tables, {len(indexes)} indexes, {len(triggers)} triggers")

from pathlib import Path
import sqlite3


MIGRATION = "0036_reviewer_ai_hardening.sql"


def database_before_migration(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())
    return connection


def insert_reviewer_ai_fixture(
    connection: sqlite3.Connection, *, consistent: bool = True
) -> None:
    connection.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('ai-org', 'AI Org', 'ai-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('ai-reviewer', 'reviewer@example.test', 'Reviewer');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'ai-event', 'ai-org', 'AI Event', 'ai-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO evaluation_plans (
          id, event_id, name, status, created_by_person_id
        ) VALUES ('ai-plan', 'ai-event', 'AI Plan', 'active', 'ai-reviewer');
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version
        ) VALUES (
          'ai-round', 'ai-event', 'ai-plan', 1, 'AI Round', 'active',
          'ai-scorecard', 1
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status, visibility
        ) VALUES (
          'ai-session', 'ai-event', 'AI Session', 'ai-session',
          'presentation', 45, 'unscheduled', 'public'
        );
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, session_id, session_snapshot_json,
          evaluator_person_id, revision
        ) VALUES (
          'ai-assignment', 'ai-event', 'ai-round', 'ai-session', '{}',
          'ai-reviewer', 1
        );
        INSERT INTO reviewer_ai_suggestions (
          id, event_id, assignment_id, evaluator_person_id,
          assignment_revision, round_id, target_type, target_id,
          source_snapshot_hash, scorecard_id, scorecard_version,
          suggestions_json, provider, model, provider_response_id, status,
          imported_at, imported_review_id, lifecycle_operation_id,
          last_operation_id
        ) VALUES (
          'ai-suggestion', 'ai-event', 'ai-assignment', 'ai-reviewer',
          1, 'ai-round', 'session', 'ai-session',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ai-scorecard', 1, '[]', 'openai', 'test-model',
          'provider-response', 'imported', 150, 'ai-review',
          'ai-import-operation', 'ai-generate-operation'
        );
        """
    )
    if not consistent:
        return
    connection.executescript(
        """
        INSERT INTO reviews (
          id, event_id, assignment_id, status, scores_json, revision,
          ai_suggestion_id, imported_criterion_ids_json,
          confirmed_ai_criterion_ids_json
        ) VALUES (
          'ai-review', 'ai-event', 'ai-assignment', 'submitted',
          '{"criterion-a":4}', 1, 'ai-suggestion', '["criterion-a"]',
          '["criterion-a"]'
        );
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, ai_suggestion_id,
          imported_criterion_ids_json, confirmed_ai_criterion_ids_json,
          scorecard_id, scorecard_version, criteria_snapshot_json
        ) VALUES (
          'ai-revision', 'ai-event', 'ai-review', 1,
          '{"criterion-a":4}', '{}', 'submitted', 'ai-reviewer',
          'ai-suggestion', '["criterion-a"]', '["criterion-a"]',
          'ai-scorecard', 1, '[]'
        );
        """
    )


def validate_reviewer_ai_hardening_forward_migration(root: Path) -> None:
    deployed = database_before_migration(root)
    insert_reviewer_ai_fixture(deployed)
    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())

    suggestion_columns = {
        row[1] for row in deployed.execute("PRAGMA table_info(reviewer_ai_suggestions)")
    }
    if "imported_review_id" in suggestion_columns:
        raise SystemExit("Reviewer AI hardening retained imported_review_id")
    if deployed.execute("PRAGMA foreign_key_check").fetchall():
        raise SystemExit("Reviewer AI hardening left broken foreign keys")
    if deployed.execute(
        "SELECT status FROM reviewer_ai_suggestions WHERE id = 'ai-suggestion'"
    ).fetchone() != ("imported",):
        raise SystemExit("Reviewer AI hardening did not preserve suggestion state")
    if deployed.execute(
        "SELECT ai_suggestion_id FROM reviews WHERE id = 'ai-review'"
    ).fetchone() != ("ai-suggestion",):
        raise SystemExit("Reviewer AI hardening did not preserve review provenance")
    assignment_index_columns = deployed.execute(
        "PRAGMA index_xinfo(idx_reviewer_ai_operations_assignment_usage)"
    ).fetchall()
    if not any(row[2] == "created_at" and row[3] == 1 for row in assignment_index_columns):
        raise SystemExit("Reviewer AI assignment quota index lacks descending created_at")

    malformed = database_before_migration(root)
    insert_reviewer_ai_fixture(malformed, consistent=False)
    try:
        malformed.executescript(root.joinpath("migrations", MIGRATION).read_text())
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Reviewer AI hardening accepted contradictory import provenance")

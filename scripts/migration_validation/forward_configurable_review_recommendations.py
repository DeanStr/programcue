import json
from pathlib import Path
import sqlite3


MIGRATION = "0047_configurable_review_recommendations.sql"
STANDARD_CHOICES = [
    {"id": "accept", "label": "Accept"},
    {"id": "minor_changes", "label": "Minor"},
    {"id": "conditional_accept", "label": "Conditional"},
    {"id": "waitlist", "label": "Waitlist"},
    {"id": "reject", "label": "Reject"},
]
CUSTOM_CHOICES = [
    {"id": "strong_accept", "label": "Strong accept"},
    {"id": "discuss", "label": "Discuss"},
    {"id": "decline", "label": "Decline"},
]


def expect_integrity_error(connection: sqlite3.Connection, sql: str, parameters=()) -> None:
    try:
        connection.execute(sql, parameters)
    except sqlite3.IntegrityError:
        return
    raise SystemExit(f"Migration 0047 accepted an invalid mutation: {sql.strip()}")


def validate_configurable_review_recommendations_forward_migration(root: Path) -> None:
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('recommendation-org', 'Recommendation Org', 'recommendation-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('recommendation-reviewer', 'reviewer@example.test', 'Reviewer');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'recommendation-event', 'recommendation-org', 'Recommendation Event',
          'recommendation-event', 'UTC', 100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, accepted_at
        ) VALUES (
          'recommendation-membership', 'recommendation-org',
          'recommendation-event', 'recommendation-reviewer', 'evaluator', 100
        );
        INSERT INTO evaluation_plans (
          id, event_id, name, status, created_by_person_id
        ) VALUES (
          'recommendation-plan', 'recommendation-event', 'Review plan', 'active',
          'recommendation-reviewer'
        );
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version
        ) VALUES (
          'legacy-round', 'recommendation-event', 'recommendation-plan', 1,
          'Legacy round', 'active', 'legacy-scorecard', 1
        );
        INSERT INTO evaluation_criteria (
          id, event_id, round_id, name, input_type, weight_percent, position
        ) VALUES (
          'legacy-criterion', 'recommendation-event', 'legacy-round', 'Fit',
          'scale_5', 100, 0
        );
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes
        ) VALUES (
          'legacy-session', 'recommendation-event', 'Legacy session',
          'legacy-session', 'presentation', 45
        );
        INSERT INTO evaluation_round_reviewers (
          id, event_id, round_id, person_id
        ) VALUES (
          'legacy-reviewer-pool', 'recommendation-event', 'legacy-round',
          'recommendation-reviewer'
        );
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, session_id, session_snapshot_json,
          evaluator_person_id, status
        ) VALUES (
          'legacy-assignment', 'recommendation-event', 'legacy-round',
          'legacy-session', '{}', 'recommendation-reviewer', 'submitted'
        );
        INSERT INTO reviews (
          id, event_id, assignment_id, status, scores_json, weighted_score,
          recommendation, confidence
        ) VALUES (
          'legacy-review', 'recommendation-event', 'legacy-assignment',
          'submitted', '{"legacy-criterion":4}', 4, 'minor_changes', 4
        );
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, scorecard_id, scorecard_version,
          criteria_snapshot_json
        ) VALUES (
          'legacy-revision', 'recommendation-event', 'legacy-review', 1,
          '{"legacy-criterion":4}', '{"recommendation":"minor_changes"}',
          'submitted', 'recommendation-reviewer', 'legacy-scorecard', 1,
          '[{"id":"legacy-criterion","name":"Fit"}]'
        );
        """
    )

    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())
    standard_json = json.dumps(STANDARD_CHOICES, separators=(",", ":"))
    legacy = deployed.execute(
        """
        SELECT round.recommendation_choices_json, review.recommendation,
               review.recommendation_choices_snapshot_json,
               revision.recommendation_choices_snapshot_json
          FROM evaluation_rounds round
          JOIN evaluator_assignments assignment ON assignment.round_id = round.id
          JOIN reviews review ON review.assignment_id = assignment.id
          JOIN review_revisions revision ON revision.review_id = review.id
         WHERE round.id = 'legacy-round'
        """
    ).fetchone()
    if legacy != (standard_json, "minor_changes", standard_json, standard_json):
        raise SystemExit("Migration 0047 did not preserve legacy recommendation evidence")

    deployed.execute(
        """
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version, recommendation_choices_json
        ) VALUES (
          'custom-round', 'recommendation-event', 'recommendation-plan', 2,
          'Custom round', 'active', 'custom-scorecard', 1, ?
        )
        """,
        (json.dumps(CUSTOM_CHOICES, separators=(",", ":")),),
    )
    expect_integrity_error(
        deployed,
        """
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version, recommendation_choices_json
        ) VALUES (
          'ambiguous-round', 'recommendation-event', 'recommendation-plan', 3,
          'Ambiguous round', 'draft', 'ambiguous-scorecard', 1,
          '[{"id":"one","id":"shadow","label":"One"},{"id":"two","label":"Two"}]'
        )
        """,
    )
    mixed_choices_json = (
        '[{"id":"mixed","label":"Mixed"},'
        '{"id":"decline","label":"Decline"}]'
    )
    expect_integrity_error(
        deployed,
        """
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version, recommendation_choices_json
        ) VALUES (
          'mixed-round', 'recommendation-event', 'recommendation-plan', 3,
          'Mixed round', 'draft', 'mixed-scorecard', 1, ?
        )
        """,
        (mixed_choices_json,),
    )
    deployed.execute(
        """
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status,
          scorecard_id, scorecard_version, recommendation_choices_json
        ) VALUES (
          'editable-round', 'recommendation-event', 'recommendation-plan', 3,
          'Editable round', 'draft', 'editable-scorecard', 1, ?
        )
        """,
        (standard_json,),
    )
    expect_integrity_error(
        deployed,
        "UPDATE evaluation_rounds SET recommendation_choices_json = ? WHERE id = 'editable-round'",
        (mixed_choices_json,),
    )
    deployed.execute(
        """
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, session_id, session_snapshot_json,
          evaluator_person_id, status
        ) VALUES (
          'custom-assignment', 'recommendation-event', 'custom-round',
          'legacy-session', '{}', 'recommendation-reviewer', 'assigned'
        )
        """
    )
    custom_json = json.dumps(CUSTOM_CHOICES, separators=(",", ":"))
    expect_integrity_error(
        deployed,
        "UPDATE evaluation_rounds SET recommendation_choices_json = ? WHERE id = 'custom-round'",
        (standard_json,),
    )
    expect_integrity_error(
        deployed,
        """
        INSERT INTO reviews (
          id, event_id, assignment_id, recommendation,
          recommendation_choices_snapshot_json
        ) VALUES (
          'invalid-review', 'recommendation-event', 'custom-assignment',
          'accept', ?
        )
        """,
        (custom_json,),
    )
    deployed.execute(
        """
        INSERT INTO reviews (
          id, event_id, assignment_id, recommendation,
          recommendation_choices_snapshot_json
        ) VALUES (
          'custom-review', 'recommendation-event', 'custom-assignment',
          'strong_accept', ?
        )
        """,
        (custom_json,),
    )
    expect_integrity_error(
        deployed,
        "UPDATE reviews SET recommendation = 'accept' WHERE id = 'custom-review'",
    )
    expect_integrity_error(
        deployed,
        """
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, scorecard_id, scorecard_version,
          criteria_snapshot_json, recommendation_choices_snapshot_json
        ) VALUES (
          'invalid-recommendation-revision', 'recommendation-event',
          'custom-review', 1, '{}', '{"recommendation":"accept"}',
          'manual', 'recommendation-reviewer', 'custom-scorecard', 1, '[]', ?
        )
        """,
        (custom_json,),
    )
    expect_integrity_error(
        deployed,
        """
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, scorecard_id, scorecard_version,
          criteria_snapshot_json, recommendation_choices_snapshot_json
        ) VALUES (
          'invalid-revision', 'recommendation-event', 'custom-review', 1,
          '{}', '{}', 'manual', 'recommendation-reviewer', 'custom-scorecard',
          1, '[]', ?
        )
        """,
        (standard_json,),
    )
    deployed.execute(
        """
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, scorecard_id, scorecard_version,
          criteria_snapshot_json, recommendation_choices_snapshot_json
        ) VALUES (
          'custom-revision', 'recommendation-event', 'custom-review', 1,
          '{}', '{"recommendation":"strong_accept"}', 'manual',
          'recommendation-reviewer', 'custom-scorecard', 1, '[]', ?
        )
        """,
        (custom_json,),
    )
    expect_integrity_error(
        deployed,
        """
        UPDATE review_revisions
           SET recommendation_choices_snapshot_json = ?
         WHERE id = 'custom-revision'
        """,
        (standard_json,),
    )
    expect_integrity_error(
        deployed,
        """
        UPDATE review_revisions
           SET content_json = '{"recommendation":"decline"}'
         WHERE id = 'custom-revision'
        """,
    )
    expect_integrity_error(
        deployed,
        """
        UPDATE review_revisions
           SET content_json = '{"redacted":true,"recommendation":"decline"}'
         WHERE id = 'custom-revision'
        """,
    )
    deployed.execute(
        """
        UPDATE review_revisions
           SET content_json = '{"redacted":true}'
         WHERE id = 'custom-revision'
        """
    )

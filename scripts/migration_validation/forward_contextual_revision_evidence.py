from pathlib import Path
import sqlite3


def validate_contextual_revision_evidence_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0031_contextual_revision_evidence.sql":
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('history-org', 'History organisation', 'history-organisation');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'history-event', 'history-org', 'History event', 'history-event',
          'UTC', 1800000000, 1800086400,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO people (id, email, display_name)
        VALUES ('history-person', 'history@example.test', 'History Person');
        """
    )

    # These parent records are deliberately inserted with foreign keys disabled:
    # the forward-migration contract under test is the nullable legacy evidence,
    # not the already-validated evaluation graph.
    deployed.execute("PRAGMA foreign_keys = OFF")
    deployed.executescript(
        """
        INSERT INTO reviews (
          id, event_id, assignment_id, status, scores_json, revision
        ) VALUES (
          'history-review', 'history-event', 'history-assignment', 'draft',
          '{}', 1
        );
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id
        ) VALUES (
          'legacy-review-revision', 'history-event', 'history-review', 1,
          '{}', '{}', 'manual', 'history-person'
        );
        """
    )
    deployed.execute("PRAGMA foreign_keys = ON")

    deployed.executescript(
        root.joinpath("migrations/0031_contextual_revision_evidence.sql").read_text()
    )

    legacy = deployed.execute(
        """
        SELECT scorecard_id, scorecard_version, criteria_snapshot_json
          FROM review_revisions WHERE id = 'legacy-review-revision'
        """
    ).fetchone()
    if legacy != (None, None, None):
        raise SystemExit("Legacy review evidence was not preserved honestly")

    def must_fail(statement: str, message: str) -> None:
        try:
            deployed.execute(statement)
        except sqlite3.IntegrityError:
            return
        raise SystemExit(message)

    must_fail(
        """
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id
        ) VALUES (
          'missing-scorecard', 'history-event', 'history-review', 2,
          '{}', '{}', 'manual', 'history-person'
        )
        """,
        "A new review revision omitted its exact scorecard evidence",
    )
    deployed.execute(
        """
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id,
          scorecard_id, scorecard_version, criteria_snapshot_json
        ) VALUES (
          'contract-review-revision', 'history-event', 'history-review', 2,
          '{}', '{}', 'manual', 'history-person', 'scorecard-a', 3,
          '[{"id":"criterion-a","label":"Clarity"}]'
        )
        """
    )

    deployed.execute(
        """
        INSERT INTO speaker_profile_revisions (
          id, organisation_id, event_id, person_id, source, profile_revision,
          display_name, publication_status, correlation_id
        ) VALUES (
          'profile-revision-a', 'history-org', 'history-event',
          'history-person', 'canonical_person', 1, 'History Person', 'draft',
          'history-operation'
        )
        """
    )
    must_fail(
        "UPDATE speaker_profile_revisions SET display_name = 'Changed' WHERE id = 'profile-revision-a'",
        "Speaker profile evidence was mutable",
    )
    deployed.execute(
        "DELETE FROM speaker_profile_revisions WHERE id = 'profile-revision-a'"
    )
    if deployed.execute(
        "SELECT 1 FROM speaker_profile_revisions WHERE id = 'profile-revision-a'"
    ).fetchone():
        raise SystemExit("Speaker profile evidence did not follow explicit lifecycle deletion")

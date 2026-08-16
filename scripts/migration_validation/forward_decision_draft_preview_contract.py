import json
from pathlib import Path
import sqlite3


def validate_decision_draft_preview_contract_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0032_decision_draft_preview_contract.sql":
            break
        deployed.executescript(path.read_text())

    deployed.execute("PRAGMA foreign_keys = OFF")
    deployed.executemany(
        """
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, notification_feedback_json,
          effect_preview_json, idempotency_key
        ) VALUES (?, 'history-event', ?, 1, 'draft', 'accepted',
                  'history-person', '{}', ?, ?)
        """,
        [
            (
                "legacy-decision",
                "legacy-submission",
                json.dumps(
                    {
                        "createsSession": False,
                        "sessionTrackId": "track-a",
                        "sessionTrackName": "Track A",
                    }
                ),
                "legacy-decision-key",
            ),
            (
                "current-decision",
                "current-submission",
                json.dumps(
                    {
                        "includeReviewerFeedback": True,
                        "sessionTrackId": "track-b",
                        "sessionDurationMinutes": 75,
                    }
                ),
                "current-decision-key",
            ),
        ],
    )
    deployed.execute("PRAGMA foreign_keys = ON")

    deployed.executescript(
        root.joinpath(
            "migrations/0032_decision_draft_preview_contract.sql"
        ).read_text()
    )

    legacy = json.loads(
        deployed.execute(
            "SELECT effect_preview_json FROM submission_decisions WHERE id = 'legacy-decision'"
        ).fetchone()[0]
    )
    if legacy != {
        "createsSession": False,
        "sessionTrackId": "track-a",
        "sessionTrackName": "Track A",
        "includeReviewerFeedback": False,
        "sessionDurationMinutes": None,
    }:
        raise SystemExit("Legacy decision preview evidence was not upgraded exactly")

    current = json.loads(
        deployed.execute(
            "SELECT effect_preview_json FROM submission_decisions WHERE id = 'current-decision'"
        ).fetchone()[0]
    )
    if current["includeReviewerFeedback"] is not True or current[
        "sessionDurationMinutes"
    ] != 75:
        raise SystemExit("Current decision preview evidence was overwritten")

    malformed = sqlite3.connect(":memory:")
    malformed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0032_decision_draft_preview_contract.sql":
            break
        malformed.executescript(path.read_text())
    malformed.execute("PRAGMA foreign_keys = OFF")
    malformed.execute(
        """
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, notification_feedback_json,
          effect_preview_json, idempotency_key
        ) VALUES (
          'malformed-decision', 'history-event', 'malformed-submission', 1,
          'draft', 'accepted', 'history-person', '{}', '[]',
          'malformed-decision-key'
        )
        """
    )
    malformed.execute("PRAGMA foreign_keys = ON")
    try:
        malformed.executescript(
            root.joinpath(
                "migrations/0032_decision_draft_preview_contract.sql"
            ).read_text()
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Structurally invalid decision preview evidence was accepted")

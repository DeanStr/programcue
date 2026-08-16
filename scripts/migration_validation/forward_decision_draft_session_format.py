import json
from pathlib import Path
import sqlite3


MIGRATION = "0033_decision_draft_session_format.sql"


def database_before_migration(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())
    return connection


def insert_preview(
    connection: sqlite3.Connection,
    decision_id: str,
    submission_id: str,
    preview: object,
) -> None:
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute(
        """
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, notification_feedback_json,
          effect_preview_json, idempotency_key
        ) VALUES (?, 'history-event', ?, 1, 'draft', 'accepted',
                  'history-person', '[]', ?, ?)
        """,
        (decision_id, submission_id, json.dumps(preview), f"key:{decision_id}"),
    )
    connection.execute("PRAGMA foreign_keys = ON")


def validate_decision_draft_session_format_forward_migration(root: Path) -> None:
    deployed = database_before_migration(root)
    insert_preview(
        deployed,
        "legacy-format-decision",
        "legacy-format-submission",
        {
            "includeReviewerFeedback": False,
            "sessionTrackId": "track-a",
            "sessionDurationMinutes": None,
        },
    )
    insert_preview(
        deployed,
        "current-format-decision",
        "current-format-submission",
        {
            "includeReviewerFeedback": True,
            "sessionTrackId": "track-b",
            "sessionFormatKey": "workshop",
            "sessionDurationMinutes": 75,
        },
    )

    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())
    previews = {
        row[0]: json.loads(row[1])
        for row in deployed.execute(
            "SELECT id, effect_preview_json FROM submission_decisions"
        )
    }
    if previews["legacy-format-decision"].get("sessionFormatKey", "missing") is not None:
        raise SystemExit("Legacy decision format state was not made explicit")
    if previews["current-format-decision"]["sessionFormatKey"] != "workshop":
        raise SystemExit("A persisted decision format was overwritten")

    malformed = database_before_migration(root)
    insert_preview(
        malformed,
        "malformed-format-decision",
        "malformed-format-submission",
        [],
    )
    try:
        malformed.executescript(root.joinpath("migrations", MIGRATION).read_text())
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Structurally invalid decision preview evidence was accepted")

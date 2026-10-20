import json
from pathlib import Path
import sqlite3


def validate_assistant_retained_reports_forward_migration(root: Path) -> None:
    migration = "0061_assistant_retained_report_boundary.sql"
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == migration:
            break
        connection.executescript(path.read_text())
    connection.executescript("""
        INSERT INTO organisations (id, name, slug)
        VALUES ('report-org', 'Report organisation', 'report-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('report-person', 'report@example.com', 'Report organiser');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at, file_policy_json
        ) VALUES ('report-event', 'report-org', 'Report event', 'report-event',
          'UTC', 1800000000, 1800086400,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}');
    """)

    def insert_run(run_id: str, status: str, kind: str = "ai.assistant.run",
                   **payload_fields: object) -> dict:
        payload = {
            "runId": run_id, "provider": "OpenAI", "model": "previous-model",
            "instructionHash": "recorded-instruction-hash", **payload_fields,
        }
        connection.execute("""
            INSERT INTO operation_jobs (
              id, organisation_id, event_id, requested_by_person_id, type,
              idempotency_key, correlation_id, status, payload_json, result_json
            ) VALUES (?, 'report-org', 'report-event', 'report-person', ?, ?, ?, ?, ?, ?)
        """, (run_id, kind, run_id, run_id, status, json.dumps(payload),
              '{"evidenceCount":0,"proposalIds":[]}'))
        return payload

    historical = ["running", "completed", "failed", "cancelled"]
    originals = {state: insert_run(state, state) for state in historical}
    current = insert_run("current", "completed", requestLabel="Saved request")
    unrelated = insert_run("unrelated", "completed", kind="ai.context.run")
    corrupt = insert_run("corrupt", "completed", provider=None)
    migration_sql = root.joinpath("migrations", migration).read_text()
    connection.executescript(migration_sql)
    rows = connection.execute(
        "SELECT id, status, payload_json, result_json FROM operation_jobs"
    ).fetchall()
    for run_id, status, payload_json, result_json in rows:
        payload = json.loads(payload_json)
        if run_id in historical:
            assert status == run_id
            assert payload == {
                **originals[run_id],
                "reportUnavailableReason": "predates_retained_reports",
            }
        else:
            assert payload == {"current": current, "unrelated": unrelated,
                               "corrupt": corrupt}[run_id]
        assert result_json == '{"evidenceCount":0,"proposalIds":[]}'
    # Old Workers cannot add unmarked historical jobs between migration and cutover.
    try:
        insert_run("late-old-worker", "running")
    except sqlite3.IntegrityError as error:
        assert "require the updated application Worker" in str(error), str(error)
    else:
        raise AssertionError("The old assistant wrote a run after the reporting boundary")
    assert connection.execute(
        "SELECT count(*) FROM operation_jobs WHERE id = 'late-old-worker'"
    ).fetchone() == (0,)
    # New Workers supply a label; the migration never invents a historical marker.
    new_payload = insert_run("after-migration", "running", requestLabel="New request")
    assert json.loads(connection.execute(
        "SELECT payload_json FROM operation_jobs WHERE id = 'after-migration'"
    ).fetchone()[0]) == new_payload
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    connection.close()

from pathlib import Path
import sqlite3


MIGRATION = "0048_task_instance_configuration_snapshot.sql"


def expect_integrity_error(connection: sqlite3.Connection, sql: str) -> None:
    try:
        connection.execute(sql)
    except sqlite3.IntegrityError:
        return
    raise SystemExit(f"Migration 0048 accepted an invalid mutation: {sql.strip()}")


def validate_task_instance_configuration_snapshot_forward_migration(
    root: Path,
) -> None:
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('task-snapshot-org', 'Task snapshot org', 'task-snapshot-org');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'task-snapshot-event', 'task-snapshot-org', 'Task snapshot event',
          'task-snapshot-event', 'UTC', 1800000000, 1800086400,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO task_templates (
          id, event_id, name, target_type, task_type, impact, evidence_mode,
          due_anchor, auto_assign_on_acceptance, configuration_json
        ) VALUES (
          'task-snapshot-template', 'task-snapshot-event', 'Visit the brief',
          'speaker', 'link_visit', 'medium', 'link', 'none', 0,
          '{"destinationUrl":"https://example.test/brief"}'
        );
        INSERT INTO task_instances (
          id, event_id, template_id, target_type, target_id, title,
          task_type, impact
        ) VALUES (
          'task-snapshot-from-template', 'task-snapshot-event',
          'task-snapshot-template', 'speaker', 'speaker-one', 'Visit the brief',
          'link_visit', 'medium'
        );
        INSERT INTO task_instances (
          id, event_id, target_type, target_id, title, task_type, impact
        ) VALUES (
          'task-snapshot-without-template', 'task-snapshot-event', 'speaker',
          'speaker-two', 'Answer the questions', 'short_form', 'high'
        );
        """
    )

    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())
    rows = deployed.execute(
        """
        SELECT id, evidence_mode, configuration_json
          FROM task_instances ORDER BY id
        """
    ).fetchall()
    if rows != [
        (
            "task-snapshot-from-template",
            "link",
            '{"destinationUrl":"https://example.test/brief"}',
        ),
        ("task-snapshot-without-template", "text", "{}"),
    ]:
        raise SystemExit(
            "Migration 0048 did not backfill exact template and fallback snapshots"
        )

    expect_integrity_error(
        deployed,
        """
        UPDATE task_instances SET configuration_json = 'not-json'
         WHERE id = 'task-snapshot-from-template'
        """,
    )
    deployed.execute(
        """
        UPDATE events SET participant_retention_completed_at = 1800086400
         WHERE id = 'task-snapshot-event'
        """
    )
    expect_integrity_error(
        deployed,
        """
        UPDATE task_instances SET configuration_json = '{}'
         WHERE id = 'task-snapshot-from-template'
        """,
    )

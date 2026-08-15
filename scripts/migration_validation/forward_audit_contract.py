from pathlib import Path
import sqlite3


def validate_audit_contract_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0030_audit_contract_and_retention.sql":
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('audit-org', 'Audit organisation', 'audit-organisation');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'audit-event', 'audit-org', 'Audit event', 'audit-event', 'UTC',
          1800000000, 1800086400,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO people (id, email, display_name)
        VALUES ('audit-person', 'audit@example.test', 'Audit Person');
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) VALUES (
          'legacy-audit', 'audit-org', 'audit-event', 'audit-person',
          'event.settings.updated', 'event', 'audit-event', '["legacy"]', 100
        );
        """
    )

    deployed.executescript(
        root.joinpath("migrations/0030_audit_contract_and_retention.sql").read_text()
    )

    legacy = deployed.execute(
        """
        SELECT actor_kind, origin, metadata_version
          FROM audit_events WHERE id = 'legacy-audit'
        """
    ).fetchone()
    if legacy != ("historical", "historical", 0):
        raise SystemExit("Pre-contract audit evidence was not classified honestly")
    if deployed.execute(
        "SELECT metadata_json FROM audit_events WHERE id = 'legacy-audit'"
    ).fetchone() != ('["legacy"]',):
        raise SystemExit("Pre-contract audit metadata was not preserved exactly")

    def must_fail(statement: str, message: str) -> None:
        try:
            deployed.execute(statement)
        except sqlite3.IntegrityError:
            return
        raise SystemExit(message)

    must_fail(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, metadata_json
        ) VALUES (
          'implicit-provenance', 'audit-org', 'audit-event', 'audit-person',
          'event.settings.updated', 'event', '{}'
        )
        """,
        "A new audit event omitted explicit provenance",
    )
    must_fail(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_kind, origin, action,
          entity_type, metadata_version, metadata_json
        ) VALUES (
          'missing-person', 'audit-org', 'audit-event', 'person', 'admin_ui',
          'event.settings.updated', 'event', 1, '{}'
        )
        """,
        "A person audit event omitted its actor identifier",
    )
    must_fail(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_kind, origin, action,
          entity_type, metadata_version, metadata_json
        ) VALUES (
          'missing-agent', 'audit-org', 'audit-event', 'agent', 'queue',
          'assistant.completed', 'operation', 1, '{}'
        )
        """,
        "An agent audit event omitted its actor identifier",
    )
    must_fail(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_kind, origin, action,
          entity_type, metadata_version, metadata_json
        ) VALUES (
          'array-metadata', 'audit-org', 'audit-event', 'system', 'internal',
          'system.tested', 'event', 1, '[]'
        )
        """,
        "A new audit event accepted non-object metadata",
    )

    deployed.execute(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_kind, origin,
          action, entity_type, entity_id, metadata_version, metadata_json,
          created_at
        ) VALUES (
          'contract-audit', 'audit-org', 'audit-event', 'audit-person',
          'person', 'admin_ui', 'event.settings.updated', 'event',
          'audit-event', 1,
          '{"revision":2,"roomCount":0,"trackCount":0}', 200
        )
        """
    )
    must_fail(
        """
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_kind, origin,
          action, entity_type, metadata_version, metadata_json
        ) VALUES (
          'malformed-display-metadata', 'audit-org', 'audit-event',
          'audit-person', 'person', 'admin_ui', 'schedule.published',
          'schedule_version', 1, '{}'
        )
        """,
        "A known action accepted malformed display metadata",
    )
    must_fail(
        "UPDATE audit_events SET action = 'changed' WHERE id = 'contract-audit'",
        "Contract audit evidence was mutable",
    )
    must_fail(
        "DELETE FROM audit_events WHERE id = 'contract-audit'",
        "Contract audit evidence was deletable",
    )

    deployed.execute("DELETE FROM events WHERE id = 'audit-event'")
    if deployed.execute(
        "SELECT COUNT(*) FROM audit_events WHERE event_id = 'audit-event'"
    ).fetchone() != (2,):
        raise SystemExit("Event deletion cascaded into retained audit evidence")

    index_names = {
        row[1] for row in deployed.execute("PRAGMA index_list(audit_events)")
    }
    required = {
        "idx_audit_events_event_created_id",
        "idx_audit_events_organisation_created_id",
        "idx_audit_events_event_actor_created_id",
    }
    if not required.issubset(index_names):
        raise SystemExit("The audit keyset and actor indexes are incomplete")

    stale_references = deployed.execute(
        """
        SELECT type, name FROM sqlite_master
         WHERE sql LIKE '%audit_events_before_contract%'
        """
    ).fetchall()
    if stale_references:
        raise SystemExit(
            f"Audit rebuild left references to its temporary table: {stale_references}"
        )

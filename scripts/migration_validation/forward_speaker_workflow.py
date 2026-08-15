from pathlib import Path
import sqlite3


def validate_speaker_workflow_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0011_event_speaker_workflows.sql":
            break
        deployed.executescript(path.read_text())
    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('legacy-org', 'Legacy organisation', 'legacy-organisation');
        INSERT INTO people (id, email, display_name)
        VALUES ('legacy-invitee', 'legacy-invitee@example.test', 'Legacy invitee');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'legacy-event', 'legacy-org', 'Legacy event', 'legacy-event', 'UTC',
          100, 200,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at
        ) VALUES (
          'legacy-speaker-invitation', 'legacy-org', 'legacy-event',
          'legacy-invitee', 'speaker', 50, 150
        );
        """
    )
    deployed.executescript(
        root.joinpath("migrations/0011_event_speaker_workflows.sql").read_text()
    )
    workflow = deployed.execute(
        """
        SELECT status, source
          FROM event_speaker_workflows
         WHERE event_id = 'legacy-event' AND person_id = 'legacy-invitee'
        """
    ).fetchone()
    if workflow != ("invited", "backfill"):
        raise SystemExit(
            "Legacy pending speaker invitation was not migrated into the workflow roster"
        )

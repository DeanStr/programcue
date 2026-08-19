from pathlib import Path
import sqlite3


MIGRATION = "0045_resource_confirmed_speaker_audience.sql"
FILE_POLICY = (
    '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,'
    '"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
)


def database_before_migration(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == MIGRATION:
            break
        connection.executescript(path.read_text())
    connection.executescript(
        f"""
        INSERT INTO organisations (id, name, slug)
        VALUES ('resource-org', 'Resource Org', 'resource-org');
        INSERT INTO people (id, email, display_name)
        VALUES ('resource-person', 'resource-person@example.test', 'Speaker');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'resource-event', 'resource-org', 'Resource Event',
          'resource-event', 'UTC', 100, 200, '{FILE_POLICY}'
        );
        INSERT INTO resource_pages (
          id, event_id, title, slug, status, audience_scope,
          acknowledgement_required
        ) VALUES (
          'resource-page', 'resource-event', 'Existing resource',
          'existing-resource', 'published', 'accepted_speakers', 1
        );
        INSERT INTO resource_page_versions (
          id, event_id, resource_page_id, version_number, title, slug,
          audience_scope, acknowledgement_required, document_json,
          rendered_html, status, published_at
        ) VALUES (
          'resource-version', 'resource-event', 'resource-page', 1,
          'Existing resource', 'existing-resource', 'accepted_speakers', 1,
          '{{}}', '<p>Existing</p>', 'published', 150
        );
        INSERT INTO resource_audiences (
          resource_page_version_id, event_id, target_type, target_id
        ) VALUES (
          'resource-version', 'resource-event', 'person', 'resource-person'
        );
        INSERT INTO file_assets (
          id, event_id, target_type, target_id, asset_kind
        ) VALUES (
          'resource-file', 'resource-event', 'resource', 'resource-page',
          'resource_attachment'
        );
        INSERT INTO resource_attachments (
          resource_page_version_id, event_id, file_asset_id, position, label
        ) VALUES (
          'resource-version', 'resource-event', 'resource-file', 1, 'Guide'
        );
        INSERT INTO resource_acknowledgements (
          id, event_id, resource_page_id, resource_page_version_id, person_id
        ) VALUES (
          'resource-ack', 'resource-event', 'resource-page',
          'resource-version', 'resource-person'
        );
        """
    )
    return connection


def validate_resource_confirmed_speaker_audience_forward_migration(
    root: Path,
) -> None:
    deployed = database_before_migration(root)
    deployed.executescript(root.joinpath("migrations", MIGRATION).read_text())

    preserved = deployed.execute(
        """
        SELECT page.audience_scope, version.audience_scope,
               audience.target_id, attachment.file_asset_id, ack.person_id
          FROM resource_pages page
          JOIN resource_page_versions version
            ON version.resource_page_id = page.id
          JOIN resource_audiences audience
            ON audience.resource_page_version_id = version.id
          JOIN resource_attachments attachment
            ON attachment.resource_page_version_id = version.id
          JOIN resource_acknowledgements ack
            ON ack.resource_page_version_id = version.id
         WHERE page.id = 'resource-page'
        """
    ).fetchone()
    if preserved != (
        "accepted_speakers",
        "accepted_speakers",
        "resource-person",
        "resource-file",
        "resource-person",
    ):
        raise SystemExit("Migration 0045 did not preserve existing resource data")

    deployed.execute(
        """
        INSERT INTO resource_pages (
          id, event_id, title, slug, audience_scope
        ) VALUES (
          'confirmed-page', 'resource-event', 'Confirmed resource',
          'confirmed-resource', 'confirmed_speakers'
        )
        """
    )
    audience = deployed.execute(
        "SELECT audience_scope FROM resource_pages WHERE id = 'confirmed-page'"
    ).fetchone()
    if audience != ("confirmed_speakers",):
        raise SystemExit("Migration 0045 did not permit confirmed_speakers")

    deployed.execute(
        "UPDATE events SET participant_retention_completed_at = 175 WHERE id = 'resource-event'"
    )
    try:
        deployed.execute(
            """
            INSERT INTO resource_acknowledgements (
              id, event_id, resource_page_id, resource_page_version_id, person_id
            ) VALUES (
              'locked-ack', 'resource-event', 'resource-page',
              'resource-version', 'resource-person'
            )
            """
        )
    except sqlite3.IntegrityError as error:
        if "participant PII is read-only" not in str(error):
            raise
    else:
        raise SystemExit("Migration 0045 did not restore resource retention triggers")

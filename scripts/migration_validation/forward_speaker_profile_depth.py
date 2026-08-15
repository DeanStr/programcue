from pathlib import Path
import sqlite3


def validate_speaker_profile_depth_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0014_speaker_profile_depth.sql":
            break
        deployed.executescript(path.read_text())
    deployed.execute(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, ?)",
        ("legacy-profile", "legacy-profile@example.test", "Legacy Profile"),
    )
    deployed.execute(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, ?)",
        (
            "cross-tenant-profile",
            "cross-tenant-profile@example.test",
            "Cross Tenant Profile",
        ),
    )
    deployed.execute(
        "INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)",
        ("legacy-profile-org", "Legacy Profile Org", "legacy-profile-org"),
    )
    deployed.execute(
        "INSERT INTO organisations (id, name, slug) VALUES (?, ?, ?)",
        ("other-profile-org", "Other Profile Org", "other-profile-org"),
    )
    deployed.execute(
        """
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, ?, ?, 'UTC', 1800000000, 1800086400, ?)
        """,
        (
            "legacy-profile-event",
            "legacy-profile-org",
            "Legacy Profile Event",
            "legacy-profile-event",
            '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}',
        ),
    )
    deployed.executescript(
        root.joinpath("migrations/0014_speaker_profile_depth.sql").read_text()
    )
    migrated = deployed.execute(
        """
        SELECT linkedin_url, x_handle
          FROM people WHERE id = 'legacy-profile'
        """
    ).fetchone()
    if migrated != (None, None):
        raise SystemExit(
            "Legacy speaker profiles were not migrated with empty public depth fields"
        )
    if "travel_preferences" in {
        row[1] for row in deployed.execute("PRAGMA table_info(people)")
    }:
        raise SystemExit("Private travel preferences were added to the global people table")
    deployed.execute(
        """
        INSERT INTO event_participant_profiles (
          event_id, organisation_id, person_id, travel_preferences,
          last_operation_id
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            "legacy-profile-event",
            "legacy-profile-org",
            "legacy-profile",
            "Step-free transport",
            "legacy-profile-operation",
        ),
    )
    try:
        deployed.execute(
            """
            INSERT INTO event_participant_profiles (
              event_id, organisation_id, person_id, travel_preferences,
              last_operation_id
            ) VALUES ('legacy-profile-event', 'other-profile-org',
                      'cross-tenant-profile', 'Cross-tenant value',
                      'cross-tenant-profile-operation')
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Event profile migration accepted a cross-tenant event/org pair")
    try:
        deployed.execute(
            """
            UPDATE event_participant_profiles SET travel_preferences = '   '
             WHERE event_id = 'legacy-profile-event'
               AND person_id = 'legacy-profile'
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Event profile migration accepted blank travel preferences")
    try:
        deployed.execute(
            "UPDATE people SET x_handle = 'invalid handle' WHERE id = 'legacy-profile'"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("Speaker profile migration accepted an invalid X handle")

from pathlib import Path
import sqlite3


def validate_sponsor_retention_forward_migration(root: Path) -> None:
    migration = "0059_sponsor_retention_guards.sql"
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in sorted(root.joinpath("migrations").glob("*.sql")):
        if path.name == migration:
            break
        connection.executescript(path.read_text())
    connection.executescript("""
        INSERT INTO organisations (id,name,slug) VALUES ('sponsor-org','Sponsor org','sponsor-org');
        INSERT INTO people (id,email,display_name) VALUES ('sponsor-person','private@example.com','Private person');
    """)
    for event_id in ("locked", "open"):
        connection.execute("""
            INSERT INTO events (id,organisation_id,name,slug,timezone,starts_at,ends_at,file_policy_json)
            VALUES (?,'sponsor-org',?,?,'UTC',1800000000,1800086400,
              '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
        """, (event_id, event_id, event_id))
        connection.execute("""
            INSERT INTO sessions (id,event_id,title,slug,format,duration_minutes,status,visibility)
            VALUES (?,?,'Retained programme fact','session','presentation',30,'unscheduled','private')
        """, (event_id, event_id))
        connection.execute("""
            INSERT INTO event_sponsorships (id,organisation_id,event_id,name,session_limit)
            VALUES (?,'sponsor-org',?,'Private sponsor profile',1)
        """, (event_id, event_id))
        connection.execute("""
            INSERT INTO sponsor_contacts (id,sponsor_id,event_id,name,email)
            VALUES (?,?,?,'Private person','private@example.com')
        """, (event_id, event_id, event_id))
        connection.execute("""
            INSERT INTO sponsored_session_proposals (id,sponsor_id,event_id,details_json,status,session_id,created_by_person_id)
            VALUES (?,?,?,'{"speakers":[{"email":"private@example.com"}]}','accepted',?,'sponsor-person')
        """, (event_id, event_id, event_id, event_id))
    connection.execute("UPDATE events SET participant_retention_completed_at=unixepoch() WHERE id='locked'")
    connection.executescript(root.joinpath("migrations", migration).read_text())
    for table in ("event_sponsorships", "sponsor_contacts", "sponsored_session_proposals"):
        assert connection.execute(f"SELECT event_id FROM {table}").fetchall() == [("open",)], table
        try:
            connection.execute(f"UPDATE {table} SET event_id='locked' WHERE event_id='open'")
        except sqlite3.IntegrityError as error:
            assert "participant retention is complete" in str(error), str(error)
        else:
            raise AssertionError(f"Retention allowed moving {table} into a locked event")
    assert connection.execute("SELECT count(*) FROM sessions").fetchone() == (2,)
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    connection.close()

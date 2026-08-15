from pathlib import Path
import sqlite3


def validate_session_participation_forward_migration(root: Path) -> None:
    migration = root.joinpath(
        "migrations/0008_session_speaker_participation.sql"
    ).read_text()
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    deployed.executescript(
        """
        CREATE TABLE people (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          source_submission_id TEXT,
          UNIQUE(id, event_id)
        );
        CREATE TABLE participant_retention_locked_events (
          event_id TEXT PRIMARY KEY
        );
        CREATE TABLE session_speakers (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          person_id TEXT NOT NULL REFERENCES people(id),
          position INTEGER NOT NULL CHECK (position >= 0),
          role_label TEXT,
          visibility TEXT NOT NULL DEFAULT 'public'
            CHECK (visibility IN ('public','private','hidden')),
          PRIMARY KEY (session_id, person_id),
          UNIQUE(session_id, position),
          FOREIGN KEY (session_id, event_id)
            REFERENCES sessions(id, event_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_session_speakers_person
          ON session_speakers(event_id, person_id);
        INSERT INTO people (id) VALUES ('legacy-speaker');
        INSERT INTO sessions (id, event_id)
          VALUES ('legacy-session', 'legacy-event');
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        ) VALUES (
          'legacy-session', 'legacy-event', 'legacy-speaker', 0,
          'Speaker', 'public'
        );
        """
    )
    deployed.executescript(migration)
    migrated = deployed.execute(
        """
        SELECT participation_status, participation_confirmed_at
          FROM session_speakers
         WHERE session_id = 'legacy-session'
           AND person_id = 'legacy-speaker'
        """
    ).fetchone()
    if migrated != ("pending", None):
        raise SystemExit(
            "Legacy session participation was not migrated to fail-closed pending state"
        )
    for status, confirmed_at in (("confirmed", None), ("pending", 1)):
        try:
            deployed.execute(
                """
                UPDATE session_speakers
                   SET participation_status = ?,
                       participation_confirmed_at = ?
                 WHERE session_id = 'legacy-session'
                   AND person_id = 'legacy-speaker'
                """,
                (status, confirmed_at),
            )
        except sqlite3.IntegrityError:
            continue
        raise SystemExit(
            "Session participation migration accepted an inconsistent confirmation"
        )

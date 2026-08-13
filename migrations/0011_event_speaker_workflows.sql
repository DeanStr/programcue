-- Event-roster workflow is an organiser-owned state distinct from account
-- invitation acceptance, public profile approval and per-session confirmation.

CREATE TABLE event_speaker_workflows (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('prospect','invited','confirmed','declined','withdrawn')
  ),
  source TEXT NOT NULL CHECK (
    source IN ('application','import','manual','session','membership','backfill')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT NOT NULL UNIQUE,
  updated_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, person_id),
  CHECK (
    updated_by_person_id IS NOT NULL
    OR source IN ('session','membership','backfill')
  )
);

CREATE INDEX idx_event_speaker_workflows_status
  ON event_speaker_workflows(event_id, status, person_id);

WITH roster(event_id, person_id, created_at) AS (
  SELECT membership.event_id, membership.person_id, membership.created_at
    FROM memberships membership
   WHERE membership.event_id IS NOT NULL
     AND membership.role = 'speaker'
     AND membership.revoked_at IS NULL
     AND (membership.accepted_at IS NOT NULL OR membership.invited_at IS NOT NULL)
  UNION ALL
  SELECT speaker.event_id, speaker.person_id, session.created_at
    FROM session_speakers speaker
    JOIN sessions session
      ON session.id = speaker.session_id AND session.event_id = speaker.event_id
)
INSERT INTO event_speaker_workflows (
  event_id, person_id, status, source, last_operation_id,
  updated_by_person_id, created_at, updated_at
)
SELECT roster.event_id, roster.person_id,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM session_speakers speaker
            WHERE speaker.event_id = roster.event_id
              AND speaker.person_id = roster.person_id
              AND speaker.participation_status = 'confirmed'
         ) THEN 'confirmed'
         ELSE 'invited'
       END
       ,
       'backfill',
       'speaker-workflow-backfill:' || roster.event_id || ':' || roster.person_id,
       NULL,
       MIN(roster.created_at),
       unixepoch()
  FROM roster
 GROUP BY roster.event_id, roster.person_id;

-- These triggers create missing workflow state and promote system-derived
-- state when a speaker confirms session participation. They never overwrite an
-- organiser-owned status when membership or session participation changes.
CREATE TRIGGER event_speaker_workflow_membership_insert
AFTER INSERT ON memberships
WHEN NEW.event_id IS NOT NULL
 AND NEW.role = 'speaker'
 AND NEW.revoked_at IS NULL
 AND (NEW.accepted_at IS NOT NULL OR NEW.invited_at IS NOT NULL)
BEGIN
  INSERT INTO event_speaker_workflows (
    event_id, person_id, status, source, last_operation_id,
    updated_by_person_id, created_at, updated_at
  ) VALUES (
    NEW.event_id,
    NEW.person_id,
    CASE WHEN EXISTS (
      SELECT 1 FROM session_speakers speaker
       WHERE speaker.event_id = NEW.event_id
         AND speaker.person_id = NEW.person_id
         AND speaker.participation_status = 'confirmed'
    ) THEN 'confirmed' ELSE 'invited' END
    ,
    'membership',
    'speaker-workflow-membership:' || NEW.event_id || ':' || NEW.person_id,
    NULL,
    NEW.created_at,
    unixepoch()
  ) ON CONFLICT(event_id, person_id) DO NOTHING;
END;

CREATE TRIGGER event_speaker_workflow_membership_update
AFTER UPDATE OF event_id, role, invited_at, accepted_at, revoked_at ON memberships
WHEN NEW.event_id IS NOT NULL
 AND NEW.role = 'speaker'
 AND NEW.revoked_at IS NULL
 AND (NEW.accepted_at IS NOT NULL OR NEW.invited_at IS NOT NULL)
BEGIN
  INSERT INTO event_speaker_workflows (
    event_id, person_id, status, source, last_operation_id,
    updated_by_person_id, created_at, updated_at
  ) VALUES (
    NEW.event_id,
    NEW.person_id,
    CASE WHEN EXISTS (
      SELECT 1 FROM session_speakers speaker
       WHERE speaker.event_id = NEW.event_id
         AND speaker.person_id = NEW.person_id
         AND speaker.participation_status = 'confirmed'
    ) THEN 'confirmed' ELSE 'invited' END
    ,
    'membership',
    'speaker-workflow-membership:' || NEW.event_id || ':' || NEW.person_id,
    NULL,
    NEW.created_at,
    unixepoch()
  ) ON CONFLICT(event_id, person_id) DO NOTHING;
END;

CREATE TRIGGER event_speaker_workflow_session_insert
AFTER INSERT ON session_speakers
BEGIN
  INSERT INTO event_speaker_workflows (
    event_id, person_id, status, source, last_operation_id,
    updated_by_person_id, created_at, updated_at
  ) VALUES (
    NEW.event_id,
    NEW.person_id,
    CASE WHEN NEW.participation_status = 'confirmed'
         THEN 'confirmed' ELSE 'invited' END
    ,
    'session',
    'speaker-workflow-session:' || NEW.event_id || ':' || NEW.person_id,
    NULL,
    (SELECT session.created_at FROM sessions session
      WHERE session.id = NEW.session_id AND session.event_id = NEW.event_id),
    unixepoch()
  ) ON CONFLICT(event_id, person_id) DO UPDATE SET
    status = 'confirmed',
    source = 'session',
    revision = event_speaker_workflows.revision + 1,
    last_operation_id = excluded.last_operation_id,
    updated_at = unixepoch()
  WHERE excluded.status = 'confirmed'
    AND event_speaker_workflows.status <> 'confirmed'
    AND event_speaker_workflows.source IN ('session','membership','backfill')
    AND event_speaker_workflows.updated_by_person_id IS NULL;
END;

CREATE TRIGGER event_speaker_workflow_session_participation_update
AFTER UPDATE OF participation_status, participation_confirmed_at
ON session_speakers
WHEN NEW.participation_status = 'confirmed'
 AND OLD.participation_status <> 'confirmed'
BEGIN
  UPDATE event_speaker_workflows
     SET status = 'confirmed',
         source = 'session',
         revision = revision + 1,
         last_operation_id =
           'speaker-workflow-session:' || NEW.event_id || ':' || NEW.person_id,
         updated_at = unixepoch()
   WHERE event_id = NEW.event_id
     AND person_id = NEW.person_id
     AND status <> 'confirmed'
     AND source IN ('session','membership','backfill')
     AND updated_by_person_id IS NULL;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM event_speaker_workflows
     WHERE event_id = NEW.event_id AND person_id = NEW.person_id
  ) THEN RAISE(ABORT, 'confirmed session speaker is missing event workflow state') END;
END;

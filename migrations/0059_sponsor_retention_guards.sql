-- Sponsor intake contains participant snapshots and contact details, even for
-- people who never joined the event roster. Remove any rows left behind by
-- retention completed before this migration; preserve accepted programme sessions.
DELETE FROM event_sponsorships
WHERE event_id IN (SELECT event_id FROM participant_retention_locked_events);

CREATE TRIGGER event_sponsorships_participant_retention_no_pii_insert
BEFORE INSERT ON event_sponsorships
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER event_sponsorships_participant_retention_no_pii_update
BEFORE UPDATE ON event_sponsorships
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sponsor_contacts_participant_retention_no_pii_insert
BEFORE INSERT ON sponsor_contacts
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sponsor_contacts_participant_retention_no_pii_update
BEFORE UPDATE ON sponsor_contacts
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sponsored_session_proposals_participant_retention_no_pii_insert
BEFORE INSERT ON sponsored_session_proposals
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sponsored_session_proposals_participant_retention_no_pii_update
BEFORE UPDATE ON sponsored_session_proposals
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

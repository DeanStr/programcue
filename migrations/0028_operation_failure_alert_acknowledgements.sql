ALTER TABLE operation_jobs
ADD COLUMN alert_acknowledged_at INTEGER;

ALTER TABLE operation_jobs
ADD COLUMN alert_acknowledged_by_person_id TEXT REFERENCES people(id);

CREATE INDEX idx_operation_jobs_event_failure_alert
  ON operation_jobs(event_id, status, alert_acknowledged_at, created_at DESC);

CREATE TRIGGER operation_jobs_failure_alert_attribution_insert
BEFORE INSERT ON operation_jobs
WHEN (NEW.alert_acknowledged_at IS NULL) <>
     (NEW.alert_acknowledged_by_person_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation failure acknowledgement requires timestamp and actor');
END;

CREATE TRIGGER operation_jobs_failure_alert_attribution_update
BEFORE UPDATE OF alert_acknowledged_at, alert_acknowledged_by_person_id
ON operation_jobs
WHEN (NEW.alert_acknowledged_at IS NULL) <>
     (NEW.alert_acknowledged_by_person_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation failure acknowledgement requires timestamp and actor');
END;

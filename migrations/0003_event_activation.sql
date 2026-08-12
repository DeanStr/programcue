ALTER TABLE events ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'active'
  CHECK (
    activation_status IN (
      'provisioning',
      'active',
      'provisioning_failed',
      'discarded'
    )
  );

-- The default above backfills rows created by the already-deployed migrations.
-- New Airtable events must persist provisioning intent explicitly and can only
-- become active through the reconciliation update path.
CREATE TRIGGER events_airtable_insert_requires_provisioning
BEFORE INSERT ON events
WHEN NEW.repository_provider = 'airtable'
 AND NEW.activation_status = 'active'
BEGIN
  SELECT RAISE(
    ABORT,
    'Airtable events must enter provisioning before activation'
  );
END;

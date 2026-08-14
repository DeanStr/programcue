-- The fixture is pre-release and has no retained public-slug compatibility
-- contract. Keep the stable internal ID while making the attendee-facing slug
-- agree with the canonical 2027 event identity.
UPDATE events
   SET slug = 'future-of-events-2027',
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE id = 'evt-foe-2025'
   AND slug = 'future-of-events-2025';

-- A clean database does not contain the fixture yet, and a deployment may
-- already have the corrected slug. Any other value for this stable fixture ID
-- is unexpected drift: fail the migration instead of recording a silent no-op.
INSERT INTO people (id, email, display_name)
SELECT 'migration-0017-canonical-fixture-slug-guard', NULL,
       'Canonical fixture slug migration guard'
 WHERE EXISTS (
   SELECT 1
     FROM events
    WHERE id = 'evt-foe-2025'
      AND slug <> 'future-of-events-2027'
 );

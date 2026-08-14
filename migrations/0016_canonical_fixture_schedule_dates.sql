-- Migration 0015 moved the stable seeded schedule entry identifiers to 2027,
-- but a production evaluation run had already published a later schedule
-- version with generated entry identifiers. Shift every entry that still
-- falls inside the canonical fixture's former 2025 event window. Entries
-- outside that one event and window remain untouched.
UPDATE schedule_entries
   SET starts_at = starts_at + (
         unixepoch('2027-05-20T00:00:00Z') -
         unixepoch('2025-05-20T00:00:00Z')
       ),
       ends_at = ends_at + (
         unixepoch('2027-05-20T00:00:00Z') -
         unixepoch('2025-05-20T00:00:00Z')
       ),
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND starts_at >= unixepoch('2025-05-20T00:00:00Z')
   AND ends_at <= unixepoch('2025-05-22T23:59:59Z');

-- A reviewer must answer the conflict-of-interest question before a review can
-- be submitted. Declaring a conflict already has a durable outcome — the
-- assignment is recused — but the negative answer had no record at all, so the
-- question could only be asked by the interface and never enforced.
--
-- Null means no attestation was recorded. Existing drafts will be asked the
-- question on their next submit. Existing submitted and locked reviews also
-- remain null: they predate the rule, and assigning their submission time would
-- fabricate an affirmation the reviewer never made.
ALTER TABLE reviews ADD COLUMN conflict_affirmed_at INTEGER;

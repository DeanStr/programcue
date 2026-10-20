-- Deployment applies migrations before replacing the Worker. Reject late writes
-- from the old assistant before model inference, rather than creating another
-- unreportable run. Close this boundary before classifying the existing rows.
CREATE TRIGGER operation_jobs_assistant_report_boundary_insert
BEFORE INSERT ON operation_jobs
WHEN NEW.type = 'ai.assistant.run'
 AND json_type(NEW.payload_json, '$.instructionHash') IS 'text'
 AND json_type(NEW.payload_json, '$.requestLabel') IS NULL
 AND json_extract(NEW.payload_json, '$.reportUnavailableReason') IS NOT 'predates_retained_reports'
BEGIN
  SELECT RAISE(ABORT, 'Assistant requests require the updated application Worker. Retry after deployment completes.');
END;

-- The deployed assistant stored operation summaries, not retained answers,
-- evidence or measurements. Preserve those jobs for Operations without
-- presenting them as reports or inferring missing report content at runtime.
UPDATE operation_jobs
   SET payload_json = json_set(
     payload_json, '$.reportUnavailableReason', 'predates_retained_reports'
   )
 WHERE type = 'ai.assistant.run'
   AND json_type(payload_json, '$.requestLabel') IS NULL
   AND json_type(payload_json, '$.provider') IS 'text'
   AND json_type(payload_json, '$.model') IS 'text'
   AND json_type(payload_json, '$.instructionHash') IS 'text'
   AND json_extract(payload_json, '$.runId') = id;

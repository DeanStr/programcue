-- A verification challenge owns the authentication realm in which it was
-- requested. Outstanding pre-migration challenges cannot be classified, so
-- revoke those short-lived pending codes instead of allowing realm conversion.

ALTER TABLE submission_email_verifications
ADD COLUMN evaluation_generation_hash TEXT
CHECK (
  evaluation_generation_hash IS NULL
  OR length(evaluation_generation_hash) = 64
);

UPDATE submission_email_verifications
SET status = 'revoked'
WHERE status = 'pending';

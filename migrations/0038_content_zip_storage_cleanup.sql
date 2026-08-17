ALTER TABLE operation_jobs
ADD COLUMN content_zip_storage_cleaned_at INTEGER;

ALTER TABLE operation_jobs
ADD COLUMN content_zip_storage_cleanup_claim TEXT;

ALTER TABLE operation_jobs
ADD COLUMN content_zip_storage_cleanup_claimed_at INTEGER;

CREATE INDEX idx_content_zip_storage_cleanup
  ON operation_jobs(type, status, content_zip_storage_cleaned_at, content_zip_storage_cleanup_claim, content_zip_storage_cleanup_claimed_at, completed_at, updated_at)
 WHERE type = 'content.zip.export'
   AND status IN ('completed', 'failed', 'cancelled');

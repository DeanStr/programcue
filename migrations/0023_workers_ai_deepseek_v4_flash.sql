-- DeepSeek V4 Flash replaces GPT-OSS as Program Cue's sole Workers AI model.
-- Advancing the revision makes any concurrently open owner settings form fail
-- its normal compare-and-set check instead of overwriting the deployment move.
UPDATE organisation_ai_settings
   SET model = '@cf/deepseek-ai/deepseek-v4-flash-0731',
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE provider = 'workers_ai'
   AND model IN ('@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b');

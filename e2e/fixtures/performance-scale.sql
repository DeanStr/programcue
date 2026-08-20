-- Opt-in local performance fixture. The Playwright performance harness applies
-- this only to its freshly reset `.wrangler/e2e-state` database. It is not demo
-- seed data and is never applied by the normal correctness gate.

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 10000
)
INSERT INTO people (
  id, email, display_name, email_verified, organisation_name, job_title,
  profile_status, profile_revision, created_at, updated_at
)
SELECT printf('perf-scale-person-%05d', value),
       printf('scale-speaker-%05d@example.invalid', value),
       printf('Scale Speaker %05d', value),
       1,
       printf('Scale Organisation %03d', value % 250),
       CASE value % 4
         WHEN 0 THEN 'Founder'
         WHEN 1 THEN 'Programme Director'
         WHEN 2 THEN 'Operations Lead'
         ELSE 'Community Manager'
       END,
       CASE WHEN value % 5 = 0 THEN 'draft' ELSE 'published' END,
       1,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 10000
)
INSERT INTO memberships (
  id, organisation_id, event_id, person_id, role, invited_at, accepted_at,
  created_at
)
SELECT printf('perf-scale-membership-%05d', value),
       'org-future-events',
       'evt-foe-2025',
       printf('perf-scale-person-%05d', value),
       'speaker',
       1735689600 + value,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

-- Submissions use the same durable form-version and track-routing invariants as
-- production records. The scale fixture must not bypass those relationships or
-- the operational submission list fails before it can measure useful work. It
-- reuses the canonical event tracks so Event Setup remains a valid editable
-- record while the scale data is present.

INSERT INTO form_definitions (
  id, event_id, name, description, kind, status, public_slug, min_speakers,
  max_speakers, created_at, updated_at
) VALUES (
  'perf-scale-form',
  'evt-foe-2025',
  'Performance scale form',
  'Representative local-only submission form for scale validation.',
  'submission',
  'published',
  'performance-scale-form',
  1,
  4,
  1735689600,
  1735689600
);

WITH track_values(track_id, track_name, position) AS (
  VALUES ('demo-track-leadership', 'Leadership', 0),
         ('demo-track-ai', 'AI & Innovation', 1),
         ('demo-track-experience', 'Experience Design', 2),
         ('demo-track-operations', 'Event Operations', 3)
), routing AS (
  SELECT json_group_object(
           track_name,
           track_id
         ) AS track_ids_json,
         json_group_object(
           track_id,
           track_name
         ) AS track_names_json,
         json_group_array(track_name) AS track_options_json
    FROM track_values
), payload AS (
  SELECT json_object(
           'introduction', 'Submit a representative scale proposal.',
           'fields', json_array(
             json_object(
               'id', 'title',
               'label', 'Session title',
               'type', 'short_text',
               'required', json('true')
             ),
             json_object(
               'id', 'category',
               'label', 'Track',
               'type', 'multi_select',
               'required', json('true'),
               'options', json(track_options_json)
             ),
             json_object(
               'id', 'format',
               'label', 'Format',
               'type', 'select',
               'required', json('true'),
               'options', json_array(
                 'keynote', 'presentation', 'panel', 'workshop'
               )
             )
           )
         ) AS schema_json,
         json_object(
           'categories', json('{}'),
           'trackIds', json(track_ids_json),
           'trackNames', json(track_names_json),
           'teamNames', json('{}'),
           'directSessionDurationMinutes', NULL,
           'passwordHash', NULL
         ) AS routing_json
    FROM routing
)
INSERT INTO form_versions (
  id, event_id, form_id, version_number, schema_json, routing_json,
  settings_snapshot_json, status, published_at, created_at, updated_at
)
SELECT 'perf-scale-form-version-1',
       'evt-foe-2025',
       'perf-scale-form',
       1,
       schema_json,
       routing_json,
       json_object(
         'name', 'Performance scale form',
         'kind', 'submission',
         'publicSlug', 'performance-scale-form',
         'closesAt', NULL,
         'submissionLimit', NULL,
         'minSpeakers', 1,
         'maxSpeakers', 4,
         'accessMode', 'email_verified'
       ),
       'published',
       1735689600,
       1735689600,
       1735689600
  FROM payload;

INSERT INTO form_versions (
  id, event_id, form_id, version_number, schema_json, routing_json,
  settings_snapshot_json, status, created_at, updated_at
)
SELECT 'perf-scale-form-version-2',
       event_id,
       form_id,
       2,
       schema_json,
       routing_json,
       settings_snapshot_json,
       'draft',
       1735689601,
       1735689601
  FROM form_versions
 WHERE id = 'perf-scale-form-version-1';

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 10000
)
INSERT INTO submissions (
  id, event_id, form_version_id, submitter_person_id, submitter_email,
  public_reference, title, category, format, status, answers_json,
  submitted_snapshot_json, revision, submitted_at, created_at, updated_at
)
SELECT printf('perf-scale-submission-%05d', value),
       'evt-foe-2025',
       'perf-scale-form-version-1',
       printf('perf-scale-person-%05d', value),
       printf('scale-speaker-%05d@example.invalid', value),
       printf('SCALE-%05d', value),
       printf('Representative scale submission %05d', value),
       CASE value % 4
         WHEN 0 THEN 'Leadership'
         WHEN 1 THEN 'AI & Innovation'
         WHEN 2 THEN 'Experience Design'
         ELSE 'Event Operations'
       END,
       CASE value % 4
         WHEN 0 THEN 'keynote'
         WHEN 1 THEN 'presentation'
         WHEN 2 THEN 'panel'
         ELSE 'workshop'
       END,
       CASE value % 5
         WHEN 0 THEN 'submitted'
         WHEN 1 THEN 'assigned'
         WHEN 2 THEN 'in_review'
         WHEN 3 THEN 'decision_ready'
         ELSE 'accepted'
       END,
       json_object(
         'title', printf('Representative scale submission %05d', value),
         'category', json_array(CASE value % 4
           WHEN 0 THEN 'Leadership'
           WHEN 1 THEN 'AI & Innovation'
           WHEN 2 THEN 'Experience Design'
           ELSE 'Event Operations'
         END),
         'format', CASE value % 4
           WHEN 0 THEN 'keynote'
           WHEN 1 THEN 'presentation'
           WHEN 2 THEN 'panel'
           ELSE 'workshop'
         END,
         'abstract', printf('Deterministic representative abstract %05d', value)
       ),
       json_object(
         'formVersionId', 'perf-scale-form-version-1',
         'versionNumber', 1,
         'schema', json((
           SELECT schema_json
             FROM form_versions
            WHERE id = 'perf-scale-form-version-1'
         )),
         'answers', json_object(
           'title', printf('Representative scale submission %05d', value),
           'category', json_array(CASE value % 4
             WHEN 0 THEN 'Leadership'
             WHEN 1 THEN 'AI & Innovation'
             WHEN 2 THEN 'Experience Design'
             ELSE 'Event Operations'
           END),
           'format', CASE value % 4
             WHEN 0 THEN 'keynote'
             WHEN 1 THEN 'presentation'
             WHEN 2 THEN 'panel'
             ELSE 'workshop'
           END,
           'abstract', printf('Deterministic representative abstract %05d', value)
         ),
         'speakers', json_array(json_object(
           'name', printf('Scale Speaker %05d', value),
           'email', printf('scale-speaker-%05d@example.invalid', value),
           'biography', ''
         )),
         'uploads', json('{}')
       ),
       1,
       1735689600 + value,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 10000
)
INSERT INTO submission_track_selections (
  submission_id, event_id, track_id, track_name_snapshot, position
)
SELECT printf('perf-scale-submission-%05d', value),
       'evt-foe-2025',
       CASE value % 4
         WHEN 0 THEN 'demo-track-leadership'
         WHEN 1 THEN 'demo-track-ai'
         WHEN 2 THEN 'demo-track-experience'
         ELSE 'demo-track-operations'
       END,
       CASE value % 4
         WHEN 0 THEN 'Leadership'
         WHEN 1 THEN 'AI & Innovation'
         WHEN 2 THEN 'Experience Design'
         ELSE 'Event Operations'
       END,
       0
  FROM sequence;

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 10000
)
INSERT INTO submission_speakers (
  id, event_id, submission_id, person_id, email, display_name, role_label,
  position, invitation_status, is_primary, invited_at, claimed_at, created_at,
  updated_at
)
SELECT printf('perf-scale-submission-speaker-%05d', value),
       'evt-foe-2025',
       printf('perf-scale-submission-%05d', value),
       printf('perf-scale-person-%05d', value),
       printf('scale-speaker-%05d@example.invalid', value),
       printf('Scale Speaker %05d', value),
       'Speaker',
       0,
       'claimed',
       1,
       1735689600 + value,
       1735689600 + value,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

-- Ten percent of the speakers need one outstanding task. This gives the real
-- readiness filter a representative, indexed selective predicate.
WITH RECURSIVE sequence(value) AS (
  VALUES (10)
  UNION ALL
  SELECT value + 10 FROM sequence WHERE value < 10000
)
INSERT INTO task_instances (
  id, event_id, target_type, target_id, owner_person_id, title, task_type,
  impact, status, readiness_state, readiness_percent, revision, created_at,
  updated_at
)
SELECT printf('perf-scale-task-%05d', value),
       'evt-foe-2025',
       'speaker',
       printf('perf-scale-person-%05d', value),
       printf('perf-scale-person-%05d', value),
       'Provide final presentation details',
       'short_form',
       'high',
       'not_started',
       'at_risk',
       0,
       1,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

-- One percent have an uploaded, signature-valid file which is still private in
-- quarantine pending a scanner result.
WITH RECURSIVE sequence(value) AS (
  VALUES (100)
  UNION ALL
  SELECT value + 100 FROM sequence WHERE value < 10000
)
INSERT INTO file_assets (
  id, event_id, owner_person_id, target_type, target_id, asset_kind, status,
  created_at, updated_at
)
SELECT printf('perf-scale-asset-%05d', value),
       'evt-foe-2025',
       printf('perf-scale-person-%05d', value),
       'person',
       printf('perf-scale-person-%05d', value),
       'slides',
       'pending',
       1735689600 + value,
       1735689600 + value
  FROM sequence;

WITH RECURSIVE sequence(value) AS (
  VALUES (100)
  UNION ALL
  SELECT value + 100 FROM sequence WHERE value < 10000
)
INSERT INTO file_versions (
  id, event_id, asset_id, version_number, object_key, original_filename,
  declared_content_type, detected_content_type, size_bytes, checksum_sha256,
  object_etag, upload_status, signature_status, scan_status, created_at,
  uploaded_at
)
SELECT printf('perf-scale-file-version-%05d', value),
       'evt-foe-2025',
       printf('perf-scale-asset-%05d', value),
       1,
       printf('performance-scale/%05d/slides.pdf', value),
       printf('scale-slides-%05d.pdf', value),
       'application/pdf',
       'application/pdf',
       1048576 + value,
       printf('%064d', value),
       printf('"scale-etag-%05d"', value),
       'uploaded',
       'valid',
       'pending',
       1735689600 + value,
       1735689600 + value
  FROM sequence;

WITH RECURSIVE sequence(value) AS (
  VALUES (100)
  UNION ALL
  SELECT value + 100 FROM sequence WHERE value < 10000
)
UPDATE file_assets
   SET current_version_id = printf('perf-scale-file-version-%05d', sequence.value)
  FROM sequence
 WHERE id = printf('perf-scale-asset-%05d', sequence.value);

-- A 200-session / 199-entry draft gives schedule placement a typical indexed
-- conflict-validation set without polluting the normal demo programme.
INSERT INTO rooms (
  id, event_id, name, capacity, resources_json, position, status
) VALUES (
  'perf-scale-room', 'evt-foe-2025', 'Scale validation room', 500, '[]', 99,
  'active'
);

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 200
)
INSERT INTO sessions (
  id, event_id, title, slug, description, format, duration_minutes,
  expected_attendance, required_resources_json, status, visibility, revision,
  created_at, updated_at
)
SELECT printf('perf-scale-session-%03d', value),
       'evt-foe-2025',
       printf('Scale schedule session %03d', value),
       printf('scale-schedule-session-%03d', value),
       'Representative local schedule-validation record.',
       'presentation',
       30,
       100,
       '[]',
       CASE WHEN value = 200 THEN 'unscheduled' ELSE 'scheduled' END,
       'private',
       1,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

INSERT INTO schedule_versions (
  id, event_id, version_number, name, status, revision,
  created_by_person_id, created_at
) VALUES (
  'perf-scale-schedule-draft', 'evt-foe-2025', 999,
  'Performance evidence draft', 'draft', 1,
  'person-demo-admin', 1735689600
);

WITH RECURSIVE sequence(value) AS (
  VALUES (1)
  UNION ALL
  SELECT value + 1 FROM sequence WHERE value < 199
)
INSERT INTO schedule_entries (
  id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at,
  revision, created_at, updated_at
)
SELECT printf('perf-scale-entry-%03d', value),
       'evt-foe-2025',
       'perf-scale-schedule-draft',
       printf('perf-scale-session-%03d', value),
       CASE value % 5
         WHEN 0 THEN 'main'
         WHEN 1 THEN '301a'
         WHEN 2 THEN '301b'
         WHEN 3 THEN '302'
         ELSE '303'
       END,
       unixepoch('2027-05-20T13:00:00Z') + CAST((value - 1) / 5 AS INTEGER) * 1800,
       unixepoch('2027-05-20T13:00:00Z') + CAST((value - 1) / 5 AS INTEGER) * 1800 + 1800,
       1,
       1735689600 + value,
       1735689600 + value
  FROM sequence;

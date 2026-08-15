PRAGMA foreign_keys = ON;

-- Program Cue is pre-release. This file is the complete clean baseline, not an
-- incremental compatibility migration.

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  image_url TEXT,
  biography TEXT,
  pronunciation TEXT,
  organisation_name TEXT,
  job_title TEXT,
  profile_status TEXT NOT NULL DEFAULT 'draft' CHECK (profile_status IN ('draft','published','archived')),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE organisation_ai_settings (
  organisation_id TEXT PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('workers_ai','openai','anthropic')),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_updated_by_person_id TEXT REFERENCES people(id),
  last_operation_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  venue_name TEXT,
  city TEXT,
  description TEXT,
  brand_accent TEXT NOT NULL DEFAULT '#4f46e5' CHECK (
    length(brand_accent) = 7
    AND substr(brand_accent, 1, 1) = '#'
    AND substr(brand_accent, 2) NOT GLOB '*[^0-9A-Fa-f]*'
  ),
  session_formats_json TEXT NOT NULL DEFAULT '[{"key":"keynote","label":"Keynote","defaultDurationMinutes":60,"position":0},{"key":"presentation","label":"Presentation","defaultDurationMinutes":45,"position":1},{"key":"panel","label":"Panel","defaultDurationMinutes":60,"position":2},{"key":"workshop","label":"Workshop","defaultDurationMinutes":90,"position":3},{"key":"breakout","label":"Breakout","defaultDurationMinutes":45,"position":4},{"key":"break","label":"Break","defaultDurationMinutes":30,"position":5},{"key":"other","label":"Other","defaultDurationMinutes":30,"position":6}]' CHECK (json_valid(session_formats_json)),
  repository_provider TEXT NOT NULL DEFAULT 'd1' CHECK (repository_provider IN ('d1','airtable')),
  repository_locked_at INTEGER,
  retention_months INTEGER NOT NULL DEFAULT 24 CHECK (retention_months IN (12,24,36)),
  file_retention_hold_at INTEGER,
  participant_retention_completed_at INTEGER,
  submission_access_mode TEXT NOT NULL DEFAULT 'email_verified' CHECK (submission_access_mode IN ('email_verified','account_required','password_protected')),
  allow_anonymous_drafts INTEGER NOT NULL DEFAULT 1 CHECK (allow_anonymous_drafts IN (0,1)),
  duplicate_person_warnings INTEGER NOT NULL DEFAULT 1 CHECK (duplicate_person_warnings IN (0,1)),
  file_policy_json TEXT NOT NULL CHECK (
    json_valid(file_policy_json)
    AND json_type(file_policy_json, '$.headshotMaximumBytes') = 'integer'
    AND json_extract(file_policy_json, '$.headshotMaximumBytes') BETWEEN 1048576 AND 10485760
    AND json_extract(file_policy_json, '$.headshotMaximumBytes') % 1048576 = 0
    AND json_type(file_policy_json, '$.slidesMaximumBytes') = 'integer'
    AND json_extract(file_policy_json, '$.slidesMaximumBytes') BETWEEN 1048576 AND 104857600
    AND json_extract(file_policy_json, '$.slidesMaximumBytes') % 1048576 = 0
    AND json_type(file_policy_json, '$.supportingDocumentMaximumBytes') = 'integer'
    AND json_extract(file_policy_json, '$.supportingDocumentMaximumBytes') BETWEEN 1048576 AND 104857600
    AND json_extract(file_policy_json, '$.supportingDocumentMaximumBytes') % 1048576 = 0
    AND json_type(file_policy_json, '$.videoMaximumBytes') = 'integer'
    AND json_extract(file_policy_json, '$.videoMaximumBytes') BETWEEN 1048576 AND 1073741824
    AND json_extract(file_policy_json, '$.videoMaximumBytes') % 1048576 = 0
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  last_updated_by_person_id TEXT REFERENCES people(id),
  programme_published_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (slug),
  UNIQUE (id, organisation_id)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','administrator','committee_chair','evaluator','submitter','speaker')),
  invited_at INTEGER,
  invitation_expires_at INTEGER,
  accepted_at INTEGER,
  revoked_at INTEGER,
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (role IN ('owner','administrator') OR event_id IS NOT NULL),
  FOREIGN KEY (event_id, organisation_id) REFERENCES events(id, organisation_id) ON DELETE CASCADE
);

CREATE TABLE form_definitions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('submission','direct_session')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  public_slug TEXT NOT NULL,
  closes_at INTEGER,
  submission_limit INTEGER CHECK (submission_limit IS NULL OR submission_limit > 0),
  min_speakers INTEGER NOT NULL DEFAULT 1 CHECK (min_speakers >= 1),
  max_speakers INTEGER CHECK (max_speakers IS NULL OR max_speakers >= min_speakers),
  access_mode TEXT NOT NULL DEFAULT 'email_verified' CHECK (access_mode IN ('email_verified','account_required','password_protected')),
  access_password_hash TEXT,
  confirmation_template_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(public_slug),
  UNIQUE(id, event_id),
  CHECK ((access_mode = 'password_protected' AND access_password_hash IS NOT NULL) OR access_mode <> 'password_protected')
);

CREATE TABLE form_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  routing_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(routing_json)),
  settings_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_snapshot_json)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at INTEGER,
  retired_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(form_id, version_number),
  UNIQUE(id, event_id),
  FOREIGN KEY (form_id, event_id) REFERENCES form_definitions(id, event_id) ON DELETE CASCADE,
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  form_version_id TEXT,
  submitter_person_id TEXT REFERENCES people(id),
  submitter_email TEXT COLLATE NOCASE,
  public_reference TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  category TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','assigned','in_review','decision_ready','accepted','waitlisted','rejected','withdrawn')),
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  submitted_snapshot_json TEXT CHECK (submitted_snapshot_json IS NULL OR json_valid(submitted_snapshot_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  submitted_at INTEGER,
  withdrawn_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, public_reference),
  UNIQUE(id, event_id),
  FOREIGN KEY (form_version_id, event_id) REFERENCES form_versions(id, event_id),
  CHECK (
    (status = 'draft' AND submitted_at IS NULL AND submitted_snapshot_json IS NULL)
    OR
    (status <> 'draft' AND submitted_at IS NOT NULL AND submitted_snapshot_json IS NOT NULL)
  )
);

CREATE TABLE submission_revisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json)),
  speaker_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(speaker_snapshot_json)),
  save_kind TEXT NOT NULL DEFAULT 'autosave' CHECK (save_kind IN ('autosave','manual','submitted','withdrawn')),
  saved_by_person_id TEXT REFERENCES people(id),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(submission_id, revision_number),
  UNIQUE(submission_id, idempotency_key),
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (form_version_id, event_id) REFERENCES form_versions(id, event_id)
);

CREATE TABLE submission_email_verifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  submission_id TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','revoked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (form_id, event_id) REFERENCES form_definitions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE
);
CREATE TABLE submission_speakers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  person_id TEXT REFERENCES people(id),
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role_label TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  invitation_status TEXT NOT NULL DEFAULT 'pending' CHECK (invitation_status IN ('pending','sent','claimed','declined','expired','revoked')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  claim_token_hash TEXT UNIQUE,
  invitation_expires_at INTEGER,
  invited_at INTEGER,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(submission_id, position),
  UNIQUE(submission_id, email),
  UNIQUE(id, event_id),
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE evaluation_plans (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','archived')),
  blinded_reviewing INTEGER NOT NULL DEFAULT 0 CHECK (blinded_reviewing IN (0,1)),
  decision_role TEXT NOT NULL DEFAULT 'administrator' CHECK (decision_role IN ('administrator','committee_chair')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE TABLE evaluation_teams (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  chair_person_id TEXT REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, name),
  UNIQUE(id, event_id)
);

CREATE TABLE evaluation_team_members (
  team_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'evaluator' CHECK (role IN ('chair','evaluator')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  removed_at INTEGER,
  PRIMARY KEY (team_id, person_id),
  FOREIGN KEY (team_id, event_id) REFERENCES evaluation_teams(id, event_id) ON DELETE CASCADE
);

CREATE TABLE evaluation_rounds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','archived')),
  opens_at INTEGER,
  closes_at INTEGER,
  advancement_rule_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(advancement_rule_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(plan_id, round_number),
  UNIQUE(id, event_id),
  FOREIGN KEY (plan_id, event_id) REFERENCES evaluation_plans(id, event_id) ON DELETE CASCADE,
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE evaluation_criteria (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_type TEXT NOT NULL DEFAULT 'scale_5' CHECK (input_type IN ('scale_5','scale_10','yes_no','free_text')),
  weight_percent INTEGER NOT NULL DEFAULT 0 CHECK (weight_percent BETWEEN 0 AND 100),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  UNIQUE(round_id, position),
  CHECK ((input_type IN ('free_text','yes_no')) OR weight_percent > 0)
);

CREATE TABLE evaluator_conflicts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT,
  session_id TEXT,
  evaluator_person_id TEXT NOT NULL REFERENCES people(id),
  relationship TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','recused','waived','dismissed')),
  declared_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_by_person_id TEXT REFERENCES people(id),
  resolved_at INTEGER,
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  CHECK ((submission_id IS NOT NULL) <> (session_id IS NOT NULL))
);

CREATE TABLE evaluator_assignments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT,
  session_id TEXT,
  session_snapshot_json TEXT CHECK (session_snapshot_json IS NULL OR json_valid(session_snapshot_json)),
  evaluator_person_id TEXT NOT NULL REFERENCES people(id),
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','recused','reopened','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  due_at INTEGER,
  conflict_declared_at INTEGER,
  assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at INTEGER,
  UNIQUE(id, event_id),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, event_id) REFERENCES evaluation_teams(id, event_id),
  CHECK (
    (submission_id IS NOT NULL AND session_id IS NULL AND session_snapshot_json IS NULL)
    OR
    (submission_id IS NULL AND session_id IS NOT NULL AND session_snapshot_json IS NOT NULL)
  )
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','locked','reopened')),
  scores_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scores_json)),
  weighted_score REAL,
  recommendation TEXT CHECK (recommendation IN ('accept','minor_changes','conditional_accept','waitlist','reject')),
  confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
  submitter_feedback TEXT,
  private_notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at INTEGER,
  locked_at INTEGER,
  UNIQUE(assignment_id),
  UNIQUE(id, event_id),
  FOREIGN KEY (assignment_id, event_id) REFERENCES evaluator_assignments(id, event_id) ON DELETE CASCADE
);

CREATE TABLE evaluation_discussion_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT,
  session_id TEXT,
  author_person_id TEXT NOT NULL REFERENCES people(id),
  body TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  UNIQUE(event_id, author_person_id, idempotency_key),
  CHECK (
    (submission_id IS NOT NULL AND session_id IS NULL)
    OR (submission_id IS NULL AND session_id IS NOT NULL)
  ),
  CHECK (body IS NULL OR (length(trim(body)) BETWEEN 1 AND 2000))
);

CREATE TABLE review_revisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  scores_json TEXT NOT NULL CHECK (json_valid(scores_json)),
  content_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(content_json)),
  save_kind TEXT NOT NULL DEFAULT 'autosave' CHECK (save_kind IN ('autosave','manual','submitted','reopened')),
  saved_by_person_id TEXT NOT NULL REFERENCES people(id),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(review_id, revision_number),
  UNIQUE(review_id, idempotency_key),
  FOREIGN KEY (review_id, event_id) REFERENCES reviews(id, event_id) ON DELETE CASCADE
);

CREATE TABLE review_moderations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  moderator_person_id TEXT NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  recommendation TEXT CHECK (recommendation IN ('accept','waitlist','reject','advance')),
  moderated_score REAL,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  confirmed_at INTEGER,
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE submission_decisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  round_id TEXT,
  revision_number INTEGER NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','revoked')),
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','waitlisted')),
  decided_by_person_id TEXT NOT NULL REFERENCES people(id),
  rationale TEXT,
  notification_feedback_json TEXT NOT NULL CHECK (json_valid(notification_feedback_json)),
  effect_preview_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(effect_preview_json)),
  idempotency_key TEXT,
  decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(submission_id, revision_number),
  UNIQUE(event_id, idempotency_key),
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  colour_token TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0,1)),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0,1)),
  UNIQUE(event_id, slug),
  UNIQUE(id, event_id)
);

CREATE TABLE submission_track_selections (
  submission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_name_snapshot TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (submission_id, track_id),
  UNIQUE (submission_id, position),
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (track_id, event_id) REFERENCES tracks(id, event_id)
);

CREATE TABLE submission_routing_teams (
  submission_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (submission_id, team_id),
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, event_id) REFERENCES evaluation_teams(id, event_id)
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  building TEXT,
  level TEXT,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  resources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resources_json)),
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE(id, event_id)
);

CREATE TABLE schedule_policies (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  room_overlap_action TEXT NOT NULL DEFAULT 'block' CHECK (room_overlap_action IN ('allow','warn','block')),
  speaker_overlap_action TEXT NOT NULL DEFAULT 'block' CHECK (speaker_overlap_action IN ('allow','warn','block')),
  required_resource_overlap_action TEXT NOT NULL DEFAULT 'block' CHECK (required_resource_overlap_action IN ('allow','warn','block')),
  exclusive_track_overlap_action TEXT NOT NULL DEFAULT 'warn' CHECK (exclusive_track_overlap_action IN ('allow','warn','block')),
  event_boundary_action TEXT NOT NULL DEFAULT 'block' CHECK (event_boundary_action IN ('allow','warn','block')),
  capacity_action TEXT NOT NULL DEFAULT 'warn' CHECK (capacity_action IN ('allow','warn','block')),
  minimum_turnaround_minutes INTEGER NOT NULL DEFAULT 0 CHECK (minimum_turnaround_minutes >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER events_create_schedule_policy
AFTER INSERT ON events
BEGIN
  INSERT INTO schedule_policies (event_id) VALUES (NEW.id);
END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_submission_id TEXT,
  track_id TEXT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  format TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  expected_attendance INTEGER CHECK (expected_attendance IS NULL OR expected_attendance >= 0),
  required_resources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_resources_json)),
  status TEXT NOT NULL DEFAULT 'unscheduled' CHECK (status IN ('unscheduled','scheduled','published','cancelled','archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','hidden')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, slug),
  UNIQUE(id, event_id),
  FOREIGN KEY (source_submission_id, event_id) REFERENCES submissions(id, event_id),
  FOREIGN KEY (track_id, event_id) REFERENCES tracks(id, event_id)
);

CREATE TABLE session_speakers (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  role_label TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','hidden')),
  PRIMARY KEY (session_id, person_id),
  UNIQUE(session_id, position),
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  colour_token TEXT,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE TABLE session_tags (
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, tag_id),
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id, event_id) REFERENCES tags(id, event_id) ON DELETE CASCADE
);

CREATE TABLE session_archives (
  session_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  previous_status TEXT NOT NULL CHECK (previous_status IN ('unscheduled','cancelled')),
  archived_by_person_id TEXT NOT NULL REFERENCES people(id),
  archive_operation_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_operation_id, event_id) REFERENCES operation_jobs(id, event_id)
);

CREATE TABLE schedule_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publishing','published','archived','failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  publication_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(event_id, version_number),
  UNIQUE(id, event_id),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE schedule_session_contents (
  schedule_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  track_id TEXT,
  format TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  required_resources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_resources_json)),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private','hidden')),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (schedule_version_id, session_id),
  UNIQUE(schedule_version_id, session_id, event_id),
  FOREIGN KEY (schedule_version_id, event_id) REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (track_id, event_id) REFERENCES tracks(id, event_id)
);

-- Every draft begins with a complete, version-owned content snapshot. New
-- sessions are also captured when a draft already exists. Commands update the
-- draft row explicitly; published rows are never derived from mutable sessions.
CREATE TRIGGER schedule_versions_seed_session_content
AFTER INSERT ON schedule_versions
BEGIN
  INSERT INTO schedule_session_contents (
    schedule_version_id, event_id, session_id, title, slug, description,
    track_id, format, duration_minutes, required_resources_json, visibility,
    created_at, updated_at
  )
  SELECT NEW.id, session.event_id, session.id, session.title, session.slug,
         session.description, session.track_id, session.format,
         session.duration_minutes, session.required_resources_json,
         session.visibility, unixepoch(), unixepoch()
    FROM sessions session
   WHERE session.event_id = NEW.event_id;
END;

CREATE TRIGGER sessions_seed_draft_schedule_content
AFTER INSERT ON sessions
BEGIN
  INSERT INTO schedule_session_contents (
    schedule_version_id, event_id, session_id, title, slug, description,
    track_id, format, duration_minutes, required_resources_json, visibility,
    created_at, updated_at
  )
  SELECT version.id, NEW.event_id, NEW.id, NEW.title, NEW.slug,
         NEW.description, NEW.track_id, NEW.format, NEW.duration_minutes,
         NEW.required_resources_json, NEW.visibility, unixepoch(), unixepoch()
    FROM schedule_versions version
   WHERE version.event_id = NEW.event_id AND version.status = 'draft';
END;

CREATE TABLE schedule_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(schedule_version_id, session_id),
  UNIQUE(id, event_id),
  FOREIGN KEY (schedule_version_id, event_id) REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, event_id) REFERENCES rooms(id, event_id)
);

CREATE TABLE schedule_conflicts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('room','speaker','track','event_boundary','capacity','required_resource','resource_configuration','room_resource','turnaround')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','blocking')),
  fingerprint TEXT NOT NULL,
  primary_entry_id TEXT,
  conflicting_entry_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_by_person_id TEXT REFERENCES people(id),
  resolved_at INTEGER,
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  UNIQUE(schedule_version_id, fingerprint),
  FOREIGN KEY (schedule_version_id, event_id) REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE public_itineraries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
  visitor_key_hash TEXT,
  share_token_hash TEXT UNIQUE,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (person_id IS NOT NULL OR visitor_key_hash IS NOT NULL),
  UNIQUE(event_id, person_id),
  UNIQUE(event_id, visitor_key_hash)
);

CREATE TABLE public_itinerary_items (
  itinerary_id TEXT NOT NULL REFERENCES public_itineraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (itinerary_id, session_id)
);

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('speaker','session','event')),
  task_type TEXT NOT NULL DEFAULT 'checklist' CHECK (task_type IN ('checklist','acknowledgement','short_form','file_upload','link_visit','administrator_only')),
  impact TEXT NOT NULL CHECK (impact IN ('critical','high','medium','low')),
  evidence_mode TEXT NOT NULL DEFAULT 'none' CHECK (evidence_mode IN ('none','checkbox','file','text','link','admin_approval')),
  due_anchor TEXT NOT NULL DEFAULT 'none' CHECK (due_anchor IN ('none','acceptance','session_start','fixed')),
  due_offset_minutes INTEGER,
  fixed_due_at INTEGER,
  auto_assign_on_acceptance INTEGER NOT NULL CHECK (auto_assign_on_acceptance IN (0,1)),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id),
  CHECK (due_anchor <> 'fixed' OR fixed_due_at IS NOT NULL),
  CHECK (due_anchor NOT IN ('acceptance','session_start') OR due_offset_minutes IS NOT NULL),
  CHECK (auto_assign_on_acceptance = 0 OR due_anchor <> 'session_start')
);

CREATE TABLE task_template_dependencies (
  template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  depends_on_template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (template_id, depends_on_template_id),
  CHECK (template_id <> depends_on_template_id)
);

CREATE TABLE task_instances (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES task_templates(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('speaker','session','event')),
  target_id TEXT NOT NULL,
  owner_person_id TEXT REFERENCES people(id),
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL DEFAULT 'checklist' CHECK (task_type IN ('checklist','acknowledgement','short_form','file_upload','link_visit','administrator_only')),
  impact TEXT NOT NULL CHECK (impact IN ('critical','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','blocked','submitted','completed','waived','overdue')),
  readiness_state TEXT NOT NULL DEFAULT 'on_track' CHECK (readiness_state IN ('on_track','at_risk','overdue','blocked')),
  readiness_percent INTEGER NOT NULL DEFAULT 0 CHECK (readiness_percent BETWEEN 0 AND 100),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  idempotency_key TEXT,
  due_at INTEGER,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  waiver_json TEXT CHECK (waiver_json IS NULL OR json_valid(waiver_json)),
  submitted_at INTEGER,
  completed_at INTEGER,
  completed_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE TABLE task_instance_dependencies (
  task_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_person_id TEXT NOT NULL REFERENCES people(id),
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'participant' CHECK (visibility IN ('participant','administrator')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  edited_at INTEGER,
  FOREIGN KEY (task_id, event_id) REFERENCES task_instances(id, event_id) ON DELETE CASCADE
);

CREATE TABLE file_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_person_id TEXT REFERENCES people(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('person','submission','session','task','resource')),
  target_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('headshot','slides','video','supporting_document','resource_attachment','task_evidence','other')),
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','deleted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  object_key TEXT NOT NULL UNIQUE,
  multipart_upload_id TEXT,
  original_filename TEXT NOT NULL,
  declared_content_type TEXT NOT NULL,
  detected_content_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 TEXT,
  object_etag TEXT,
  upload_status TEXT NOT NULL DEFAULT 'requested' CHECK (upload_status IN ('requested','uploading','uploaded','failed','aborted')),
  signature_status TEXT NOT NULL DEFAULT 'pending' CHECK (signature_status IN ('pending','valid','invalid','failed')),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
  scan_provider TEXT,
  scan_result_json TEXT CHECK (scan_result_json IS NULL OR json_valid(scan_result_json)),
  scan_error TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  uploaded_at INTEGER,
  scanned_at INTEGER,
  released_at INTEGER,
  replaced_at INTEGER,
  deleted_at INTEGER,
  UNIQUE(asset_id, version_number),
  UNIQUE(id, event_id),
  UNIQUE(id, event_id, asset_id),
  FOREIGN KEY (asset_id, event_id) REFERENCES file_assets(id, event_id) ON DELETE CASCADE,
  CHECK (released_at IS NULL OR (upload_status = 'uploaded' AND signature_status = 'valid' AND scan_status = 'clean'))
);

CREATE TABLE file_multipart_uploads (
  version_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  upload_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','initiated','completing','completed','aborted','failed')),
  part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes > 0),
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  manifest_hash TEXT,
  expires_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (version_id, event_id, asset_id) REFERENCES file_versions(id, event_id, asset_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, event_id) REFERENCES file_assets(id, event_id) ON DELETE CASCADE
);

CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  submitted_by_person_id TEXT NOT NULL REFERENCES people(id),
  file_asset_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','superseded')),
  reviewed_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at INTEGER,
  FOREIGN KEY (task_id, event_id) REFERENCES task_instances(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (file_asset_id, event_id) REFERENCES file_assets(id, event_id)
);

CREATE TABLE resource_pages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  audience_scope TEXT NOT NULL DEFAULT 'all_speakers' CHECK (audience_scope IN ('all_speakers','accepted_speakers','custom')),
  acknowledgement_required INTEGER NOT NULL DEFAULT 0 CHECK (acknowledgement_required IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  UNIQUE(event_id, slug),
  UNIQUE(id, event_id)
);

CREATE TABLE resource_page_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  resource_page_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT,
  audience_scope TEXT NOT NULL DEFAULT 'all_speakers' CHECK (audience_scope IN ('all_speakers','accepted_speakers','custom')),
  acknowledgement_required INTEGER NOT NULL DEFAULT 0 CHECK (acknowledgement_required IN (0,1)),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  rendered_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(resource_page_id, version_number),
  UNIQUE(id, event_id),
  FOREIGN KEY (resource_page_id, event_id) REFERENCES resource_pages(id, event_id) ON DELETE CASCADE,
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE resource_audiences (
  resource_page_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','team','person','session','track')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (resource_page_version_id, target_type, target_id),
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE resource_attachments (
  resource_page_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  file_asset_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  PRIMARY KEY (resource_page_version_id, file_asset_id),
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (file_asset_id, event_id) REFERENCES file_assets(id, event_id)
);

CREATE TABLE resource_acknowledgements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  resource_page_id TEXT NOT NULL,
  resource_page_version_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  acknowledged_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_agent TEXT,
  UNIQUE(resource_page_version_id, person_id),
  FOREIGN KEY (resource_page_id, event_id) REFERENCES resource_pages(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id)
);

CREATE TABLE sender_profiles (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL COLLATE NOCASE,
  reply_to_email TEXT COLLATE NOCASE,
  provider TEXT NOT NULL CHECK (provider IN ('resend','mailpit')),
  provider_sender_id TEXT,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, name),
  UNIQUE(id, event_id)
);

CREATE TABLE communication_templates (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('submission_confirmation','decision','task_reminder','schedule','calendar','ad_hoc')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  last_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE TABLE communication_template_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('submission_confirmation','decision','task_reminder','schedule','calendar','ad_hoc')),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','push','calendar')),
  subject_template TEXT,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  rendered_preview_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(template_id, version_number, channel),
  UNIQUE(id, event_id),
  FOREIGN KEY (template_id, event_id) REFERENCES communication_templates(id, event_id) ON DELETE CASCADE,
  CHECK (
    channel <> 'email'
    OR (
      subject_template IS NOT NULL
      AND subject_template = trim(subject_template)
      AND length(subject_template) BETWEEN 1 AND 200
    )
  ),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE communication_triggers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES communication_templates(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('submission_confirmed','decision_published','task_due','task_overdue','schedule_published','manual')),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, trigger_type, template_id)
);

CREATE TABLE communications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_version_id TEXT,
  sender_profile_id TEXT,
  operation_id TEXT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'transactional' CHECK (kind IN ('transactional','optional')),
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','push','calendar')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','queued','sending','sent','partially_failed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  audience_json TEXT NOT NULL CHECK (json_valid(audience_json)),
  content_snapshot_json TEXT NOT NULL CHECK (json_valid(content_snapshot_json)),
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  scheduled_at INTEGER,
  queued_at INTEGER,
  sent_at INTEGER,
  cancelled_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, idempotency_key),
  UNIQUE(id, event_id),
  FOREIGN KEY (template_version_id, event_id) REFERENCES communication_template_versions(id, event_id),
  FOREIGN KEY (sender_profile_id, event_id) REFERENCES sender_profiles(id, event_id)
);

CREATE TABLE communication_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  communication_id TEXT NOT NULL,
  person_id TEXT REFERENCES people(id),
  recipient_address TEXT NOT NULL,
  recipient_name TEXT,
  source_id TEXT,
  source_values_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_values_json)),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','push','calendar')),
  provider TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','opened','clicked','bounced','suppressed','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  failure_code TEXT,
  failure_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(communication_id, idempotency_key),
  UNIQUE(provider, provider_message_id),
  UNIQUE(id, event_id),
  FOREIGN KEY (communication_id, event_id) REFERENCES communications(id, event_id) ON DELETE CASCADE
);

CREATE TABLE communication_delivery_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES communication_deliveries(id) ON DELETE CASCADE,
  provider_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(delivery_id, provider_event_id)
);

CREATE TABLE communication_unsubscribes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id),
  address TEXT NOT NULL COLLATE NOCASE,
  category TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER,
  UNIQUE(event_id, address, category)
);

CREATE TABLE calendar_connections (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  account_reference TEXT NOT NULL,
  encrypted_credentials TEXT,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_attention','revoked','disconnected')),
  expires_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(person_id, provider, account_reference),
  UNIQUE(id, event_id),
  FOREIGN KEY (event_id, organisation_id) REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  CHECK (status <> 'connected' OR (encrypted_credentials IS NOT NULL AND expires_at IS NOT NULL))
);

CREATE TABLE calendar_invitations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES calendar_connections(id),
  delivery_id TEXT REFERENCES communication_deliveries(id),
  ical_uid TEXT NOT NULL,
  sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
  method TEXT NOT NULL DEFAULT 'REQUEST' CHECK (method IN ('REQUEST','CANCEL')),
  provider_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','confirmed','cancelled','failed')),
  last_payload_hash TEXT,
  current_attempt_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, ical_uid),
  UNIQUE(session_id, person_id)
);

CREATE TABLE calendar_sync_attempts (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES calendar_invitations(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
  method TEXT NOT NULL CHECK (method IN ('REQUEST','CANCEL')),
  provider TEXT NOT NULL CHECK (provider IN ('email_ics','google','microsoft')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','superseded')),
  provider_event_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(invitation_id, sequence_number, provider)
);

CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected','needs_attention','failed','disconnected')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','bidirectional')),
  conflict_policy TEXT,
  encrypted_credentials TEXT,
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id),
  FOREIGN KEY (event_id, organisation_id) REFERENCES events(id, organisation_id) ON DELETE CASCADE
);

CREATE TABLE integration_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  operation_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partially_failed','failed','cancelled')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','bidirectional')),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(connection_id, idempotency_key)
);

CREATE TABLE integration_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES integration_runs(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  external_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','skip','noop')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  diff_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diff_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(run_id, entity_type, entity_id)
);

CREATE TABLE integration_entity_mappings (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  last_operation_id TEXT,
  last_synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(connection_id, entity_type, entity_id),
  UNIQUE(connection_id, entity_type, external_id)
);

CREATE TABLE operation_jobs (
  id TEXT PRIMARY KEY,
  organisation_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  requested_by_person_id TEXT REFERENCES people(id),
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','queue_failed','received','running','retrying','completed','partially_failed','failed','cancelled')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  progress_total INTEGER NOT NULL DEFAULT 0 CHECK (progress_total >= 0),
  progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0 AND progress_completed <= progress_total),
  progress_failed INTEGER NOT NULL DEFAULT 0 CHECK (progress_failed >= 0 AND progress_failed <= progress_total),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  cancellable INTEGER NOT NULL DEFAULT 0 CHECK (cancellable IN (0,1)),
  claim_token TEXT,
  claim_expires_at INTEGER,
  dispatched_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, idempotency_key),
  UNIQUE(correlation_id),
  UNIQUE(id, event_id)
);

CREATE TABLE operation_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operation_jobs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(operation_id, item_key)
);

CREATE TABLE event_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','updated','deleted','published','progress')),
  correlation_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  area TEXT NOT NULL CHECK (area IN ('submissions','evaluations','speakers','sessions','tasks','operations')),
  name TEXT NOT NULL,
  query_json TEXT NOT NULL CHECK (json_valid(query_json)),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','event')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, owner_person_id, area, name)
);

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  entity_type TEXT,
  entity_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE abuse_rate_limits (
  scope_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','failing')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  disabled_at INTEGER
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivering','delivered','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(endpoint_id, idempotency_key)
);

CREATE TABLE webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  request_timestamp INTEGER NOT NULL,
  response_status INTEGER,
  response_headers_json TEXT CHECK (response_headers_json IS NULL OR json_valid(response_headers_json)),
  response_excerpt TEXT,
  error_message TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(delivery_id, attempt_number)
);

CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','rejected','failed')),
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER,
  error_message TEXT,
  UNIQUE(provider, external_event_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  actor_person_id TEXT REFERENCES people(id),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  correlation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE assistant_proposal_executions (
  proposal_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  actor_person_id TEXT NOT NULL REFERENCES people(id),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed')),
  claim_token TEXT UNIQUE,
  claim_expires_at INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL AND result_json IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'completed' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND result_json IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX assistant_proposal_executions_claim_idx
  ON assistant_proposal_executions(status, claim_expires_at);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address TEXT,
  user_agent TEXT
);

CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(provider_id, account_id)
);

CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);

-- Tenant, lifecycle and user-facing list indexes.
CREATE INDEX idx_events_org ON events(organisation_id);
CREATE UNIQUE INDEX ux_api_keys_event_active_name ON api_keys(event_id, name) WHERE revoked_at IS NULL;
CREATE INDEX idx_memberships_person_event ON memberships(person_id, event_id, accepted_at, revoked_at);
CREATE INDEX idx_memberships_event_role_status ON memberships(event_id, role, accepted_at, revoked_at, person_id);
CREATE UNIQUE INDEX ux_memberships_org_role ON memberships(organisation_id, person_id, role) WHERE event_id IS NULL;
CREATE UNIQUE INDEX ux_memberships_event_role ON memberships(event_id, person_id, role) WHERE event_id IS NOT NULL;

CREATE INDEX idx_form_public_status ON form_definitions(public_slug, status);
CREATE UNIQUE INDEX ux_form_versions_one_published ON form_versions(form_id) WHERE status = 'published';
CREATE INDEX idx_form_versions_lookup ON form_versions(event_id, form_id, version_number DESC);
CREATE INDEX idx_submissions_event_status ON submissions(event_id, status, updated_at DESC);
CREATE INDEX idx_submissions_event_category_status ON submissions(event_id, category, status, updated_at DESC);
CREATE INDEX idx_submissions_submitter ON submissions(event_id, submitter_person_id, updated_at DESC);
CREATE INDEX idx_submissions_email ON submissions(event_id, submitter_email, updated_at DESC);
CREATE INDEX idx_submission_track_selections_event
  ON submission_track_selections(event_id, track_id, submission_id);
CREATE INDEX idx_submission_routing_teams_event
  ON submission_routing_teams(event_id, team_id, submission_id);
CREATE INDEX idx_submission_revisions_submission ON submission_revisions(submission_id, revision_number DESC);
CREATE INDEX idx_submission_verifications_form_email ON submission_email_verifications(event_id, form_id, email, status, expires_at);
CREATE INDEX idx_submission_speakers_person ON submission_speakers(event_id, person_id);

CREATE INDEX idx_evaluation_plans_event ON evaluation_plans(event_id, status);
CREATE INDEX idx_evaluation_rounds_active ON evaluation_rounds(event_id, status, round_number);
CREATE INDEX idx_team_members_person ON evaluation_team_members(event_id, person_id, removed_at);
CREATE INDEX idx_evaluator_conflicts_open ON evaluator_conflicts(event_id, evaluator_person_id, status);
CREATE UNIQUE INDEX ux_evaluator_conflicts_submission
  ON evaluator_conflicts(round_id, submission_id, evaluator_person_id)
  WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX ux_evaluator_conflicts_session
  ON evaluator_conflicts(round_id, session_id, evaluator_person_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_assignments_evaluator_status ON evaluator_assignments(event_id, evaluator_person_id, status, due_at);
CREATE INDEX idx_assignments_submission ON evaluator_assignments(event_id, submission_id, round_id);
CREATE INDEX idx_assignments_session ON evaluator_assignments(event_id, session_id, round_id);
CREATE INDEX idx_evaluation_discussion_submission
  ON evaluation_discussion_messages(event_id, round_id, submission_id, created_at, id);
CREATE INDEX idx_evaluation_discussion_session
  ON evaluation_discussion_messages(event_id, round_id, session_id, created_at, id);
CREATE UNIQUE INDEX ux_evaluator_assignments_submission
  ON evaluator_assignments(round_id, submission_id, evaluator_person_id)
  WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX ux_evaluator_assignments_session
  ON evaluator_assignments(round_id, session_id, evaluator_person_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_reviews_status ON reviews(event_id, status, updated_at DESC);
CREATE UNIQUE INDEX ux_review_moderations_current ON review_moderations(round_id, submission_id) WHERE status IN ('draft','confirmed');
CREATE UNIQUE INDEX ux_decisions_one_published ON submission_decisions(submission_id) WHERE status = 'published';

CREATE INDEX idx_sessions_event_status ON sessions(event_id, status, updated_at DESC);
CREATE UNIQUE INDEX ux_sessions_source_submission ON sessions(source_submission_id) WHERE source_submission_id IS NOT NULL;
CREATE INDEX idx_session_speakers_person ON session_speakers(event_id, person_id);
CREATE UNIQUE INDEX ux_tags_event_name ON tags(event_id, name);
CREATE INDEX idx_session_tags_tag ON session_tags(event_id, tag_id, session_id);
CREATE INDEX idx_session_archives_event ON session_archives(event_id, archived_at DESC);
CREATE UNIQUE INDEX ux_schedule_versions_one_draft ON schedule_versions(event_id) WHERE status = 'draft';
CREATE UNIQUE INDEX ux_schedule_versions_one_published ON schedule_versions(event_id) WHERE status = 'published';
CREATE INDEX idx_schedule_session_contents_event ON schedule_session_contents(event_id, session_id, schedule_version_id);
CREATE INDEX idx_schedule_entries_version_time ON schedule_entries(schedule_version_id, starts_at);
CREATE INDEX idx_schedule_entries_room_time ON schedule_entries(schedule_version_id, room_id, starts_at, ends_at);
CREATE INDEX idx_schedule_conflicts_open ON schedule_conflicts(event_id, schedule_version_id, resolved_at, severity);
CREATE INDEX idx_itinerary_person ON public_itineraries(event_id, person_id);
CREATE INDEX idx_itinerary_expiry ON public_itineraries(expires_at, id);

CREATE INDEX idx_tasks_event_status_due ON task_instances(event_id, status, due_at);
CREATE INDEX idx_tasks_target ON task_instances(event_id, target_type, target_id, status);
CREATE INDEX idx_tasks_owner_status ON task_instances(event_id, owner_person_id, status);
CREATE UNIQUE INDEX ux_task_instances_template_target
  ON task_instances(event_id, template_id, target_type, target_id)
  WHERE template_id IS NOT NULL;
CREATE UNIQUE INDEX idx_task_idempotency ON task_instances(event_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);
CREATE INDEX idx_task_evidence_task ON task_evidence(task_id, status, created_at DESC);

CREATE INDEX idx_files_target ON file_assets(event_id, target_type, target_id, status);
CREATE INDEX idx_files_owner_status ON file_assets(event_id, owner_person_id, status);
CREATE UNIQUE INDEX ux_file_assets_logical_active
  ON file_assets(event_id, owner_person_id, target_type, target_id, asset_kind)
  WHERE status <> 'deleted' AND target_type NOT IN ('task','resource');
CREATE INDEX idx_file_versions_release ON file_versions(asset_id, scan_status, released_at, version_number DESC);
CREATE UNIQUE INDEX ux_file_multipart_upload_id ON file_multipart_uploads(upload_id);
CREATE UNIQUE INDEX ux_file_multipart_idempotency ON file_multipart_uploads(event_id, idempotency_key);
CREATE INDEX idx_file_multipart_status_expiry ON file_multipart_uploads(status, expires_at);
CREATE UNIQUE INDEX ux_file_assets_current_version ON file_assets(current_version_id) WHERE current_version_id IS NOT NULL;
CREATE INDEX idx_resource_pages_audience ON resource_pages(event_id, status, audience_scope);
CREATE UNIQUE INDEX ux_resource_versions_one_published ON resource_page_versions(resource_page_id) WHERE status = 'published';
CREATE INDEX idx_resource_ack_person ON resource_acknowledgements(event_id, person_id, acknowledged_at DESC);

CREATE INDEX idx_templates_event_status ON communication_templates(event_id, status, category);
CREATE UNIQUE INDEX ux_template_channel_one_published ON communication_template_versions(template_id, channel) WHERE status = 'published';
CREATE INDEX idx_communications_status_schedule ON communications(event_id, status, scheduled_at);
CREATE INDEX idx_deliveries_communication_status ON communication_deliveries(communication_id, status, next_attempt_at);
CREATE INDEX idx_deliveries_provider_message ON communication_deliveries(provider, provider_message_id);
CREATE INDEX idx_calendar_invitation_status ON calendar_invitations(event_id, status, updated_at);
CREATE INDEX idx_calendar_attempt_status ON calendar_sync_attempts(status, created_at);

CREATE INDEX idx_integration_runs_connection ON integration_runs(connection_id, created_at DESC);
CREATE UNIQUE INDEX ux_integration_connections_event_provider
  ON integration_connections(event_id, provider) WHERE event_id IS NOT NULL;
CREATE INDEX idx_integration_items_status ON integration_run_items(run_id, status);
CREATE INDEX idx_operation_jobs_event_status ON operation_jobs(event_id, status, created_at DESC);
CREATE INDEX idx_operation_jobs_undispatched ON operation_jobs(type, status, dispatched_at, created_at);
CREATE INDEX idx_operation_items_status ON operation_items(operation_id, status, updated_at);
CREATE INDEX idx_event_changes_cursor ON event_changes(event_id, sequence);
CREATE INDEX idx_saved_views_owner ON saved_views(event_id, owner_person_id, area);
CREATE UNIQUE INDEX ux_idempotency_event ON idempotency_records(event_id, actor_id, scope, idempotency_key) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_idempotency_org ON idempotency_records(organisation_id, actor_id, scope, idempotency_key) WHERE event_id IS NULL;
CREATE INDEX idx_idempotency_expiry ON idempotency_records(expires_at);
CREATE INDEX idx_abuse_rate_limits_blocked_until ON abuse_rate_limits(blocked_until);
CREATE INDEX idx_abuse_rate_limits_updated_at ON abuse_rate_limits(updated_at);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_attempts_delivery ON webhook_delivery_attempts(delivery_id, attempt_number DESC);
CREATE INDEX idx_audit_event_created ON audit_events(event_id, created_at DESC);
CREATE INDEX idx_auth_sessions_person_expiry ON auth_sessions(person_id, expires_at);
CREATE INDEX idx_verification_identifier_expiry ON verification_tokens(identifier, expires_at);
CREATE INDEX idx_api_keys_event ON api_keys(event_id, revoked_at, expires_at);

-- Participant-PII ingress is closed after the durable retention tombstone.
-- Guards are intentionally limited to identity, participant content, recipient,
-- credential and private-file columns. Audit, operation, event-change, generic
-- webhook and backup/recovery bookkeeping remain writable.
-- The durable event tombstone is exposed through two small views so every
-- participant-data ingress guard uses the same boundary and identity set.
CREATE TRIGGER events_participant_retention_tombstone_immutable
BEFORE UPDATE OF participant_retention_completed_at ON events
WHEN OLD.participant_retention_completed_at IS NOT NULL
AND NEW.participant_retention_completed_at IS NOT OLD.participant_retention_completed_at
BEGIN
  SELECT RAISE(ABORT, 'event participant retention completion is immutable');
END;

CREATE VIEW participant_retention_locked_events AS
SELECT id AS event_id, organisation_id, participant_retention_completed_at AS completed_at
  FROM events
 WHERE participant_retention_completed_at IS NOT NULL;

CREATE VIEW participant_retention_locked_identities AS
SELECT audit.event_id, audit.entity_id AS person_id, 'pseudonym' AS identity_kind
  FROM audit_events audit
  JOIN participant_retention_locked_events locked ON locked.event_id = audit.event_id
 WHERE audit.action = 'participant.retention.subject_anonymised'
   AND audit.entity_type = 'person' AND audit.entity_id IS NOT NULL
UNION ALL
SELECT locked.event_id, person.id AS person_id, 'retired' AS identity_kind
  FROM participant_retention_locked_events locked
  JOIN people person
    ON person.last_operation_id = 'participant-retention:' || locked.event_id;

CREATE TRIGGER memberships_participant_retention_no_pii_insert
BEFORE INSERT ON memberships
WHEN NEW.event_id IS NOT NULL
AND NEW.role IN ('submitter','speaker')
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER memberships_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, person_id, role ON memberships
WHEN (OLD.role IN ('submitter','speaker') OR NEW.role IN ('submitter','speaker'))
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER form_definitions_participant_retention_no_pii_insert
BEFORE INSERT ON form_definitions
WHEN NEW.status = 'published' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER form_definitions_participant_retention_no_pii_update
BEFORE UPDATE OF status ON form_definitions
WHEN NEW.status = 'published' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER form_versions_participant_retention_no_pii_insert
BEFORE INSERT ON form_versions
WHEN NEW.status = 'published' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER form_versions_participant_retention_no_pii_update
BEFORE UPDATE OF status ON form_versions
WHEN NEW.status = 'published' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submissions_participant_retention_no_pii_insert
BEFORE INSERT ON submissions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submissions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, form_version_id, submitter_person_id, submitter_email, public_reference, title, category, format, answers_json, submitted_snapshot_json ON submissions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_revisions_participant_retention_no_pii_insert
BEFORE INSERT ON submission_revisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_revisions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, submission_id, form_version_id, answers_json, speaker_snapshot_json, saved_by_person_id ON submission_revisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_email_verifications_participant_retention_no_pii_insert
BEFORE INSERT ON submission_email_verifications
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_speakers_participant_retention_no_pii_insert
BEFORE INSERT ON submission_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_speakers_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, submission_id, person_id, email, display_name, role_label, invitation_status, claim_token_hash, invitation_expires_at ON submission_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluator_assignments_participant_retention_no_pii_insert
BEFORE INSERT ON evaluator_assignments
WHEN NEW.session_snapshot_json IS NOT NULL AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluator_assignments_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_snapshot_json ON evaluator_assignments
WHEN (OLD.session_snapshot_json IS NOT NULL OR NEW.session_snapshot_json IS NOT NULL)
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluator_conflicts_participant_retention_no_pii_insert
BEFORE INSERT ON evaluator_conflicts
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluator_conflicts_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, relationship, notes ON evaluator_conflicts
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER reviews_participant_retention_no_pii_insert
BEFORE INSERT ON reviews
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER reviews_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, scores_json, submitter_feedback, private_notes ON reviews
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluation_discussion_messages_participant_retention_no_pii_insert
BEFORE INSERT ON evaluation_discussion_messages
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER evaluation_discussion_messages_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, round_id, submission_id, session_id, author_person_id, body ON evaluation_discussion_messages
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER review_revisions_participant_retention_no_pii_insert
BEFORE INSERT ON review_revisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER review_revisions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, review_id, scores_json, content_json, saved_by_person_id ON review_revisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER review_moderations_participant_retention_no_pii_insert
BEFORE INSERT ON review_moderations
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER review_moderations_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, notes ON review_moderations
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_decisions_participant_retention_no_pii_insert
BEFORE INSERT ON submission_decisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER submission_decisions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, rationale, notification_feedback_json, effect_preview_json ON submission_decisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sessions_participant_retention_no_pii_insert
BEFORE INSERT ON sessions
WHEN NEW.source_submission_id IS NOT NULL AND NEW.description IS NOT NULL
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER sessions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, source_submission_id, description ON sessions
WHEN (OLD.source_submission_id IS NOT NULL OR NEW.source_submission_id IS NOT NULL)
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER schedule_session_contents_participant_retention_no_pii_insert
BEFORE INSERT ON schedule_session_contents
WHEN NEW.description IS NOT NULL
AND EXISTS (
  SELECT 1
    FROM sessions session
    JOIN participant_retention_locked_events locked
      ON locked.event_id = session.event_id
   WHERE session.id = NEW.session_id
     AND session.event_id = NEW.event_id
     AND session.source_submission_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER schedule_session_contents_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, description ON schedule_session_contents
WHEN EXISTS (
  SELECT 1
    FROM sessions session
    JOIN participant_retention_locked_events locked
      ON locked.event_id = session.event_id
   WHERE session.id IN (OLD.session_id, NEW.session_id)
     AND session.event_id IN (OLD.event_id, NEW.event_id)
     AND session.source_submission_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_speakers_participant_retention_no_pii_insert
BEFORE INSERT ON session_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_speakers_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER public_itineraries_participant_retention_no_pii_insert
BEFORE INSERT ON public_itineraries
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_instances_participant_retention_no_pii_insert
BEFORE INSERT ON task_instances
WHEN NEW.target_type = 'speaker' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_instances_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, target_type, target_id, owner_person_id, title, description, evidence_json, waiver_json, completed_by_person_id ON task_instances
WHEN (OLD.target_type = 'speaker' OR NEW.target_type = 'speaker')
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_comments_participant_retention_no_pii_insert
BEFORE INSERT ON task_comments
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id = NEW.task_id AND task.event_id = NEW.event_id
    AND task.target_type = 'speaker'
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_comments_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, task_id, author_person_id, body ON task_comments
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id IN (OLD.task_id, NEW.task_id)
    AND task.event_id IN (OLD.event_id, NEW.event_id)
    AND task.target_type = 'speaker'
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_evidence_participant_retention_no_pii_insert
BEFORE INSERT ON task_evidence
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id = NEW.task_id AND task.event_id = NEW.event_id
    AND task.target_type = 'speaker'
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_evidence_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, task_id, submitted_by_person_id, file_asset_id, evidence_json ON task_evidence
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id IN (OLD.task_id, NEW.task_id)
    AND task.event_id IN (OLD.event_id, NEW.event_id)
    AND task.target_type = 'speaker'
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_assets_participant_retention_no_pii_insert
BEFORE INSERT ON file_assets
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_assets_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, owner_person_id, target_type, target_id, current_version_id, status ON file_assets
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_versions_participant_retention_no_pii_insert
BEFORE INSERT ON file_versions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_versions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, asset_id, object_key, multipart_upload_id, original_filename, declared_content_type, detected_content_type, checksum_sha256, object_etag, scan_provider, scan_result_json, scan_error, created_by_person_id, released_at, deleted_at ON file_versions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_multipart_uploads_participant_retention_no_pii_insert
BEFORE INSERT ON file_multipart_uploads
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER file_multipart_uploads_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, asset_id, upload_id, idempotency_key, manifest_json, manifest_hash, last_error ON file_multipart_uploads
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_audiences_participant_retention_no_pii_insert
BEFORE INSERT ON resource_audiences
WHEN NEW.target_type = 'person' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_audiences_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, target_type, target_id ON resource_audiences
WHEN (OLD.target_type = 'person' OR NEW.target_type = 'person')
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_acknowledgements_participant_retention_no_pii_insert
BEFORE INSERT ON resource_acknowledgements
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_acknowledgements_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, resource_page_id, resource_page_version_id, person_id, user_agent ON resource_acknowledgements
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communications_participant_retention_no_pii_insert
BEFORE INSERT ON communications
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communications_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, audience_json, content_snapshot_json ON communications
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_deliveries_participant_retention_no_pii_insert
BEFORE INSERT ON communication_deliveries
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_deliveries_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, communication_id, person_id, recipient_address, recipient_name, source_id, source_values_json, provider, provider_message_id, idempotency_key, failure_code, failure_message ON communication_deliveries
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_delivery_events_participant_retention_no_pii_insert
BEFORE INSERT ON communication_delivery_events
WHEN EXISTS (
  SELECT 1 FROM communication_deliveries delivery
  JOIN participant_retention_locked_events locked ON locked.event_id = delivery.event_id
  WHERE delivery.id = NEW.delivery_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_delivery_events_participant_retention_no_pii_update
BEFORE UPDATE OF delivery_id, provider_event_id, payload_json ON communication_delivery_events
WHEN EXISTS (
  SELECT 1 FROM communication_deliveries delivery
  JOIN participant_retention_locked_events locked ON locked.event_id = delivery.event_id
  WHERE delivery.id IN (OLD.delivery_id, NEW.delivery_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_unsubscribes_participant_retention_no_pii_insert
BEFORE INSERT ON communication_unsubscribes
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER communication_unsubscribes_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, person_id, address, reason ON communication_unsubscribes
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_connections_participant_retention_no_pii_insert
BEFORE INSERT ON calendar_connections
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_connections_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, person_id, account_reference, encrypted_credentials, scopes_json ON calendar_connections
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_invitations_participant_retention_no_pii_insert
BEFORE INSERT ON calendar_invitations
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_invitations_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, person_id, connection_id, delivery_id, ical_uid, method, provider_event_id, status, last_payload_hash, current_attempt_id ON calendar_invitations
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_sync_attempts_participant_retention_no_pii_insert
BEFORE INSERT ON calendar_sync_attempts
WHEN EXISTS (
  SELECT 1 FROM calendar_invitations invitation
  JOIN participant_retention_locked_events locked ON locked.event_id = invitation.event_id
  WHERE invitation.id = NEW.invitation_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER calendar_sync_attempts_participant_retention_no_pii_update
BEFORE UPDATE OF invitation_id, provider_event_id, error_message ON calendar_sync_attempts
WHEN EXISTS (
  SELECT 1 FROM calendar_invitations invitation
  JOIN participant_retention_locked_events locked ON locked.event_id = invitation.event_id
  WHERE invitation.id IN (OLD.invitation_id, NEW.invitation_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER people_participant_retention_no_pii_update
BEFORE UPDATE OF id, email, display_name, email_verified, image_url, biography,
  pronunciation, organisation_name, job_title, profile_status, last_operation_id ON people
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_identities locked
  WHERE locked.person_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER auth_sessions_participant_retention_no_pii_insert
BEFORE INSERT ON auth_sessions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_identities locked
  WHERE locked.person_id = NEW.person_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER auth_accounts_participant_retention_no_pii_insert
BEFORE INSERT ON auth_accounts
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_identities locked
  WHERE locked.person_id = NEW.person_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER verification_tokens_participant_retention_no_pii_insert
BEFORE INSERT ON verification_tokens
WHEN EXISTS (
  SELECT 1 FROM form_definitions form
  JOIN participant_retention_locked_events locked ON locked.event_id = form.event_id
  WHERE substr(NEW.identifier, 1, length('application-session:' || form.id || ':')) =
          'application-session:' || form.id || ':'
     OR substr(NEW.identifier, 1, length('anonymous-application-session:' || form.id || ':')) =
          'anonymous-application-session:' || form.id || ':'
)
OR EXISTS (
  SELECT 1 FROM participant_retention_locked_identities identity_link
  JOIN people person ON person.id = identity_link.person_id
  WHERE identity_link.identity_kind = 'retired'
    AND person.email = NEW.identifier COLLATE NOCASE
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;


-- Audit history is append-only at the database boundary.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

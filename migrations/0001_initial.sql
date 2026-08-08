PRAGMA foreign_keys = ON;

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
  biography TEXT,
  organisation_name TEXT,
  job_title TEXT,
  profile_status TEXT NOT NULL DEFAULT 'draft' CHECK (profile_status IN ('draft','published','archived')),
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
  repository_provider TEXT NOT NULL DEFAULT 'd1' CHECK (repository_provider IN ('d1','airtable')),
  programme_published_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organisation_id, slug)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','administrator','evaluator','participant')),
  invited_at INTEGER,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (event_id, person_id, role)
);

CREATE TABLE form_definitions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('submission','direct_session')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  public_slug TEXT NOT NULL,
  closes_at INTEGER,
  submission_limit INTEGER,
  min_speakers INTEGER NOT NULL DEFAULT 1 CHECK (min_speakers >= 1),
  max_speakers INTEGER CHECK (max_speakers IS NULL OR max_speakers >= min_speakers),
  access_mode TEXT NOT NULL DEFAULT 'email_verified' CHECK (access_mode IN ('email_verified','account_required','password_protected')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, public_slug)
);

CREATE TABLE form_versions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  routing_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(routing_json)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(form_id, version_number)
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  form_version_id TEXT REFERENCES form_versions(id),
  submitter_person_id TEXT REFERENCES people(id),
  title TEXT NOT NULL,
  category TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','assigned','in_review','decision_ready','accepted','rejected','withdrawn')),
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  submitted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE submission_speakers (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  position INTEGER NOT NULL,
  invitation_status TEXT NOT NULL DEFAULT 'pending' CHECK (invitation_status IN ('pending','claimed','declined')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  PRIMARY KEY (submission_id, person_id)
);

CREATE TABLE evaluation_plans (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  round_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE evaluation_criteria (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  weight_percent INTEGER NOT NULL CHECK (weight_percent > 0 AND weight_percent <= 100),
  position INTEGER NOT NULL
);

CREATE TABLE evaluator_assignments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  evaluator_person_id TEXT NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','conflict_returned','reopened')),
  conflict_declared_at INTEGER,
  assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at INTEGER,
  UNIQUE(plan_id, submission_id, evaluator_person_id)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE REFERENCES evaluator_assignments(id) ON DELETE CASCADE,
  scores_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scores_json)),
  weighted_score REAL,
  recommendation TEXT CHECK (recommendation IN ('accept','minor_changes','conditional_accept','reject')),
  confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
  submitter_feedback TEXT,
  private_notes TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at INTEGER
);

CREATE TABLE submission_decisions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','waitlisted')),
  decided_by_person_id TEXT NOT NULL REFERENCES people(id),
  rationale TEXT,
  decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  colour_token TEXT,
  UNIQUE(event_id, slug)
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  building TEXT,
  level TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_submission_id TEXT REFERENCES submissions(id),
  track_id TEXT REFERENCES tracks(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  format TEXT NOT NULL CHECK (format IN ('keynote','presentation','panel','workshop','breakout','other')),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  expected_attendance INTEGER,
  status TEXT NOT NULL DEFAULT 'unscheduled' CHECK (status IN ('unscheduled','scheduled','published','cancelled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, slug)
);

CREATE TABLE session_speakers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  position INTEGER NOT NULL,
  role_label TEXT,
  PRIMARY KEY (session_id, person_id)
);

CREATE TABLE schedule_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(event_id, version_number)
);

CREATE TABLE schedule_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  schedule_version_id TEXT NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(schedule_version_id, session_id)
);

CREATE TABLE schedule_conflicts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  schedule_version_id TEXT NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('room','speaker','track','event_boundary','capacity')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','blocking')),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json))
);

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('speaker','session','event')),
  impact TEXT NOT NULL CHECK (impact IN ('critical','high','medium','low')),
  evidence_mode TEXT NOT NULL DEFAULT 'none' CHECK (evidence_mode IN ('none','checkbox','file','text','admin_approval')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE task_instances (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES task_templates(id),
  target_type TEXT CHECK (target_type IN ('speaker','session','event')),
  target_id TEXT,
  owner_person_id TEXT REFERENCES people(id),
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('critical','high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('not_started','in_progress','completed','waived')),
  readiness_state TEXT NOT NULL DEFAULT 'on_track' CHECK (readiness_state IN ('on_track','at_risk','overdue','blocked')),
  readiness_percent INTEGER NOT NULL DEFAULT 0 CHECK (readiness_percent BETWEEN 0 AND 100),
  idempotency_key TEXT,
  due_at INTEGER,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  waiver_json TEXT CHECK (waiver_json IS NULL OR json_valid(waiver_json)),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE communication_templates (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  channels_json TEXT NOT NULL CHECK (json_valid(channels_json)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE communications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES communication_templates(id),
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','queued','sending','sent','partially_failed','failed','cancelled')),
  audience_json TEXT NOT NULL CHECK (json_valid(audience_json)),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  scheduled_at INTEGER,
  sent_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE communication_deliveries (
  id TEXT PRIMARY KEY,
  communication_id TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','push','calendar')),
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','opened','clicked','bounced','suppressed','failed','cancelled')),
  failure_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE file_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_person_id TEXT REFERENCES people(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  version_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','replaced','rejected','deleted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected','needs_attention','failed','disconnected')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','bidirectional')),
  conflict_policy TEXT,
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE integration_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partially_failed','failed')),
  direction TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE operation_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','queue_failed','received','running','retrying','completed','partially_failed','failed','cancelled')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER
);

CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(provider, provider_account_id)
);

CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('magic_link','email_verification','password_reset','invitation')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);

CREATE INDEX idx_events_org ON events(organisation_id);
CREATE INDEX idx_submissions_event_status ON submissions(event_id, status);
CREATE INDEX idx_assignments_evaluator_status ON evaluator_assignments(evaluator_person_id, status);
CREATE INDEX idx_sessions_event_status ON sessions(event_id, status);
CREATE INDEX idx_schedule_entries_version_time ON schedule_entries(schedule_version_id, starts_at);
CREATE INDEX idx_schedule_conflicts_open ON schedule_conflicts(event_id, resolved_at, severity);
CREATE INDEX idx_tasks_event_status_due ON task_instances(event_id, status, due_at);
CREATE INDEX idx_deliveries_communication_status ON communication_deliveries(communication_id, status);
CREATE INDEX idx_audit_event_created ON audit_events(event_id, created_at DESC);


CREATE UNIQUE INDEX ux_memberships_org_role
  ON memberships(organisation_id, person_id, role)
  WHERE event_id IS NULL;
CREATE UNIQUE INDEX ux_memberships_event_role
  ON memberships(event_id, person_id, role)
  WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_form_versions_one_published
  ON form_versions(form_id)
  WHERE status = 'published';
CREATE UNIQUE INDEX ux_schedule_versions_one_published
  ON schedule_versions(event_id)
  WHERE status = 'published';
CREATE UNIQUE INDEX ux_evaluation_plan_round
  ON evaluation_plans(event_id, round_number);
CREATE UNIQUE INDEX ux_evaluation_criteria_position
  ON evaluation_criteria(plan_id, position);
CREATE INDEX idx_memberships_person_event ON memberships(person_id, event_id);
CREATE INDEX idx_submission_speakers_person ON submission_speakers(person_id);
CREATE INDEX idx_session_speakers_person ON session_speakers(person_id);
CREATE INDEX idx_schedule_entries_room_time ON schedule_entries(schedule_version_id, room_id, starts_at, ends_at);

CREATE UNIQUE INDEX idx_task_idempotency ON task_instances(event_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_form_public_status ON form_definitions(event_id, public_slug, status);
CREATE INDEX idx_submissions_submitter ON submissions(event_id, submitter_person_id, updated_at DESC);
CREATE INDEX idx_files_target ON file_assets(event_id, target_type, target_id, status);
CREATE INDEX idx_integration_runs_connection ON integration_runs(connection_id, created_at DESC);
CREATE INDEX idx_operation_jobs_event_status ON operation_jobs(event_id, status, created_at DESC);
CREATE INDEX idx_auth_sessions_person_expiry ON auth_sessions(person_id, expires_at);
CREATE INDEX idx_api_keys_event ON api_keys(event_id, revoked_at);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

-- Sponsor access is company-scoped and does not grant an event administrator,
-- submitter or speaker membership. Programme sessions still use the ordinary
-- organiser intake, participant consent and publication boundaries.
CREATE TABLE event_sponsorships (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  tier TEXT NOT NULL DEFAULT '' CHECK (length(tier) <= 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 3000),
  website_url TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  session_limit INTEGER NOT NULL CHECK (session_limit BETWEEN 0 AND 100),
  closes_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  invitation_template_version_id TEXT REFERENCES communication_template_versions(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (event_id, organisation_id) REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  UNIQUE(id, event_id),
  UNIQUE(event_id, name)
);

CREATE TABLE sponsor_contacts (
  id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  accepted_at INTEGER,
  revoked_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (sponsor_id, event_id) REFERENCES event_sponsorships(id, event_id) ON DELETE CASCADE,
  UNIQUE(sponsor_id, email)
);

CREATE INDEX idx_sponsor_contacts_email ON sponsor_contacts(email, revoked_at);

CREATE TABLE sponsored_session_proposals (
  id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object' AND length(details_json) <= 150000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','accepted','withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  session_id TEXT UNIQUE,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (sponsor_id, event_id) REFERENCES event_sponsorships(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id),
  CHECK ((status = 'accepted' AND session_id IS NOT NULL) OR (status <> 'accepted' AND session_id IS NULL))
);

CREATE INDEX idx_sponsored_sessions_company ON sponsored_session_proposals(sponsor_id, status);
CREATE INDEX idx_sponsorships_event ON event_sponsorships(event_id, status, name);

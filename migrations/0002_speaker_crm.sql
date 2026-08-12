CREATE TABLE organisation_contacts (
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('event','import','manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into_person_id TEXT REFERENCES people(id),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organisation_id, person_id),
  CHECK (
    (status = 'active' AND merged_into_person_id IS NULL)
    OR
    (status = 'merged' AND merged_into_person_id IS NOT NULL AND merged_into_person_id <> person_id)
  )
);

CREATE TABLE organisation_contact_tags (
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) BETWEEN 1 AND 40),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organisation_id, person_id, tag),
  FOREIGN KEY (organisation_id, person_id)
    REFERENCES organisation_contacts(organisation_id, person_id) ON DELETE CASCADE
);

CREATE TABLE organisation_contact_notes (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  author_person_id TEXT NOT NULL REFERENCES people(id),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (organisation_id, person_id)
    REFERENCES organisation_contacts(organisation_id, person_id) ON DELETE CASCADE
);

CREATE TABLE crm_segments (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organisation_id, owner_person_id, name)
);

CREATE TABLE crm_pipeline_entries (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('identified','contacted','interested','confirmed','declined')),
  score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  rationale TEXT CHECK (rationale IS NULL OR length(rationale) <= 2000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organisation_id, person_id),
  UNIQUE (id, organisation_id),
  FOREIGN KEY (organisation_id, person_id)
    REFERENCES organisation_contacts(organisation_id, person_id) ON DELETE CASCADE
);

CREATE TABLE crm_pipeline_activity (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  pipeline_entry_id TEXT NOT NULL,
  actor_person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','stage_changed')),
  body TEXT CHECK (body IS NULL OR length(trim(body)) BETWEEN 1 AND 5000),
  from_stage TEXT CHECK (from_stage IS NULL OR from_stage IN ('identified','contacted','interested','confirmed','declined')),
  to_stage TEXT CHECK (to_stage IS NULL OR to_stage IN ('identified','contacted','interested','confirmed','declined')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (pipeline_entry_id, organisation_id)
    REFERENCES crm_pipeline_entries(id, organisation_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'note' AND body IS NOT NULL AND from_stage IS NULL AND to_stage IS NULL)
    OR
    (kind = 'stage_changed' AND body IS NULL AND to_stage IS NOT NULL)
  )
);

CREATE INDEX idx_organisation_contacts_status ON organisation_contacts(organisation_id, status, updated_at DESC);
CREATE INDEX idx_organisation_contact_tags_tag ON organisation_contact_tags(organisation_id, tag, person_id);
CREATE INDEX idx_organisation_contact_notes_person ON organisation_contact_notes(organisation_id, person_id, created_at DESC);
CREATE INDEX idx_crm_segments_owner ON crm_segments(organisation_id, owner_person_id, updated_at DESC);
CREATE INDEX idx_crm_pipeline_stage ON crm_pipeline_entries(organisation_id, stage, updated_at DESC);
CREATE INDEX idx_crm_pipeline_activity_entry ON crm_pipeline_activity(organisation_id, pipeline_entry_id, created_at DESC);

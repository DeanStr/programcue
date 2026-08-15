CREATE TABLE programme_embeds (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  configuration_json TEXT NOT NULL,
  installation_note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_person_id TEXT NOT NULL,
  updated_by_person_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER,
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_person_id) REFERENCES people(id),
  FOREIGN KEY (updated_by_person_id) REFERENCES people(id),
  CONSTRAINT programme_embeds_status_check
    CHECK (status IN ('draft','active','paused','revoked')),
  CONSTRAINT programme_embeds_name_length_check
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT programme_embeds_slug_check
    CHECK (length(slug) BETWEEN 1 AND 80
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND slug NOT LIKE '-%'
      AND slug NOT LIKE '%-'
      AND slug NOT LIKE '%--%'),
  CONSTRAINT programme_embeds_configuration_check
    CHECK (json_valid(configuration_json)),
  CONSTRAINT programme_embeds_installation_note_length_check
    CHECK (installation_note IS NULL OR length(installation_note) BETWEEN 1 AND 500),
  CONSTRAINT programme_embeds_revision_check CHECK (revision >= 1),
  CONSTRAINT programme_embeds_revoked_at_check
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX programme_embeds_event_slug_unique
  ON programme_embeds(event_id, slug);

CREATE INDEX idx_programme_embeds_event_status
  ON programme_embeds(event_id, status, updated_at);

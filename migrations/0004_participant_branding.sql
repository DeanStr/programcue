ALTER TABLE events ADD COLUMN participant_logo_url TEXT
  CHECK (
    participant_logo_url IS NULL
    OR (
      length(participant_logo_url) <= 2048
      AND substr(participant_logo_url, 1, 8) = 'https://'
    )
  );

ALTER TABLE events ADD COLUMN participant_welcome_text TEXT
  CHECK (
    participant_welcome_text IS NULL
    OR length(participant_welcome_text) <= 500
  );

ALTER TABLE events ADD COLUMN participant_support_url TEXT
  CHECK (
    participant_support_url IS NULL
    OR (
      length(participant_support_url) <= 2048
      AND substr(participant_support_url, 1, 8) = 'https://'
    )
  );

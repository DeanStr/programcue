-- The public programme masthead had a hero-image slot with no field behind it,
-- so every published programme rendered the same flat gradient. The rail also
-- had no way to answer the most common attendee question after "what is on" —
-- where the venue is and how to get there.
--
-- Same shape as the participant branding columns in 0004: https-only, bounded
-- length, null when unset.
ALTER TABLE events ADD COLUMN programme_hero_image_url TEXT
  CHECK (
    programme_hero_image_url IS NULL
    OR (
      length(programme_hero_image_url) <= 2048
      AND substr(programme_hero_image_url, 1, 8) = 'https://'
    )
  );

ALTER TABLE events ADD COLUMN venue_address TEXT
  CHECK (venue_address IS NULL OR length(venue_address) <= 300);

ALTER TABLE events ADD COLUMN venue_map_url TEXT
  CHECK (
    venue_map_url IS NULL
    OR (
      length(venue_map_url) <= 2048
      AND substr(venue_map_url, 1, 8) = 'https://'
    )
  );

CREATE INDEX idx_submission_track_selections_event_name
  ON submission_track_selections(
    event_id,
    track_name_snapshot,
    submission_id
  );

CREATE INDEX idx_deliveries_communication_created
  ON communication_deliveries(communication_id, created_at, id);

CREATE INDEX idx_deliveries_event_created_status
  ON communication_deliveries(event_id, created_at, status);

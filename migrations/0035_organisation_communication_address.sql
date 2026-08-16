ALTER TABLE organisations ADD COLUMN communication_physical_address TEXT
  CHECK (
    communication_physical_address IS NULL
    OR (
      length(trim(communication_physical_address)) >= 5
      AND length(communication_physical_address) <= 500
    )
  );

ALTER TABLE organisations
  ADD COLUMN communication_physical_address_revision INTEGER NOT NULL DEFAULT 1
  CHECK (communication_physical_address_revision > 0);

ALTER TABLE organisations
  ADD COLUMN communication_physical_address_last_operation_id TEXT;

CREATE UNIQUE INDEX ux_organisations_communication_address_operation
  ON organisations(communication_physical_address_last_operation_id)
  WHERE communication_physical_address_last_operation_id IS NOT NULL;

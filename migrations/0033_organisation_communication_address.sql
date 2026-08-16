ALTER TABLE organisations ADD COLUMN communication_physical_address TEXT
  CHECK (
    communication_physical_address IS NULL
    OR (
      length(trim(communication_physical_address)) >= 5
      AND length(communication_physical_address) <= 500
    )
  );

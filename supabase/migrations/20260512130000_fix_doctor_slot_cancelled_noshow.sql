-- The doctor active-slot index from the previous migration only excluded
-- deleted_at IS NULL. Cancelled and no_show appointments are not soft-deleted
-- (deleted_at remains NULL), so they still participated in the index and
-- would cause a unique-violation when rebooking the exact same doctor+time.
--
-- Rebuild the index to mirror the application-layer conflict query, which
-- already excludes cancelled, no_show, and soft-deleted rows.

DROP INDEX IF EXISTS "appointments_doctor_active_slot_key";
CREATE UNIQUE INDEX "appointments_doctor_active_slot_key"
  ON appointments (doctor_id, scheduled_at)
  WHERE status <> ALL (ARRAY['cancelled'::appointment_status, 'no_show'::appointment_status])
    AND deleted_at IS NULL;

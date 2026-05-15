-- Soft-deleted appointments were still blocking doctor and patient slots because
-- the two unique constraints below had no predicate on deleted_at.

-- 1. Replace the plain doctor+time unique constraint with a partial index
--    that only enforces uniqueness among non-deleted rows.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS "appointments_doctor_id_scheduled_at_key";
CREATE UNIQUE INDEX "appointments_doctor_active_slot_key"
  ON appointments (doctor_id, scheduled_at)
  WHERE deleted_at IS NULL;
-- 2. Rebuild the patient active-slot partial index to also exclude soft-deleted rows.
DROP INDEX IF EXISTS "appointments_patient_active_slot_key";
CREATE UNIQUE INDEX "appointments_patient_active_slot_key"
  ON appointments (patient_id, scheduled_at)
  WHERE status <> ALL (ARRAY['cancelled'::appointment_status, 'no_show'::appointment_status])
    AND deleted_at IS NULL;

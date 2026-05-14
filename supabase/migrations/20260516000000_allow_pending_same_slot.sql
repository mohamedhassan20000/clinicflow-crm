-- Pending appointments should not block new bookings.
-- Only a confirmed appointment exclusively claims a doctor+time slot.
-- Rebuild the unique index so it only fires for confirmed rows.

DROP INDEX IF EXISTS "appointments_doctor_active_slot_key";

CREATE UNIQUE INDEX "appointments_doctor_active_slot_key"
  ON appointments (doctor_id, scheduled_at)
  WHERE status = 'confirmed'::appointment_status
    AND deleted_at IS NULL;

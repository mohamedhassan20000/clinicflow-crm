-- Add displaced_at and displaced_by columns to appointments.
-- These are set when a pending appointment is removed because a conflicting
-- appointment was confirmed. The appointment is also soft-deleted (deleted_at),
-- but displaced_at distinguishes it from a regular trash deletion so it can
-- be surfaced in the "Displaced appointments" rebook queue instead of the
-- recycle bin.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS displaced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS displaced_by  uuid REFERENCES public.profiles(id);

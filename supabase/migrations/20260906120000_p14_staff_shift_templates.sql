-- ─────────────────────────────────────────────────────────────────────────────
-- P14 · Separate CLINIC WORKING HOURS from STAFF SHIFT TEMPLATES
--
-- clinic_working_hours keeps answering "when is the clinic open?" and its
-- non-overlap rule is untouched. Staff morning/evening shifts move to their own
-- reusable, deliberately overlappable templates.
--
-- Additive only: no existing row is modified or deleted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_shift_templates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  start_time  time        NOT NULL,
  end_time    time        NOT NULL,
  is_enabled  boolean     NOT NULL DEFAULT true,
  sort_order  smallint    NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sst_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT sst_times_ordered  CHECK (end_time > start_time)
);

-- Templates MAY overlap each other on purpose (Morning 09:00–17:00 and
-- Evening 15:00–22:00). Only the display name is unique per clinic.
CREATE UNIQUE INDEX IF NOT EXISTS staff_shift_templates_clinic_name_key
  ON public.staff_shift_templates (clinic_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS staff_shift_templates_clinic_order_idx
  ON public.staff_shift_templates (clinic_id, sort_order, created_at);

ALTER TABLE public.staff_shift_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sst_select" ON public.staff_shift_templates;
CREATE POLICY "sst_select"
  ON public.staff_shift_templates
  FOR SELECT TO authenticated
  USING (clinic_id = public.auth_clinic_id());

DROP POLICY IF EXISTS "sst_write_admin" ON public.staff_shift_templates;
CREATE POLICY "sst_write_admin"
  ON public.staff_shift_templates
  TO authenticated
  USING  (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role")
  WITH CHECK (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role");


-- ─────────────────────────────────────────────────────────────────────────────
-- doctor_schedules: allow more than one interval per staff weekday.
--
-- A staff member picking Morning 09:00–13:00 and Evening 16:00–22:00 must keep
-- the 13:00–16:00 gap closed, which a single row per day cannot express.
-- Application code merges overlapping picks before writing, so the stored rows
-- for a day stay disjoint. Every existing row already satisfies the new key.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.doctor_schedules
  DROP CONSTRAINT IF EXISTS ds_unique;

ALTER TABLE public.doctor_schedules
  DROP CONSTRAINT IF EXISTS ds_unique_interval;

ALTER TABLE public.doctor_schedules
  ADD CONSTRAINT ds_unique_interval UNIQUE (doctor_id, day_of_week, start_time);

CREATE INDEX IF NOT EXISTS doctor_schedules_doctor_day_idx
  ON public.doctor_schedules (doctor_id, day_of_week, start_time);

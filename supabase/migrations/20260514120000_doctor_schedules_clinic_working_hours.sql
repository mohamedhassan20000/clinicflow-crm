-- ─────────────────────────────────────────────────────────────────────────────
-- clinic_working_hours  — up to 2 shifts per day per clinic
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.clinic_working_hours (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  day_of_week  smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sun … 6 = Sat
  shift_start  time        NOT NULL,
  shift_end    time        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cwh_times_ordered CHECK (shift_end > shift_start),
  CONSTRAINT cwh_unique UNIQUE (clinic_id, day_of_week, shift_start)
);

ALTER TABLE public.clinic_working_hours ENABLE ROW LEVEL SECURITY;

-- Trigger: hard-cap at 2 shifts per (clinic, day)
CREATE OR REPLACE FUNCTION public.check_max_clinic_shifts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.clinic_working_hours
    WHERE clinic_id = NEW.clinic_id AND day_of_week = NEW.day_of_week
  ) >= 2 THEN
    RAISE EXCEPTION 'Maximum 2 shifts per day allowed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_max_clinic_shifts ON public.clinic_working_hours;
CREATE TRIGGER enforce_max_clinic_shifts
  BEFORE INSERT ON public.clinic_working_hours
  FOR EACH ROW EXECUTE FUNCTION public.check_max_clinic_shifts();

-- RLS: any authenticated clinic member may read; admin-only write
DROP POLICY IF EXISTS "cwh_select" ON public.clinic_working_hours;
CREATE POLICY "cwh_select"
  ON public.clinic_working_hours
  FOR SELECT TO authenticated
  USING (clinic_id = public.auth_clinic_id());

DROP POLICY IF EXISTS "cwh_write_admin" ON public.clinic_working_hours;
CREATE POLICY "cwh_write_admin"
  ON public.clinic_working_hours
  TO authenticated
  USING  (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role")
  WITH CHECK (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role");


-- ─────────────────────────────────────────────────────────────────────────────
-- doctor_schedules  — one shift per weekday per doctor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.doctor_schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  day_of_week  smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   time        NOT NULL,
  end_time     time        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ds_times_ordered CHECK (end_time > start_time),
  CONSTRAINT ds_unique UNIQUE (doctor_id, day_of_week)
);

ALTER TABLE public.doctor_schedules ENABLE ROW LEVEL SECURITY;

-- RLS: any authenticated clinic member may read; admin-only write
DROP POLICY IF EXISTS "ds_select" ON public.doctor_schedules;
CREATE POLICY "ds_select"
  ON public.doctor_schedules
  FOR SELECT TO authenticated
  USING (clinic_id = public.auth_clinic_id());

DROP POLICY IF EXISTS "ds_write_admin" ON public.doctor_schedules;
CREATE POLICY "ds_write_admin"
  ON public.doctor_schedules
  TO authenticated
  USING  (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role")
  WITH CHECK (clinic_id = public.auth_clinic_id() AND public.auth_role() = 'admin'::"public"."user_role");

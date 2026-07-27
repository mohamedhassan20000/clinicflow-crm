-- Phase 3: assistant data scope = UNION of assigned doctors' own scopes only.
--
-- Adds an `assistant` branch to the role-scoped SELECT policies on patients,
-- appointments and follow_ups. The scope is strictly the rows owned by the
-- assistant's assigned doctors (via auth_supervised_doctor_ids()); it is never
-- department-wide and never clinic-wide. Assistants remain read-only. These
-- branches are additive — the admin/receptionist/manager/doctor branches are
-- reproduced verbatim so their authorization is unchanged.

-- ── patients ────────────────────────────────────────────────────────────────
drop policy if exists "patients_select_role_scoped" on public.patients;
create policy "patients_select_role_scoped"
on public.patients
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and not is_deleted
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ]
    )
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        assigned_doctor_id = auth.uid()
        or (
          public.auth_department_id() is not null
          and department_id = public.auth_department_id()
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and assigned_doctor_id = any (public.auth_supervised_doctor_ids())
    )
  )
);

-- ── appointments ────────────────────────────────────────────────────────────
drop policy if exists "appointments_select_role_scoped" on public.appointments;
create policy "appointments_select_role_scoped"
on public.appointments
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ]
    )
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        doctor_id = auth.uid()
        or exists (
          select 1
          from public.patients p
          where p.id = appointments.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and (
              p.assigned_doctor_id = auth.uid()
              or (
                public.auth_department_id() is not null
                and p.department_id = public.auth_department_id()
              )
            )
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and (
        doctor_id = any (public.auth_supervised_doctor_ids())
        or exists (
          select 1
          from public.patients p
          where p.id = appointments.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
        )
      )
    )
  )
);

-- ── follow_ups ──────────────────────────────────────────────────────────────
drop policy if exists "follow_ups_select_role_scoped" on public.follow_ups;
create policy "follow_ups_select_role_scoped"
on public.follow_ups
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ]
    )
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        exists (
          select 1
          from public.appointments a
          where a.id = follow_ups.appointment_id
            and a.clinic_id = public.auth_clinic_id()
            and a.doctor_id = auth.uid()
        )
        or exists (
          select 1
          from public.patients p
          where p.id = follow_ups.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and (
              p.assigned_doctor_id = auth.uid()
              or (
                public.auth_department_id() is not null
                and p.department_id = public.auth_department_id()
              )
            )
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and (
        exists (
          select 1
          from public.appointments a
          where a.id = follow_ups.appointment_id
            and a.clinic_id = public.auth_clinic_id()
            and a.doctor_id = any (public.auth_supervised_doctor_ids())
        )
        or exists (
          select 1
          from public.patients p
          where p.id = follow_ups.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
        )
      )
    )
  )
);

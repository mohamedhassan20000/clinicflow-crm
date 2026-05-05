-- Phase 5B: doctor-scoped patient and appointment read policies.
-- This migration is intentionally not applied automatically.

create or replace function public.auth_department_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select department_id
  from profiles
  where id = auth.uid()
    and is_active = true
    and is_deleted = false
    and deleted_at is null
  limit 1;
$$;

revoke all on function public.auth_department_id() from public;
grant execute on function public.auth_department_id() to authenticated;
grant execute on function public.auth_department_id() to service_role;

drop policy if exists "patients_select_clinic" on public.patients;

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
  )
);

drop policy if exists "appointments_select_clinic" on public.appointments;

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
  )
);

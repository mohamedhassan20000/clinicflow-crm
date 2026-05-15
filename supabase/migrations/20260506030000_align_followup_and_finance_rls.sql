-- Phase 5E: align follow-up and finance visibility with app roles.
-- This migration is intentionally not applied automatically.

drop policy if exists "follow_ups_select" on public.follow_ups;
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
  )
);
drop policy if exists "follow_ups_staff_write" on public.follow_ups;
create policy "follow_ups_staff_write"
on public.follow_ups
for insert
to authenticated
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);
drop policy if exists "follow_ups_staff_update" on public.follow_ups;
create policy "follow_ups_staff_update"
on public.follow_ups
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);
drop policy if exists "follow_ups_staff_delete" on public.follow_ups;
create policy "follow_ups_staff_delete"
on public.follow_ups
for delete
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);
drop policy if exists "patient_deposits_select" on public.patient_deposits;
drop policy if exists "patient_deposits_select_staff" on public.patient_deposits;
create policy "patient_deposits_select_staff"
on public.patient_deposits
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ]
  )
);
drop policy if exists "settlements_select" on public.outstanding_settlements;
drop policy if exists "settlements_select_staff" on public.outstanding_settlements;
create policy "settlements_select_staff"
on public.outstanding_settlements
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ]
  )
);
drop policy if exists "settlements_staff_write" on public.outstanding_settlements;
create policy "settlements_staff_write"
on public.outstanding_settlements
for insert
to authenticated
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

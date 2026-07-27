-- Phase 4 (correction): Assistants are operational actors for their assigned
-- doctors, not read-only. They may INSERT/UPDATE appointments and follow-ups
-- whose doctor is in the union of their ACTIVE assigned doctors
-- (auth_supervised_doctor_ids()). This is the authoritative enforcement layer.
--
-- Anti-spoofing: the WITH CHECK clauses require the row's doctor to be in the
-- assistant's supervised set, so a forged/stale doctor_id in an INSERT — or a
-- reassignment to an unassigned doctor in an UPDATE — is rejected by RLS
-- regardless of what a server action or direct DB call submits.
--
-- Assistants get NO delete (appointments delete stays admin-only; follow-up
-- delete stays admin/receptionist/manager), NO clinic-wide access, NO financial
-- RPCs (those keep their own admin/receptionist/manager guards).

-- ── appointments: assistants may insert for an assigned doctor ────────────────
drop policy if exists "appointments_write_staff" on public.appointments;
create policy "appointments_write_staff" on public.appointments
  for insert to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and doctor_id = any (public.auth_supervised_doctor_ids())
      )
    )
  );

-- ── appointments: assistants may update an assigned doctor's appointment ──────
-- Both the existing row (USING) and the resulting row (WITH CHECK) must belong
-- to a supervised doctor, so an assistant cannot move an appointment onto a
-- doctor outside their scope.
drop policy if exists "appointments_update_staff" on public.appointments;
create policy "appointments_update_staff" on public.appointments
  for update to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and doctor_id = any (public.auth_supervised_doctor_ids())
      )
    )
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and doctor_id = any (public.auth_supervised_doctor_ids())
      )
    )
  );

-- ── follow_ups: assistants may insert for an assigned doctor's record ─────────
-- Scope mirrors the SELECT policy: the follow-up's appointment belongs to a
-- supervised doctor, or its patient is assigned to a supervised doctor.
drop policy if exists "follow_ups_staff_write" on public.follow_ups;
create policy "follow_ups_staff_write" on public.follow_ups
  for insert to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and (
          exists (
            select 1 from public.appointments a
            where a.id = follow_ups.appointment_id
              and a.clinic_id = public.auth_clinic_id()
              and a.doctor_id = any (public.auth_supervised_doctor_ids())
          )
          or exists (
            select 1 from public.patients p
            where p.id = follow_ups.patient_id
              and p.clinic_id = public.auth_clinic_id()
              and not p.is_deleted
              and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
          )
        )
      )
    )
  );

-- ── follow_ups: assistants may update an assigned doctor's follow-up ──────────
drop policy if exists "follow_ups_staff_update" on public.follow_ups;
create policy "follow_ups_staff_update" on public.follow_ups
  for update to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and (
          exists (
            select 1 from public.appointments a
            where a.id = follow_ups.appointment_id
              and a.clinic_id = public.auth_clinic_id()
              and a.doctor_id = any (public.auth_supervised_doctor_ids())
          )
          or exists (
            select 1 from public.patients p
            where p.id = follow_ups.patient_id
              and p.clinic_id = public.auth_clinic_id()
              and not p.is_deleted
              and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
          )
        )
      )
    )
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() = any (array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ])
      or (
        public.auth_role() = 'assistant'::public.user_role
        and (
          exists (
            select 1 from public.appointments a
            where a.id = follow_ups.appointment_id
              and a.clinic_id = public.auth_clinic_id()
              and a.doctor_id = any (public.auth_supervised_doctor_ids())
          )
          or exists (
            select 1 from public.patients p
            where p.id = follow_ups.patient_id
              and p.clinic_id = public.auth_clinic_id()
              and not p.is_deleted
              and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
          )
        )
      )
    )
  );

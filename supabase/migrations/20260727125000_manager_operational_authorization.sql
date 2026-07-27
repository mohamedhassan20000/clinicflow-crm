-- Phase 4: Manager operational authorization for Appointments & Follow-ups.
--
-- Managers gain the same operational authorization as admins/receptionists on
-- Appointments and Follow-ups (create/edit/status/record), within clinic
-- isolation. Delete stays admin-only (receptionists cannot delete either).
-- Assistants remain read-only within their assigned-doctor scope (Phase 3).

-- ── appointments: managers may insert & update (not delete) ──────────────────
drop policy if exists "appointments_write_staff" on public.appointments;
create policy "appointments_write_staff" on public.appointments
  for insert to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  );

drop policy if exists "appointments_update_staff" on public.appointments;
create policy "appointments_update_staff" on public.appointments
  for update to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  )
  with check (clinic_id = public.auth_clinic_id());

-- ── follow_ups: managers may insert/update/delete ────────────────────────────
drop policy if exists "follow_ups_staff_write" on public.follow_ups;
create policy "follow_ups_staff_write" on public.follow_ups
  for insert to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  );

drop policy if exists "follow_ups_staff_update" on public.follow_ups;
create policy "follow_ups_staff_update" on public.follow_ups
  for update to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  );

drop policy if exists "follow_ups_staff_delete" on public.follow_ups;
create policy "follow_ups_staff_delete" on public.follow_ups
  for delete to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (array[
      'admin'::public.user_role,
      'receptionist'::public.user_role,
      'manager'::public.user_role
    ])
  );

-- ── get_followups_dashboard: remove the blanket manager deny ─────────────────
-- Follow-ups SELECT RLS already admits managers clinic-wide; the RPC's explicit
-- manager deny was the only thing making the Manager Follow-ups page unusable.

create or replace function public.get_followups_dashboard(
  p_start timestamptz,
  p_end timestamptz,
  p_department_id uuid default null,
  p_doctor_id uuid default null,
  p_patient_ids uuid[] default null,
  p_outcome public.follow_up_outcome default null,
  p_pending_limit integer default 250,
  p_done_limit integer default 50,
  p_done_offset integer default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_payload jsonb;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  with pending_scope as (
    select
      a.id,
      a.scheduled_at,
      a.paid_at,
      a.patient_id,
      a.department_id,
      a.doctor_id,
      a.total_amount,
      a.payment_note,
      p.full_name as patient_name,
      p.phone as patient_phone,
      p.file_number,
      p.national_id,
      p.department_id as patient_department_id,
      doc.full_name as doctor_name,
      d.name as department_name,
      d.color as department_color
    from public.appointments a
    left join public.patients p on p.id = a.patient_id
    left join public.profiles doc on doc.id = a.doctor_id
    left join public.departments d on d.id = a.department_id
    where a.clinic_id = v_clinic_id
      and a.status = 'completed'::public.appointment_status
      and a.deleted_at is null
      and a.scheduled_at >= p_start
      and a.scheduled_at <= p_end
      and (p_department_id is null or a.department_id = p_department_id)
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
      and (p_patient_ids is null or a.patient_id = any(p_patient_ids))
      and not exists (
        select 1
        from public.follow_ups f
        where f.appointment_id = a.id
          and f.clinic_id = v_clinic_id
      )
  ),
  done_scope as (
    select
      f.id,
      f.recorded_at,
      f.outcome,
      f.notes,
      f.patient_id,
      f.appointment_id,
      p.full_name as patient_name,
      p.phone as patient_phone,
      p.file_number,
      p.national_id,
      p.department_id as patient_department_id,
      rb.full_name as recorded_by_name,
      a.scheduled_at as appointment_scheduled_at,
      a.department_id as appointment_department_id,
      a.doctor_id as appointment_doctor_id,
      doc.full_name as appointment_doctor_name,
      d.name as appointment_department_name,
      d.color as appointment_department_color
    from public.follow_ups f
    left join public.patients p on p.id = f.patient_id
    left join public.profiles rb on rb.id = f.recorded_by
    left join public.appointments a on a.id = f.appointment_id
    left join public.profiles doc on doc.id = a.doctor_id
    left join public.departments d on d.id = a.department_id
    where f.clinic_id = v_clinic_id
      and a.scheduled_at >= p_start
      and a.scheduled_at <= p_end
      and (p_patient_ids is null or f.patient_id = any(p_patient_ids))
      and (p_outcome is null or f.outcome = p_outcome)
      and (p_department_id is null or a.department_id = p_department_id)
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
  ),
  pending_rows as (
    select *
    from pending_scope
    order by scheduled_at desc
    limit greatest(0, p_pending_limit)
  ),
  done_rows as (
    select *
    from done_scope
    order by
      case outcome
        when 'has_problem'::public.follow_up_outcome then 0
        when 'all_fine'::public.follow_up_outcome then 1
        when 'no_response'::public.follow_up_outcome then 2
        else 99
      end,
      recorded_at desc
    limit greatest(0, p_done_limit)
    offset greatest(0, p_done_offset)
  )
  select jsonb_build_object(
    'summary',
      jsonb_build_object(
        'pendingCount', (select count(*) from pending_scope),
        'completedCount', (select count(*) from done_scope),
        'allFineCount', (
          select count(*) from done_scope
          where outcome = 'all_fine'::public.follow_up_outcome
        ),
        'hasProblemCount', (
          select count(*) from done_scope
          where outcome = 'has_problem'::public.follow_up_outcome
        ),
        'noResponseCount', (
          select count(*) from done_scope
          where outcome = 'no_response'::public.follow_up_outcome
        )
      ),
    'pending',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', pr.id,
              'scheduled_at', pr.scheduled_at,
              'paid_at', pr.paid_at,
              'patient_id', pr.patient_id,
              'department_id', pr.department_id,
              'doctor_id', pr.doctor_id,
              'total_amount', pr.total_amount,
              'payment_note', pr.payment_note,
              'patients', jsonb_build_object(
                'id', pr.patient_id,
                'full_name', pr.patient_name,
                'phone', pr.patient_phone,
                'file_number', pr.file_number,
                'national_id', pr.national_id,
                'department_id', pr.patient_department_id
              ),
              'profiles', jsonb_build_object('full_name', pr.doctor_name),
              'departments',
                case
                  when pr.department_id is null then null
                  else jsonb_build_object(
                    'id', pr.department_id,
                    'name', pr.department_name,
                    'color', pr.department_color
                  )
                end
            )
            order by pr.scheduled_at desc
          )
          from pending_rows pr
        ),
        '[]'::jsonb
      ),
    'done',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', dr.id,
              'recorded_at', dr.recorded_at,
              'outcome', dr.outcome,
              'notes', dr.notes,
              'patient_id', dr.patient_id,
              'appointment_id', dr.appointment_id,
              'patients', jsonb_build_object(
                'id', dr.patient_id,
                'full_name', dr.patient_name,
                'phone', dr.patient_phone,
                'file_number', dr.file_number,
                'national_id', dr.national_id,
                'department_id', dr.patient_department_id
              ),
              'recorded_by', jsonb_build_object('full_name', dr.recorded_by_name),
              'appointment',
                case
                  when dr.appointment_id is null then null
                  else jsonb_build_object(
                    'id', dr.appointment_id,
                    'scheduled_at', dr.appointment_scheduled_at,
                    'department_id', dr.appointment_department_id,
                    'doctor_id', dr.appointment_doctor_id,
                    'profiles', jsonb_build_object('full_name', dr.appointment_doctor_name),
                    'departments',
                      case
                        when dr.appointment_department_id is null then null
                        else jsonb_build_object(
                          'id', dr.appointment_department_id,
                          'name', dr.appointment_department_name,
                          'color', dr.appointment_department_color
                        )
                      end
                  )
                end
            )
            order by
              case dr.outcome
                when 'has_problem'::public.follow_up_outcome then 0
                when 'all_fine'::public.follow_up_outcome then 1
                when 'no_response'::public.follow_up_outcome then 2
                else 99
              end,
              dr.recorded_at desc
          )
          from done_rows dr
        ),
        '[]'::jsonb
      )
  )
  into v_payload;

  return v_payload;
end;
$$;

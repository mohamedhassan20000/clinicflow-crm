create or replace function public.start_appointment_session(
  p_appointment_id uuid
)
returns table (
  patient_id uuid,
  status public.appointment_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id  uuid             := auth.uid();
  v_clinic_id uuid             := public.auth_clinic_id();
  v_role      public.user_role := public.auth_role();
  v_appt      public.appointments%rowtype;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> 'doctor'::public.user_role then
    raise exception 'Only doctors can start sessions' using errcode = '42501';
  end if;

  select * into v_appt
  from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_appt.doctor_id <> v_actor_id then
    raise exception 'Only the assigned doctor can start this session'
      using errcode = '42501';
  end if;

  if v_appt.status <> 'arrived'::public.appointment_status then
    raise exception 'This appointment is no longer arrived'
      using errcode = '23514';
  end if;

  return query
    update public.appointments as a
    set
      status = 'in_session'::public.appointment_status,
      updated_by = v_actor_id
    where a.id = p_appointment_id
      and a.clinic_id = v_clinic_id
      and a.doctor_id = v_actor_id
      and a.status = 'arrived'::public.appointment_status
    returning a.patient_id, a.status;

  if not found then
    raise exception 'Could not verify the updated session status'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.start_appointment_session(uuid) from public;
grant execute on function public.start_appointment_session(uuid)
  to authenticated, service_role;

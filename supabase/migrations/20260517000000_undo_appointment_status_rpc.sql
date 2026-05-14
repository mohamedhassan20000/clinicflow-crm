-- Atomically rolls a cancelled or no_show appointment back to pending/confirmed.
-- Clears all status-event fields; preserves identity, scheduling, and billing
-- fields untouched (billing would already be null for a non-completed row).
-- Using DELETE+INSERT so the UPDATE trigger cannot reject the status rollback.

create or replace function public.undo_appointment_status(
  p_appointment_id uuid,
  p_target_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id  uuid               := auth.uid();
  v_clinic_id uuid               := public.auth_clinic_id();
  v_role      public.user_role   := public.auth_role();
  v_appt      public.appointments%rowtype;
  v_rep       public.appointments%rowtype;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Not authorized to undo appointment status'
      using errcode = '42501';
  end if;

  if p_target_status <> all (array['pending', 'confirmed']) then
    raise exception 'Target status must be pending or confirmed'
      using errcode = '23514';
  end if;

  select * into v_appt
  from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_appt.status = 'completed'::public.appointment_status then
    raise exception 'Use undo_appointment_billing to undo a completed appointment'
      using errcode = '23514';
  end if;

  v_rep                       := v_appt;
  v_rep.status                := p_target_status::public.appointment_status;
  v_rep.updated_by            := v_actor_id;
  v_rep.updated_at            := now();
  v_rep.cancellation_reason   := null;
  v_rep.cancelled_at          := null;
  v_rep.cancelled_by          := null;
  v_rep.no_show_reason        := null;
  v_rep.no_showed_at          := null;
  v_rep.no_showed_by          := null;
  v_rep.payment_method        := null;
  v_rep.secondary_payment_method := null;
  v_rep.payment_note          := null;
  v_rep.paid_at               := null;
  v_rep.total_amount          := null;
  v_rep.paid_amount           := null;
  v_rep.insurance_amount      := null;
  v_rep.secondary_amount      := 0;
  v_rep.deposit_amount        := 0;
  v_rep.outstanding_amount    := null;

  delete from public.appointment_services
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.follow_ups
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.outstanding_settlements
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments select (v_rep).*;
end;
$$;

revoke all on function public.undo_appointment_status(uuid, text) from public;
grant execute on function public.undo_appointment_status(uuid, text)
  to authenticated, service_role;

-- P11H — every committed patient-assistant booking becomes operationally
-- visible to staff in the same transaction as the authoritative entity write.
--
-- Existing-patient bookings insert `appointments`; staged self/third-party
-- intakes insert `ai_appointment_requests`. They are intentionally different
-- entities, but both are pending booking work and both must wake the staff
-- review queue. The trigger is notification-only: the authoritative booking
-- RPCs continue to own identity, entitlement, caps, availability and audit.

create or replace function public.notify_staff_of_ai_booking_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link text;
  v_source text;
begin
  if tg_table_name = 'appointments' then
    v_link := '/appointments?status=pending&ai=1&appointment=' || new.id::text;
    v_source := 'appointment';
  elsif tg_table_name = 'ai_appointment_requests' then
    v_link := '/patients?ai_intake_review=1#ai-intakes';
    v_source := 'ai_appointment_request';
  else
    return new;
  end if;

  insert into public.notifications (
    clinic_id,
    recipient_id,
    type,
    link,
    data,
    dedupe_key
  )
  select
    new.clinic_id,
    p.id,
    'ai_booking_request',
    v_link,
    jsonb_build_object(
      'source', v_source,
      'recordId', new.id::text
    ),
    'ai_booking_request|' || v_source || '|' || new.id::text
  from public.profiles p
  where p.clinic_id = new.clinic_id
    and p.role in ('admin'::public.user_role, 'receptionist'::public.user_role)
    and p.is_active
    and not p.is_deleted
    and p.deleted_at is null
  on conflict (recipient_id, dedupe_key) where read_at is null do nothing;

  return new;
end;
$$;

revoke all on function public.notify_staff_of_ai_booking_commit() from public, anon, authenticated;

drop trigger if exists trg_notify_staff_ai_patient_booking on public.appointments;
create trigger trg_notify_staff_ai_patient_booking
after insert on public.appointments
for each row
when (
  new.status = 'pending'::public.appointment_status
  and new.ai_patient_conversation_id is not null
)
execute function public.notify_staff_of_ai_booking_commit();

drop trigger if exists trg_notify_staff_ai_provisional_booking on public.ai_appointment_requests;
create trigger trg_notify_staff_ai_provisional_booking
after insert on public.ai_appointment_requests
for each row
when (new.status = 'pending')
execute function public.notify_staff_of_ai_booking_commit();

comment on function public.notify_staff_of_ai_booking_commit() is
  'P11H transactionally notifies active clinic admins/receptionists after an authoritative patient-assistant pending booking entity is inserted.';

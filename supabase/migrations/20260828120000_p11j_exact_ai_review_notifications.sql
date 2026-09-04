-- P11J — exact deep links for both AI review entities.
--
-- This migration changes no booking, identity, availability, or approval data.
-- It adds the missing intake notification and makes the existing provisional
-- booking notification point at the intake row that staff can actually review.

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
    v_link := '/patients?review=1&intake=' || new.intake_id::text || '#ai-intakes';
    v_source := 'ai_appointment_request';
  else
    return new;
  end if;

  insert into public.notifications (
    clinic_id, recipient_id, type, link, data, dedupe_key
  )
  select
    new.clinic_id,
    p.id,
    'ai_booking_request',
    v_link,
    jsonb_build_object('source', v_source, 'recordId', new.id::text),
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

revoke all on function public.notify_staff_of_ai_booking_commit()
  from public, anon, authenticated;

create or replace function public.notify_staff_of_ai_intake_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (
    clinic_id, recipient_id, type, link, data, dedupe_key
  )
  select
    new.clinic_id,
    p.id,
    'ai_patient_intake',
    '/patients?review=1&intake=' || new.id::text || '#ai-intakes',
    jsonb_build_object('source', 'ai_patient_intake', 'recordId', new.id::text),
    'ai_patient_intake|' || new.id::text
  from public.profiles p
  where p.clinic_id = new.clinic_id
    and p.role in (
      'admin'::public.user_role,
      'manager'::public.user_role,
      'receptionist'::public.user_role
    )
    and p.is_active
    and not p.is_deleted
    and p.deleted_at is null
  on conflict (recipient_id, dedupe_key) where read_at is null do nothing;

  return new;
end;
$$;

revoke all on function public.notify_staff_of_ai_intake_commit()
  from public, anon, authenticated;

drop trigger if exists trg_notify_staff_ai_patient_intake on public.ai_patient_intakes;
create trigger trg_notify_staff_ai_patient_intake
after insert on public.ai_patient_intakes
for each row
when (new.review_status = 'pending_review')
execute function public.notify_staff_of_ai_intake_commit();

comment on function public.notify_staff_of_ai_intake_commit() is
  'P11J notifies active intake reviewers after a new AI patient intake is durably staged, with an exact review-row link.';

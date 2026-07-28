-- P5A review fixes: preserve the confirmed P4.11 server booking path while
-- keeping the complete AI provenance pair and expiry metadata server-owned.

create or replace function public.protect_ai_booking_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ai_patient_conversation_id is not null
       or new.ai_workflow_run_id is not null
       or new.ai_workflow_step_id is not null
       or new.expires_at is not null then
      raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
    end if;
  elsif old.ai_patient_conversation_id is distinct from new.ai_patient_conversation_id
     or old.ai_workflow_run_id is distinct from new.ai_workflow_run_id
     or old.ai_workflow_step_id is distinct from new.ai_workflow_step_id
     or old.expires_at is distinct from new.expires_at then
    raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appointments_guard_ai_metadata
  on public.appointments;
create trigger trg_appointments_guard_ai_metadata
  before insert or update of
    ai_patient_conversation_id,
    ai_workflow_run_id,
    ai_workflow_step_id,
    expires_at
  on public.appointments
  for each row execute function public.protect_ai_booking_metadata();

revoke all on function public.protect_ai_booking_metadata()
  from public, anon, authenticated, service_role;

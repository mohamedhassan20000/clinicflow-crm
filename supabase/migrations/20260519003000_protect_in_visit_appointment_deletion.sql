create or replace function public.enforce_appointment_delete_restrictions()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('clinic_crm.allow_appointment_delete_replacement', true), '') = 'on' then
    return old;
  end if;

  if old.status in (
    'arrived'::public.appointment_status,
    'in_session'::public.appointment_status,
    'completed'::public.appointment_status
  ) then
    raise exception 'Appointments with status % cannot be deleted. Undo or cancel the appointment first.', old.status
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

create or replace function public.enforce_appointment_soft_delete_restrictions()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('clinic_crm.allow_appointment_delete_replacement', true), '') = 'on' then
    return new;
  end if;

  if old.deleted_at is null
    and new.deleted_at is not null
    and old.status in (
      'arrived'::public.appointment_status,
      'in_session'::public.appointment_status,
      'completed'::public.appointment_status
    )
  then
    raise exception 'Appointments with status % cannot be deleted. Undo or cancel the appointment first.', old.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_appointments_restrict_delete_by_status on public.appointments;
create trigger trg_appointments_restrict_delete_by_status
before delete on public.appointments
for each row
execute function public.enforce_appointment_delete_restrictions();

drop trigger if exists trg_appointments_restrict_soft_delete_by_status on public.appointments;
create trigger trg_appointments_restrict_soft_delete_by_status
before update of deleted_at on public.appointments
for each row
execute function public.enforce_appointment_soft_delete_restrictions();

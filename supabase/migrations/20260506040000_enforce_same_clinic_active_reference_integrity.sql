-- Phase 5F: same-clinic and active reference guards for appointments.
-- This migration is intentionally not applied automatically.

create or replace function public.enforce_appointment_reference_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.patient_id is distinct from old.patient_id then
    if not exists (
      select 1
      from public.patients p
      where p.id = new.patient_id
        and p.clinic_id = new.clinic_id
        and p.is_deleted = false
    ) then
      raise exception 'Appointment patient must belong to the same clinic and be active'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' or new.doctor_id is distinct from old.doctor_id then
    if not exists (
      select 1
      from public.profiles d
      where d.id = new.doctor_id
        and d.clinic_id = new.clinic_id
        and d.role = 'doctor'::public.user_role
        and d.is_active = true
        and d.is_deleted = false
        and d.deleted_at is null
    ) then
      raise exception 'Appointment doctor must belong to the same clinic and be an active doctor'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' or new.department_id is distinct from old.department_id then
    if new.department_id is not null
      and not exists (
        select 1
        from public.departments d
        where d.id = new.department_id
          and d.clinic_id = new.clinic_id
          and d.is_active = true
          and d.deleted_at is null
      )
    then
      raise exception 'Appointment department must belong to the same clinic and be active'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT'
    or new.insurance_provider_id is distinct from old.insurance_provider_id
  then
    if new.insurance_provider_id is not null
      and not exists (
        select 1
        from public.insurance_providers ip
        where ip.id = new.insurance_provider_id
          and ip.clinic_id = new.clinic_id
          and ip.is_active = true
          and ip.deleted_at is null
      )
    then
      raise exception 'Appointment insurance provider must belong to the same clinic and be active'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_appointment_reference_integrity
  on public.appointments;

create trigger enforce_appointment_reference_integrity
before insert or update on public.appointments
for each row
execute function public.enforce_appointment_reference_integrity();

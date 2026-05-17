create table if not exists public.patient_packages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  total_sessions integer not null check (total_sessions > 0),
  used_sessions integer not null default 0 check (used_sessions >= 0),
  price_per_session numeric(12,2) check (price_per_session >= 0),
  notes text check (char_length(notes) <= 500),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_packages_used_le_total check (used_sessions <= total_sessions)
);

create index if not exists idx_patient_packages_patient
  on public.patient_packages (patient_id);

create index if not exists idx_patient_packages_clinic
  on public.patient_packages (clinic_id);

drop trigger if exists trg_patient_packages_updated_at on public.patient_packages;
create trigger trg_patient_packages_updated_at
before update on public.patient_packages
for each row
execute function public.set_updated_at();

drop trigger if exists trg_audit_patient_packages on public.patient_packages;
create trigger trg_audit_patient_packages
after insert or delete or update on public.patient_packages
for each row
execute function public.write_audit_log();

alter table public.appointments
  add column if not exists package_id uuid references public.patient_packages(id) on delete set null,
  add column if not exists package_session_number integer check (package_session_number > 0);

create index if not exists idx_appointments_package_id
  on public.appointments (package_id)
  where package_id is not null;

create or replace function public.enforce_appointment_package_integrity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.package_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not exists (
      select 1
      from public.patient_packages pp
      where pp.id = new.package_id
        and pp.clinic_id = new.clinic_id
        and pp.patient_id = new.patient_id
    ) then
      raise exception 'Appointment package must belong to the same clinic and patient'
        using errcode = '23514';
    end if;
  elsif new.package_id is distinct from old.package_id
    or new.patient_id is distinct from old.patient_id
    or new.clinic_id is distinct from old.clinic_id
  then
    if not exists (
      select 1
      from public.patient_packages pp
      where pp.id = new.package_id
        and pp.clinic_id = new.clinic_id
        and pp.patient_id = new.patient_id
    ) then
      raise exception 'Appointment package must belong to the same clinic and patient'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.sync_package_session_on_appt_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_incremented integer;
begin
  if tg_op = 'DELETE' then
    if old.status = 'completed'::public.appointment_status
      and old.package_id is not null
    then
      update public.patient_packages
      set used_sessions = greatest(0, used_sessions - 1)
      where id = old.package_id;
    end if;

    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'completed'::public.appointment_status
      and old.package_id is not null
      and (
        new.status <> 'completed'::public.appointment_status
        or new.package_id is distinct from old.package_id
      )
    then
      update public.patient_packages
      set used_sessions = greatest(0, used_sessions - 1)
      where id = old.package_id;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'completed'::public.appointment_status
      and new.package_id is not null
    then
      update public.patient_packages
      set used_sessions = used_sessions + 1
      where id = new.package_id
        and used_sessions < total_sessions;

      get diagnostics v_incremented = row_count;

      if v_incremented <> 1 then
        raise exception 'Package has no remaining sessions'
          using errcode = '23514';
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'completed'::public.appointment_status
      and new.package_id is not null
      and (
        old.status <> 'completed'::public.appointment_status
        or new.package_id is distinct from old.package_id
      )
    then
      update public.patient_packages
      set used_sessions = used_sessions + 1
      where id = new.package_id
        and used_sessions < total_sessions;

      get diagnostics v_incremented = row_count;

      if v_incremented <> 1 then
        raise exception 'Package has no remaining sessions'
          using errcode = '23514';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_appointment_package_integrity on public.appointments;
create trigger trg_appointment_package_integrity
before insert or update of package_id, patient_id, clinic_id on public.appointments
for each row
execute function public.enforce_appointment_package_integrity();

drop trigger if exists trg_package_session_on_appt_insert on public.appointments;
create trigger trg_package_session_on_appt_insert
after insert on public.appointments
for each row
execute function public.sync_package_session_on_appt_status();

drop trigger if exists trg_package_session_on_appt_status on public.appointments;
create trigger trg_package_session_on_appt_status
after update of status, package_id on public.appointments
for each row
execute function public.sync_package_session_on_appt_status();

drop trigger if exists trg_package_session_on_appt_delete on public.appointments;
create trigger trg_package_session_on_appt_delete
after delete on public.appointments
for each row
execute function public.sync_package_session_on_appt_status();

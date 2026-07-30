-- Appointment availability needs to distinguish an intentionally disabled
-- recurring schedule from an unconfigured doctor, and recurring hours from
-- date-specific leave / blocked periods.

alter table public.doctor_schedules
  add column if not exists is_enabled boolean not null default true,
  add column if not exists valid_from date,
  add column if not exists valid_until date;

alter table public.doctor_schedules
  drop constraint if exists doctor_schedules_valid_range;

alter table public.doctor_schedules
  add constraint doctor_schedules_valid_range
  check (valid_until is null or valid_from is null or valid_until >= valid_from);

create table if not exists public.doctor_unavailability (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null check (kind in ('leave', 'off', 'blocked')),
  note text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint doctor_unavailability_time_order check (ends_at > starts_at)
);

create index if not exists doctor_unavailability_lookup_idx
  on public.doctor_unavailability (clinic_id, doctor_id, starts_at, ends_at)
  where is_active;

alter table public.doctor_unavailability enable row level security;

drop policy if exists doctor_unavailability_select on public.doctor_unavailability;
create policy doctor_unavailability_select
  on public.doctor_unavailability
  for select to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and (
      public.auth_role() in (
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role
      )
      or doctor_id = auth.uid()
      or (
        public.auth_role() = 'assistant'::public.user_role
        and doctor_id = any (public.auth_supervised_doctor_ids())
      )
    )
  );

drop policy if exists doctor_unavailability_write_admin on public.doctor_unavailability;
create policy doctor_unavailability_write_admin
  on public.doctor_unavailability
  for all to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

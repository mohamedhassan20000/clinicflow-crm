-- Phase 1: many-to-many assistant -> supervising doctor assignments.
--
-- An assistant's authorized data scope is the UNION of the assigned doctors'
-- own scopes only (never department-wide, never clinic-wide). Assignments drive
-- DATA SCOPE exclusively; they never affect page/report visibility defaults or a
-- user's stored customizations (those are owned by the Customize layer).

create table if not exists public.assistant_doctor_assignments (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  assistant_id uuid not null references public.profiles(id) on delete cascade,
  doctor_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  primary key (assistant_id, doctor_id)
);

create index if not exists assistant_doctor_assignments_clinic_idx
  on public.assistant_doctor_assignments (clinic_id);
create index if not exists assistant_doctor_assignments_doctor_idx
  on public.assistant_doctor_assignments (doctor_id);

comment on table public.assistant_doctor_assignments is
  'Assistant-to-doctor supervision links. Data scope only: an assistant may read '
  'the union of its assigned doctors'' own scopes. Never widens visibility.';

-- Request-scoped helper returning the set of active doctor ids the current
-- assistant is assigned to, within their own clinic. SECURITY DEFINER so RLS
-- policies on other tables can call it without recursive policy evaluation.
-- Returns an empty array for non-assistants and unassigned assistants, so a
-- scope test of `col = any(auth_supervised_doctor_ids())` fails closed.
create or replace function public.auth_supervised_doctor_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(a.doctor_id), array[]::uuid[])
  from public.assistant_doctor_assignments a
  join public.profiles d
    on d.id = a.doctor_id
   and d.clinic_id = a.clinic_id
   and d.role = 'doctor'::public.user_role
   and d.is_active = true
   and d.is_deleted = false
   and d.deleted_at is null
  where a.assistant_id = auth.uid()
    and a.clinic_id = public.auth_clinic_id();
$$;
revoke all on function public.auth_supervised_doctor_ids() from public;
grant execute on function public.auth_supervised_doctor_ids() to authenticated;
grant execute on function public.auth_supervised_doctor_ids() to service_role;

alter table public.assistant_doctor_assignments enable row level security;

-- Assistants may read their own assignments (to know their scope); admins and
-- managers manage assignments for their clinic. Writes never happen for the
-- assistant themselves.
drop policy if exists "assistant_reads_own_assignments"
  on public.assistant_doctor_assignments;
create policy "assistant_reads_own_assignments"
  on public.assistant_doctor_assignments
  for select
  to authenticated
  using (
    assistant_id = auth.uid()
    or (
      clinic_id = public.auth_clinic_id()
      and public.auth_role() = any (
        array['admin'::public.user_role, 'manager'::public.user_role]
      )
    )
  );

drop policy if exists "admin_manager_manage_assignments"
  on public.assistant_doctor_assignments;
create policy "admin_manager_manage_assignments"
  on public.assistant_doctor_assignments
  for all
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array['admin'::public.user_role, 'manager'::public.user_role]
    )
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array['admin'::public.user_role, 'manager'::public.user_role]
    )
  );
